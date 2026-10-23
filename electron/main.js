const {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  Tray,
  Menu,
  nativeImage,
  globalShortcut,
} = require("electron");
const path = require("path");
const { loadConfig } = require("./config");
const dialogueHistory = require("./dialogueHistory");
const { MessageBus } = require("./architecture/messageBus");
const EVENTS = require("./architecture/events");
const {
  registerPerceptionModule,
  captureScreenshot,
} = require("./modules/perception");
const { registerDecisionModule } = require("./modules/decision");
const { registerExecutionModule } = require("./modules/execution");
const {
  selectRegionScreenshot,
  isRegionSelectOpen,
  warmRegionOverlay,
  disposeRegionOverlay,
} = require("./regionSelect");
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
let mainWindow = null;
let historyWindow = null;
let decisionTimer = null;
let perceptionTimer = null;
let pointerTrackingTimer = null;
let decisionBusy = false;
let decisionLoopEnabled = false;
let decisionIntervalMs = 10000;
let perceptionLoopEnabled = false;
let perceptionIntervalMs = 5000;
let perceptionCaptureBusy = false;

function readWindowSize() {
  try {
    const ui = loadConfig().ui || {};
    const width = Number(ui.windowWidth) || DEFAULT_WIN.width;
    const height = Number(ui.windowHeight) || DEFAULT_WIN.height;
    winSize = {
      width: Math.max(280, Math.round(width)),
      height: Math.max(420, Math.round(height)),
    };
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
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("pet:bubble", payload);
}

const messageBus = new MessageBus();
registerPerceptionModule(messageBus);
registerDecisionModule(messageBus);
registerExecutionModule(messageBus, { sendBubble });

messageBus.subscribe(EVENTS.PERCEPTION_SKIPPED, (event) => {
  console.log(
    `[perception:${event.trigger}] screenshot skipped: little change`,
    `hamming=${event.distance}/${event.threshold}`,
  );
});
messageBus.subscribe(EVENTS.PERCEPTION_OBSERVATION_QUEUED, (event) => {
  console.log(
    `[perception:${event.observation.trigger}] screenshot queued`,
    `pending=${event.pendingCount}`,
  );
});
messageBus.subscribe(EVENTS.DECISION_COMPLETED, ({ observations, result }) => {
  console.log(
    `[decision] observations=${observations.length}`,
    `expression=${result.expression}`,
    result.reply,
  );
});

function clearDecisionTimer() {
  if (decisionTimer) {
    clearTimeout(decisionTimer);
    decisionTimer = null;
  }
}

/** 决策结束后等待 interval_ms 再请求下一次决策（负数时仅手动触发）。 */
function scheduleNextDecision() {
  clearDecisionTimer();
  if (!decisionLoopEnabled || decisionIntervalMs < 0) return;
  // A zero interval means near-immediate decisions, with a small idle backoff
  // when the observation queue is empty.
  const wait = Math.max(1000, decisionIntervalMs);
  console.log(`[decision] rest ${wait}ms before next request`);
  decisionTimer = setTimeout(() => {
    void requestDecision("interval");
  }, wait);
}

/**
 * @param {string} [reason]
 */
async function requestDecision(reason = "interval") {
  if (decisionBusy) return;
  decisionBusy = true;
  clearDecisionTimer();
  try {
    await messageBus.publish(EVENTS.DECISION_REQUESTED, {
      trigger: reason,
    });
  } catch (err) {
    console.error(`[decision:${reason}] message pipeline failed:`, err);
  } finally {
    decisionBusy = false;
    scheduleNextDecision();
  }
}

async function capturePeriodicScreenshot() {
  if (!perceptionLoopEnabled || perceptionCaptureBusy) return;
  perceptionCaptureBusy = true;
  try {
    await messageBus.publish(EVENTS.SCREENSHOT_CAPTURE_REQUESTED, {
      trigger: "interval",
    });
  } catch (err) {
    console.error("[perception] scheduled capture failed:", err);
  } finally {
    perceptionCaptureBusy = false;
  }
}

function startPerceptionLoop() {
  if (perceptionTimer) clearInterval(perceptionTimer);

  try {
    const config = loadConfig();
    const perception = config.perception || {};
    const raw = Number(perception.interval_ms);
    perceptionIntervalMs = Number.isFinite(raw) ? raw : 5000;
    perceptionLoopEnabled =
      perception.enabled ?? config.chat?.enabled !== false;
  } catch (err) {
    console.error("load perception config failed:", err);
    perceptionIntervalMs = 5000;
    perceptionLoopEnabled = true;
  }

  if (!perceptionLoopEnabled || perceptionIntervalMs <= 0) {
    console.log("perception screenshot loop disabled");
    return;
  }

  console.log(
    `[perception] capture every ${perceptionIntervalMs}ms; queued images are consumed by decisions`,
  );
  void capturePeriodicScreenshot();
  perceptionTimer = setInterval(
    () => void capturePeriodicScreenshot(),
    perceptionIntervalMs,
  );
}

function startDecisionLoop() {
  clearDecisionTimer();

  try {
    const config = loadConfig();
    const raw = Number(config.chat?.interval_ms);
    decisionIntervalMs = Number.isFinite(raw) ? raw : 10000;
    // interval_ms < 0：关闭自动决策，仅手动点击桌宠 / 托盘触发
    decisionLoopEnabled =
      config.chat?.enabled !== false && decisionIntervalMs >= 0;
  } catch (err) {
    console.error("load config failed:", err);
    decisionIntervalMs = 10000;
    decisionLoopEnabled = true;
  }

  if (decisionIntervalMs < 0) {
    console.log(
      "[decision] manual-only mode (interval_ms < 0): click pet or tray to decide",
    );
    return;
  }

  if (!decisionLoopEnabled) {
    console.log("automatic decision loop disabled by config");
    return;
  }

  // 模型加载需要时间，首轮稍晚再跑；之后每次都是「结束后再休息 interval_ms」
  console.log(
    `[decision] first request in 8000ms, then rest ${decisionIntervalMs}ms after each result`,
  );
  decisionTimer = setTimeout(() => {
    void requestDecision("startup");
  }, 8000);
}

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
  placeBottomRight(win);
  win.setSkipTaskbar(true);
  pinOnTop(win);
  win.webContents.setBackgroundThrottling(false);
  win.webContents.setFrameRate(60);

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
  });

  return win;
}

