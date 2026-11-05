const {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  Tray,
  Menu,
  nativeImage,
  dialog,
  powerMonitor,
} = require("electron");
const path = require("path");
const { loadConfig, startConfigWatcher, stopConfigWatcher, subscribeConfig } = require("./config");
const { getMenuContributions, setMenuRefreshHandler } = require("./menuHooks");
const { createAvatarHost } = require("./architecture/avatar");
const { avatarWindowSize } = require("./architecture/avatarViewport");
const avatarPluginNames = new Set(require("./plugins/manifest").filter(item => item.kind === "avatar").map(item => item.name));
const { MessageBus } = require("./architecture/messageBus");
const EVENTS = require("./architecture/events");
const { createPluginHost } = require("./pluginHost");
const { createPerceptionService } = require("./architecture/perceptionService");
const { createConversation } = require("./conversation");
const { isDeepStrictEqual } = require("node:util");
const { createDecisionScheduler } = require("./architecture/decisionScheduler");
const { createServiceRegistry } = require("./architecture/serviceRegistry");
const { createContextProviders } = require("./architecture/contextProviders");
const { createPromptExtensions } = require("./architecture/promptExtensions");
const { createStorage } = require("./storage");
const { captureFullscreenToJpg } = require("./platform/screenCapture");
const { registerDecisionModule } = require("./modules/decision");
const { createExecutionModule } = require("./modules/execution");
const {
  startX11Cursor,
  getPhysicalCursorPoint,
  isX11CursorReady,
} = require("./x11Cursor");

const isDev = !app.isPackaged;
const SCREEN_MARGIN = 16;
const DEFAULT_WIN = { width: 380, height: 560 };

let winSize = { ...DEFAULT_WIN };
let tray = null;
let trayRefreshTimer = null;
let mainWindow = null;
let pointerTrackingTimer = null;
let shuttingDown = false;
let shutdownComplete = false;
let shutdownTask = null;
let unsubscribeConfig = null;
let runtimeUpdates = Promise.resolve();

function readWindowSize() {
  try {
    const ui = loadConfig().ui || {};
    const display = mainWindow && !mainWindow.isDestroyed()
      ? screen.getDisplayMatching(mainWindow.getBounds()) : screen.getPrimaryDisplay();
    winSize = avatarWindowSize(ui, avatar.getSnapshot().avatar?.renderer, display.workArea);
  } catch {
    winSize = { ...DEFAULT_WIN };
  }
  return winSize;
}

// 防止小窗在未聚焦时被 Chromium 降帧（表现为「只有拖动才有动画」）
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch(
  "disable-features",
  "CalculateNativeWinOcclusion",
);

// Windows 透明窗需要关硬件加速，否则容易整窗不绘制
if (process.platform === "win32") {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("enable-transparent-visuals");
}

function placeBottomRight(win) {
  const { width, height } = winSize;
  const { workArea } = screen.getPrimaryDisplay();
  win.setBounds({
    x: Math.round(workArea.x + workArea.width - width - SCREEN_MARGIN),
    y: Math.round(workArea.y + workArea.height - height - SCREEN_MARGIN),
    width,
    height,
  });
}

function getCursorDipPoint() {
  // Linux/X11：勿用 getCursorScreenPoint（离开窗口后坐标会冻结）
  if (isX11CursorReady()) {
    const physical = getPhysicalCursorPoint();
    if (physical) {
      if (typeof screen.screenToDipPoint === "function") {
        return screen.screenToDipPoint(physical);
      }
      const display = screen.getDisplayNearestPoint(physical);
      const scale = display.scaleFactor || 1;
      return {
        x: physical.x / scale,
        y: physical.y / scale,
      };
    }
  }
  return screen.getCursorScreenPoint();
}

function getPointerPayload(win) {
  const cursor = getCursorDipPoint();
  const bounds = win.getContentBounds();
  const zoom = win.webContents.getZoomFactor();
  return {
    x: (cursor.x - bounds.x) / zoom,
    y: (cursor.y - bounds.y) / zoom,
  };
}

