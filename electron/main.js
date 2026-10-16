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
const { captureFullscreenToJpg } = require("./screenshot");
const { loadConfig } = require("./config");
const { chatAboutScreen } = require("./openaiChat");
const {
  selectRegionScreenshot,
  isRegionSelectOpen,
  warmRegionOverlay,
  disposeRegionOverlay,
} = require("./regionSelect");
const {
  isTtsEnabled,
  prepareReplyAudio,
  playPreparedAudio,
  stopTts,
} = require("./plugins/tts");
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
let chatTimer = null;
let pointerTrackingTimer = null;
let chatBusy = false;
let chatLoopEnabled = false;
let chatIntervalMs = 10000;

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

function clearChatTimer() {
  if (chatTimer) {
    clearTimeout(chatTimer);
    chatTimer = null;
  }
}

/** 本次聊天结束后，休息 interval_ms 再发起下一次（interval_ms < 0 时不自动续跑） */
function scheduleNextChat() {
  clearChatTimer();
  if (!chatLoopEnabled || chatIntervalMs < 0) return;
  const wait = Math.max(0, chatIntervalMs);
  console.log(`[chat] rest ${wait}ms before next request`);
  chatTimer = setTimeout(() => {
    void runScreenChat("interval");
  }, wait);
}

/**
 * @param {string} [reason]
 * @param {{ imagePath?: string }} [opts]
 */
async function runScreenChat(reason = "interval", opts = {}) {
  if (chatBusy) return;
  chatBusy = true;
  clearChatTimer();
  let screenshotOk = false;
  try {
    const result = await chatAboutScreen({
      trigger: reason,
      imagePath: opts.imagePath,
      afterScreenshot: () => {
        screenshotOk = true;
        stopTts();
        sendBubble({ type: "thinking" });
      },
    });
    if (result.skipped) {
      console.log(
        `[chat:${reason}] skipped: screen almost unchanged`,
        `hamming=${result.distance}/${result.threshold}`,
      );
      return;
    }
    console.log(
      `[chat:${reason}]`,
      `expression=${result.expression}`,
      `hamming=${result.distance}`,
      result.reply,
    );

    // 拿到台词立刻出气泡；TTS 异步准备，不挡住头顶显示
    sendBubble({
      type: "say",
      text: result.reply,
      expression: result.expression || "neutral",
    });

    if (isTtsEnabled()) {
      void prepareReplyAudio(result.reply)
        .then((prepared) =>
          playPreparedAudio(prepared, {
            onState: (state) => {
              sendBubble({ type: "tts", state });
            },
          }),
        )
        .catch((err) => {
          console.error(
            "[tts] prepare/play failed:",
            err instanceof Error ? err.message : err,
          );
        });
    }
  } catch (err) {
    console.error(`[chat:${reason}] failed:`, err);
    // 截图都没成功时不往头顶丢错误气泡
    if (screenshotOk) {
      sendBubble({
        type: "error",
        text: err instanceof Error ? err.message : String(err),
      });
    }
  } finally {
    chatBusy = false;
    scheduleNextChat();
  }
}

function startChatLoop() {
  clearChatTimer();

  try {
    const config = loadConfig();
    const raw = Number(config.chat?.interval_ms);
    chatIntervalMs = Number.isFinite(raw) ? raw : 10000;
    // interval_ms < 0：关闭自动循环，仅手动点击桌宠 / 托盘触发
    chatLoopEnabled =
      config.chat?.enabled !== false && chatIntervalMs >= 0;
  } catch (err) {
    console.error("load config failed:", err);
    chatIntervalMs = 10000;
    chatLoopEnabled = true;
  }

  if (chatIntervalMs < 0) {
    console.log(
      "[chat] manual-only mode (interval_ms < 0): click pet or tray to chat",
    );
    return;
  }

  if (!chatLoopEnabled) {
    console.log("chat loop disabled by config");
    return;
  }

  // 模型加载需要时间，首轮稍晚再跑；之后每次都是「结束后再休息 interval_ms」
  console.log(
    `[chat] first request in 8000ms, then rest ${chatIntervalMs}ms after each reply`,
  );
  chatTimer = setTimeout(() => {
    void runScreenChat("startup");
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

function buildAppMenu() {
  return Menu.buildFromTemplate([
    {
      label: "显示到右下角",
      click: () => showPetToBottomRight(),
    },
    {
      label: "截取全屏",
      click: async () => {
        try {
          const result = await captureFullscreenToJpg();
          console.log("screenshot saved:", result.path);
        } catch (err) {
          console.error("screenshot failed:", err);
        }
      },
    },
    {
      label: `框选截图并提问 (${regionShortcutAccelerator()})`,
      click: () => {
        void runRegionCaptureChat();
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

async function waitUntilChatIdle(timeoutMs = 120000) {
  const start = Date.now();
  while (chatBusy) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("等待当前聊天结束超时");
    }
    await sleep(100);
  }
}

async function runRegionCaptureChat() {
  if (isRegionSelectOpen()) {
    console.log("[region] selector already open");
    return;
  }

  // 框选不依赖窗口焦点；聊天进行中也允许先框选，截完再等空闲送模
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
    if (chatBusy) {
      console.log("[region] chat busy, wait then send");
      await waitUntilChatIdle();
    }
    await runScreenChat("region", { imagePath: shot.path });
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
    void runRegionCaptureChat();
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
  startChatLoop();
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
    }
  });
});

app.on("will-quit", () => {
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
  return captureFullscreenToJpg();
});

ipcMain.handle("pet:chat-now", async () => {
  console.log("[chat] pet:chat-now received, busy=", chatBusy);
  await runScreenChat("click");
  return { ok: true };
});

ipcMain.on("pet:context-menu", (event, pos) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  popupAppMenu(win, pos?.x, pos?.y);
});

app.on("window-all-closed", () => {
  chatLoopEnabled = false;
  clearChatTimer();
  if (process.platform !== "darwin") {
    app.quit();
  }
});
