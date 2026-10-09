const {
  app,
  BrowserWindow,
  ipcMain,
  screen,
  Tray,
  Menu,
  nativeImage,
} = require("electron");
const path = require("path");
const { captureFullscreenToJpg } = require("./screenshot");
const { loadConfig } = require("./config");
const { chatAboutScreen } = require("./openaiChat");
const { speakReply, stopTts } = require("./tts");

const isDev = !app.isPackaged;
const SCREEN_MARGIN = 16;
const DEFAULT_WIN = { width: 380, height: 560 };

let winSize = { ...DEFAULT_WIN };
let tray = null;
let mainWindow = null;
let chatTimer = null;
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

async function runScreenChat(reason = "interval") {
  if (chatBusy) return;
  chatBusy = true;
  clearChatTimer();
  stopTts();
  let lastExpression = null;
  try {
    sendBubble({ type: "thinking" });
    const result = await chatAboutScreen({
      onDelta: ({ response, expression }) => {
        if (expression && expression !== lastExpression) {
          lastExpression = expression;
          sendBubble({ type: "expression", expression });
        }
        if (response) {
          sendBubble({
            type: "stream",
            text: response,
            expression: expression || undefined,
          });
        }
      },
    });
    console.log(
      `[chat:${reason}]`,
      `expression=${result.expression}`,
      result.reply,
    );
    sendBubble({
      type: "say",
      text: result.reply,
      expression: result.expression || "neutral",
    });
    // 台词定稿后再系统 TTS（不阻塞下一轮休息计时）
    void speakReply(result.reply, {
      onState: (state) => {
        sendBubble({ type: "tts", state });
      },
    });
  } catch (err) {
    console.error(`[chat:${reason}] failed:`, err);
    sendBubble({
      type: "error",
      text: err instanceof Error ? err.message : String(err),
    });
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

app.whenReady().then(() => {
  createWindow();
  createTray();
  startChatLoop();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
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