function startPointerTracking(win) {
  if (pointerTrackingTimer) clearInterval(pointerTrackingTimer);
  let lastX = NaN;
  let lastY = NaN;
  const sendPosition = () => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return;
    const position = getPointerPayload(win);
    if (position.x === lastX && position.y === lastY) return;
    lastX = position.x;
    lastY = position.y;
    win.webContents.send("pet:global-pointer", position);
  };
  sendPosition();
  pointerTrackingTimer = setInterval(sendPosition, 1000 / 60);
}

function sendBubble(payload) {
  if (shuttingDown || !mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("pet:bubble", payload);
}

const avatar = createAvatarHost({
  onChange: snapshot => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      if (snapshot.avatar) {
        const previous = mainWindow.getBounds();
        const size = readWindowSize();
        const area = screen.getDisplayMatching(previous).workArea;
        mainWindow.setMinimumSize(1, 1);
        mainWindow.setMaximumSize(Math.max(previous.width, size.width), Math.max(previous.height, size.height));
        mainWindow.setBounds({ ...size,
          x: Math.max(area.x, Math.min(previous.x + previous.width - size.width, area.x + area.width - size.width)),
          y: Math.max(area.y, Math.min(previous.y + previous.height - size.height, area.y + area.height - size.height)),
        });
        mainWindow.setMinimumSize(size.width, size.height);
        mainWindow.setMaximumSize(size.width, size.height);
      }
      mainWindow.webContents.send("pet:avatar-changed", snapshot);
    }
    refreshTrayMenu();
    refreshTrayIcon();
  },
  sendCommand: command => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send("pet:avatar-command", command);
    }
  },
});
const messageBus = new MessageBus();
const execution = createExecutionModule(messageBus, { sendBubble });
const perception = createPerceptionService(messageBus, { getPolicy: () => loadConfig().observations || {} });
const services = createServiceRegistry();
const storage = createStorage({ services });
const contextProviders = createContextProviders();
const promptExtensions = createPromptExtensions();
const conversation = createConversation({
  storage: storage.api,
  getConfig: loadConfig, contextProviders, promptExtensions, bus: messageBus,
  getExpressions: avatar.getExpressions,
  onRequest: (entry) => messageBus.notify(EVENTS.AI_REQUEST_STARTED, entry),
  onResult: (entry) => messageBus.notify(EVENTS.AI_REQUEST_FINISHED, entry),
});
registerDecisionModule(messageBus, {
  perception,
  presentDecision: execution.presentDecision,
  decide: (observations, request) => conversation.decideFromObservations(observations, request),
});
const scheduler = createDecisionScheduler({
  execute: (request) => messageBus.publish(EVENTS.DECISION_REQUESTED, request),
  getPolicy: () => loadConfig().decision,
  hasPendingUser: perception.hasPendingUser,
});
const pluginHost = createPluginHost({
  avatar,
  bus: messageBus,
  getConfig: loadConfig,
  perception,
  model: conversation.model,
  requestDecision: (request) => scheduler.request(request),
  services,
  storage,
  contextProviders,
  promptExtensions,
  paths: { getUserData: () => app.getPath("userData"), projectRoot: path.resolve(__dirname, "..") },
  windows: { create: (options) => new BrowserWindow(options) },
  attention: { getIdleSeconds: () => powerMonitor.getSystemIdleTime() },
  dialogs: { showMessageBox: (options) => mainWindow && !mainWindow.isDestroyed()
    ? dialog.showMessageBox(mainWindow, options) : dialog.showMessageBox(options) },
  ipc: {
    handle: (channel, handler) => {
      ipcMain.handle(channel, handler);
      return () => ipcMain.removeHandler(channel);
    },
  },
  screen: {
    captureFullscreen: captureFullscreenToJpg,
    getPrimaryDisplay: () => screen.getPrimaryDisplay(),
    getDisplayNearestPoint: (point) => screen.getDisplayNearestPoint(point),
  },
  pet: {
    getExpressions: avatar.getExpressions,
    getBounds: () => mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()
      ? mainWindow.getBounds() : null,
  },
});