function showPetToBottomRight() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  placeBottomRight(mainWindow);
  mainWindow.setSkipTaskbar(true);
  pinOnTop(mainWindow);
  mainWindow.show();
}

function showDialogueHistory() {
  if (historyWindow && !historyWindow.isDestroyed()) {
    if (historyWindow.isMinimized()) historyWindow.restore();
    historyWindow.show();
    historyWindow.focus();
    return;
  }

  const win = new BrowserWindow({
    width: 560,
    height: 720,
    minWidth: 420,
    minHeight: 480,
    title: "桌宠历史对话",
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#10131a",
    webPreferences: {
      preload: path.join(__dirname, "historyPreload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  historyWindow = win;

  win.once("ready-to-show", () => {
    if (!win.isDestroyed()) win.show();
  });
  win.on("closed", () => {
    if (historyWindow === win) historyWindow = null;
  });
  void win.loadFile(path.join(__dirname, "historyWindow.html"));
}

function buildAppMenu() {
  return Menu.buildFromTemplate([
    {
      label: "显示到右下角",
      click: () => showPetToBottomRight(),
    },
    {
      label: "历史对话",
      click: () => showDialogueHistory(),
    },
    {
      label: "截取全屏",
      click: async () => {
        try {
          const result = await captureScreenshot();
          console.log("screenshot saved:", result.path);
        } catch (err) {
          console.error("screenshot failed:", err);
        }
      },
    },
    {
      label: `框选截图并提问 (${regionShortcutAccelerator()})`,
      click: () => {
        void runRegionCaptureDecision();
      },
    },
    {
      label: "退出",
      click: () => app.quit(),
    },
  ]);
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

function createTray() {
  const iconPath = path.join(
    __dirname,
    "../assets/Setsuna_v081l_b/icon.png",
  );
  const icon = nativeImage.createFromPath(iconPath);
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip("My Live2D Pet");
  tray.setContextMenu(buildAppMenu());
  tray.on("double-click", () => showPetToBottomRight());
}

function regionShortcutAccelerator() {
  // Win/Linux: Ctrl+Alt+Q；macOS: Ctrl+Cmd+Q
  return process.platform === "darwin"
    ? "Control+Command+Q"
    : "Control+Alt+Q";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntilDecisionIdle(timeoutMs = 120000) {
  const start = Date.now();
  while (decisionBusy) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("等待当前决策结束超时");
    }
    await sleep(100);
  }
}

async function runRegionCaptureDecision() {
  if (isRegionSelectOpen()) {
    console.log("[region] selector already open");
    return;
  }

  // 框选不依赖窗口焦点；决策进行中也允许先入队，完成后再请求决策
  const petWasVisible = Boolean(
    mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible(),
  );
  let shot = null;
  try {
    if (petWasVisible) mainWindow.hide();
    shot = await selectRegionScreenshot();
  } catch (err) {
    console.error("[region] failed:", err);
    shot = null;
  } finally {
    if (petWasVisible && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      pinOnTop(mainWindow);
    }
  }

  if (!shot) {
    console.log("[region] no selection");
    return;
  }

  try {
    await messageBus.publish(EVENTS.SCREENSHOT_CAPTURE_REQUESTED, {
      trigger: "region",
      imagePath: shot.path,
    });
    if (decisionBusy) {
      console.log("[region] decision busy, wait then request decision");
      await waitUntilDecisionIdle();
    }
    await requestDecision("region");
  } catch (err) {
    console.error("[region] send failed:", err);
  }
}

/** 向操作系统注册全局热键（无焦点也生效） */
function registerGlobalShortcuts() {
  const accelerator = regionShortcutAccelerator();

  try {
    if (globalShortcut.isRegistered(accelerator)) {
      globalShortcut.unregister(accelerator);
    }
  } catch {
    // ignore
  }

  const ok = globalShortcut.register(accelerator, () => {
    console.log(`[shortcut] global fired: ${accelerator}`);
    void runRegionCaptureDecision();
  });
  const registered = globalShortcut.isRegistered(accelerator);

  if (!ok || !registered) {
    console.error(
      `[shortcut] OS global register failed: ${accelerator} (ok=${ok}, isRegistered=${registered}). 可能被其它程序占用。`,
    );
    return false;
  }

  console.log(
    `[shortcut] OS global registered: ${accelerator} (works without app focus)`,
  );
  return true;
}

app.whenReady().then(() => {
  // 便于 Linux 桌面/portal 识别应用身份
  try {
    app.setName("mylive2dpet");
    if (typeof app.setDesktopName === "function") {
      app.setDesktopName("mylive2dpet.desktop");
    }
  } catch {
    // ignore
  }

  startX11Cursor();
  createWindow();
  createTray();
  startPerceptionLoop();
  startDecisionLoop();
  registerGlobalShortcuts();
  // 预创建框选层，把 GNOME 窗口打开动画消耗在启动阶段
  warmRegionOverlay();

  // 失焦后偶发丢绑定，重新确认一次
  app.on("browser-window-blur", () => {
    const accelerator = regionShortcutAccelerator();
    if (!globalShortcut.isRegistered(accelerator)) {
      console.warn("[shortcut] lost registration, re-register");
      registerGlobalShortcuts();
    }
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      startPerceptionLoop();
      startDecisionLoop();
    }
  });
});

app.on("will-quit", () => {
  if (perceptionTimer) clearInterval(perceptionTimer);
  clearDecisionTimer();
  globalShortcut.unregisterAll();
  disposeRegionOverlay();
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
  return captureScreenshot();
});

ipcMain.handle("pet:chat-now", async () => {
  console.log("[decision] pet:chat-now received, busy=", decisionBusy);
  await requestDecision("click");
  return { ok: true };
});

ipcMain.handle("pet:get-dialogue-history", async () => {
  return dialogueHistory.list(500);
});

ipcMain.on("pet:context-menu", (event, pos) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  popupAppMenu(win, pos?.x, pos?.y);
});

app.on("window-all-closed", () => {
  decisionLoopEnabled = false;
  clearDecisionTimer();
  perceptionLoopEnabled = false;
  if (perceptionTimer) {
    clearInterval(perceptionTimer);
    perceptionTimer = null;
  }
  if (process.platform !== "darwin") {
    app.quit();
  }
});