messageBus.subscribe(EVENTS.DECISION_COMPLETED, ({ observations, result }) => {
  console.log(
    `[decision] observations=${observations.length}`,
    `expression=${result.expression}`,
    result.reply,
  );
});

function pinOnTop(win) {
  if (!win || win.isDestroyed()) return;
  // screen-saver 层级高于普通置顶窗，尽量压在其它应用前面
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
}

function createWindow() {
  const { width, height } = readWindowSize();
  const win = new BrowserWindow({
    width,
    height,
    minWidth: width,
    minHeight: height,
    maxWidth: width,
    maxHeight: height,
    useContentSize: true,
    frame: false,
    transparent: true,
    hasShadow: false,
    thickFrame: false,
    roundedCorners: false,
    alwaysOnTop: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  mainWindow = win;
  avatar.resetReady();
  placeBottomRight(win);
  win.setSkipTaskbar(true);
  pinOnTop(win);
  win.webContents.setBackgroundThrottling(false);
  win.webContents.setFrameRate(60);

  win.webContents.on("did-start-loading", () => {
    if (mainWindow !== win) return;
    avatar.resetReady();
    if (tray && !tray.isDestroyed()) tray.setContextMenu(buildAppMenu());
  });

  // 失焦后重新置顶，避免被其它窗口盖住后不再浮到最前
  win.on("blur", () => {
    pinOnTop(win);
  });
  win.on("show", () => {
    win.setSkipTaskbar(true);
    pinOnTop(win);
  });

  win.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL) => {
      console.error(
        "did-fail-load",
        errorCode,
        errorDescription,
        validatedURL,
      );
    },
  );

  win.webContents.on("did-finish-load", () => {
    startPointerTracking(win);
  });

  win.once("ready-to-show", () => {
    placeBottomRight(win);
    win.setSkipTaskbar(true);
    pinOnTop(win);
    win.show();
  });

  if (isDev) {
    win.loadURL("http://127.0.0.1:5173/");
  } else {
    win.loadFile(path.join(__dirname, "../dist/index.html"));
  }

  win.on("closed", () => {
    if (pointerTrackingTimer) {
      clearInterval(pointerTrackingTimer);
      pointerTrackingTimer = null;
    }
    if (mainWindow === win) mainWindow = null;
    avatar.resetReady();
    if (tray && !tray.isDestroyed()) tray.setContextMenu(buildAppMenu());
  });

  return win;
}

function showPetToBottomRight() {
  if (shuttingDown) return;
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  placeBottomRight(mainWindow);
  mainWindow.setSkipTaskbar(true);
  pinOnTop(mainWindow);
  mainWindow.show();
}

function buildAppMenu() {
  const pluginMenuItems = getMenuContributions();
  return Menu.buildFromTemplate([
    {
      label: "显示到右下角",
      click: () => showPetToBottomRight(),
    },
    ...pluginMenuItems,
    {
      label: "退出",
      click: () => app.quit(),
    },
  ]);
}

function refreshTrayMenu() {
  if (trayRefreshTimer) clearTimeout(trayRefreshTimer);
  trayRefreshTimer = setTimeout(() => {
    trayRefreshTimer = null;
    if (tray && !tray.isDestroyed()) tray.setContextMenu(buildAppMenu());
  }, 0);
}

function popupAppMenu(browserWindow, x, y) {
  const menu = buildAppMenu();
  const opts = { window: browserWindow };
  if (Number.isFinite(x) && Number.isFinite(y)) {
    opts.x = Math.round(x);
    opts.y = Math.round(y);
  }
  menu.popup(opts);
}

function trayIcon() {
  const iconPath = avatar.getIconPath();
  return iconPath ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
}
function refreshTrayIcon() {
  if (tray && !tray.isDestroyed()) tray.setImage(trayIcon());
}
function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip("My Live2D Pet");
  tray.setContextMenu(buildAppMenu());
  tray.on("double-click", () => showPetToBottomRight());
}

app.whenReady().then(async () => {
  // 便于 Linux 桌面/portal 识别应用身份
  try {
    app.setName("mylive2dpet");
    if (typeof app.setDesktopName === "function") {
      app.setDesktopName("mylive2dpet.desktop");
    }
  } catch {
    // ignore
  }

  unsubscribeConfig = subscribeConfig((config, previous) => {
    const update = runtimeUpdates.then(async () => {
      if (shuttingDown) return;
      const avatarChanged = !isDeepStrictEqual(
        config.plugins.filter(item => avatarPluginNames.has(item.name)),
        previous.plugins.filter(item => avatarPluginNames.has(item.name)),
      );
      const changed = avatarChanged || !isDeepStrictEqual(config.conversation, previous.conversation);
      const resume = scheduler.getState().running;
      if (changed) await scheduler.stop();
      if (shuttingDown) return;
      if (avatarChanged) {
        await conversation.stop();
        conversation.clearHistory();
      }
      await conversation.reconfigure(config);
      await pluginHost.reload(config);
      if (avatarChanged && !shuttingDown) conversation.start();
      if (changed && resume && !shuttingDown) scheduler.start();
    });
    runtimeUpdates = update.catch(() => {});
    return update;
  });
  startConfigWatcher();
  await pluginHost.activate();
  if (shuttingDown) return;
  startX11Cursor();
  createWindow();
  setMenuRefreshHandler(refreshTrayMenu);
  createTray();
  await pluginHost.start();
  if (shuttingDown) return;
  scheduler.start();

  app.on("activate", () => {
    if (shuttingDown) return;
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      conversation.start();
      void pluginHost.start();
      scheduler.start();
    }
  });
});

app.on("before-quit", (event) => {
  if (shutdownComplete) return;
  event.preventDefault();
  if (shutdownTask) return;
  shuttingDown = true;
  stopConfigWatcher();
  unsubscribeConfig?.();
  unsubscribeConfig = null;
  void scheduler.stop();
  if (pointerTrackingTimer) clearInterval(pointerTrackingTimer);
  pointerTrackingTimer = null;
  if (trayRefreshTimer) clearTimeout(trayRefreshTimer);
  trayRefreshTimer = null;
  setMenuRefreshHandler(null);
  shutdownTask = Promise.all([scheduler.dispose(), conversation.dispose(), pluginHost.dispose(), runtimeUpdates]).then(() =>
    perception.discard(() => true, "shutdown")
  ).catch((error) => {
    console.error("[plugins] shutdown failed:", error);
  }).finally(() => {
    execution.dispose();
    shutdownComplete = true;
    app.quit();
  });
});

// 拖动时固定宽高，避免 Windows DPI 下 setPosition 导致窗口越拖越大
ipcMain.on("pet:move-window", (event, dx, dy) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  const { x, y } = win.getBounds();
  win.setBounds({
    x: Math.round(x + dx),
    y: Math.round(y + dy),
    width: winSize.width,
    height: winSize.height,
  });
});

ipcMain.on("pet:request-global-pointer", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  event.sender.send("pet:global-pointer", getPointerPayload(win));
});

ipcMain.on("pet:force-paint", (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  if (!win.isVisible()) win.show();
  const { x, y } = win.getBounds();
  win.setBounds({
    x,
    y,
    width: winSize.width,
    height: winSize.height,
  });
});

ipcMain.handle("pet:capture-screenshot", async () => {
  return perception.capture("screen", { trigger: "manual-capture", enqueue: false });
});

ipcMain.handle("pet:chat-now", async () => {
  await scheduler.request({ trigger: "click", waitForIdle: false });
  return { ok: true };
});

ipcMain.on("pet:context-menu", (event, pos) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  popupAppMenu(win, pos?.x, pos?.y);
});

ipcMain.handle("pet:avatar-config", event => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
    throw new Error("只允许主窗口读取形象配置");
  }
  return avatar.getSnapshot();
});
ipcMain.on("pet:avatar-ready", (event, revision) => {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) return;
  if (avatar.setReady(revision)) refreshTrayMenu();
});

app.on("window-all-closed", () => {
  if (shuttingDown) return;
  void scheduler.stop();
  void conversation.stop();
  void pluginHost.stop();
  if (process.platform !== "darwin") {
    app.quit();
  }
});
