const { BrowserWindow, screen, ipcMain } = require("electron");
const path = require("path");
const { captureRegionToJpg } = require("./screenshot");

/** @type {BrowserWindow | null} */
let overlayWin = null;
/** @type {((result: object | null) => void) | null} */
let pendingResolve = null;
let capturing = false;
let selecting = false;
/** @type {Promise<void> | null} */
let readyPromise = null;

function getVirtualBounds() {
  const displays = screen.getAllDisplays();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const d of displays) {
    const b = d.bounds;
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
  }
  return {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
  };
}

function applyVirtualBounds() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  const virtual = getVirtualBounds();
  overlayWin.setBounds(virtual);
  return virtual;
}

/** 不销毁窗口；透明窗上 setOpacity 在 GNOME 常无效，改藏 DOM 蒙版 + 鼠标穿透 */
function hideOverlay() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  try {
    if (!overlayWin.webContents.isDestroyed()) {
      overlayWin.webContents.send("region:idle");
    }
    overlayWin.setIgnoreMouseEvents(true, { forward: true });
    if (typeof overlayWin.blur === "function") {
      overlayWin.blur();
    }
  } catch {
    // ignore
  }
}

function finish(result) {
  const resolve = pendingResolve;
  pendingResolve = null;
  capturing = false;
  selecting = false;
  hideOverlay();
  if (resolve) resolve(result);
}

function ensureIpc() {
  if (ensureIpc.done) return;
  ensureIpc.done = true;

  ipcMain.on("region:complete", (_event, region) => {
    if (!pendingResolve || capturing) return;
    if (
      !region ||
      !Number.isFinite(region.width) ||
      !Number.isFinite(region.height) ||
      region.width < 4 ||
      region.height < 4
    ) {
      finish(null);
      return;
    }

    capturing = true;
    selecting = false;
    // 先藏遮罩（不销毁），再截实时桌面
    hideOverlay();

    void (async () => {
      try {
        await new Promise((r) => setTimeout(r, 40));
        const shot = await captureRegionToJpg(region);
        console.log(
          "[region] captured:",
          shot.path,
          `${shot.width}x${shot.height}`,
        );
        finish(shot);
      } catch (err) {
        console.error("[region] capture failed:", err);
        finish(null);
      }
    })();
  });

  ipcMain.on("region:cancel", () => {
    console.log("[region] cancelled");
    finish(null);
  });

  screen.on("display-metrics-changed", () => {
    if (!selecting) applyVirtualBounds();
  });
  screen.on("display-added", () => {
    if (!selecting) applyVirtualBounds();
  });
  screen.on("display-removed", () => {
    if (!selecting) applyVirtualBounds();
  });
}

/**
 * 启动时预创建并 map 一次（opacity=0），把 GNOME 打开动画消化在启动阶段。
 */
function warmRegionOverlay() {
  ensureIpc();
  void ensureOverlayReady();
}

function ensureOverlayReady() {
  ensureIpc();
  if (overlayWin && !overlayWin.isDestroyed()) {
    return Promise.resolve();
  }
  if (readyPromise) return readyPromise;

  readyPromise = new Promise((resolve) => {
    const virtual = getVirtualBounds();
    /** @type {Electron.BrowserWindowConstructorOptions} */
    const winOpts = {
      x: virtual.x,
      y: virtual.y,
      width: virtual.width,
      height: virtual.height,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      focusable: true,
      show: false,
      alwaysOnTop: true,
      backgroundColor: "#00000000",
      paintWhenInitiallyHidden: true,
      webPreferences: {
        preload: path.join(__dirname, "regionSelectPreload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    };
    // dock 在 Mutter 上通常不做普通窗口打开动画
    if (process.platform === "linux") {
      winOpts.type = "dock";
    }

    overlayWin = new BrowserWindow(winOpts);
    overlayWin.setBounds(virtual);
    overlayWin.setAlwaysOnTop(true, "screen-saver");
    overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    overlayWin.setIgnoreMouseEvents(true, { forward: true });

    overlayWin.on("closed", () => {
      overlayWin = null;
      readyPromise = null;
      if (pendingResolve && !capturing) {
        const r = pendingResolve;
        pendingResolve = null;
        selecting = false;
        r(null);
      }
    });

    const settle = () => {
      if (!overlayWin || overlayWin.isDestroyed()) {
        resolve();
        return;
      }
      // 首次 map：页面默认 idle（无蒙版），不依赖 setOpacity
      overlayWin.show();
      hideOverlay();
      resolve();
    };

    overlayWin.webContents.once("did-finish-load", settle);
    overlayWin.loadFile(path.join(__dirname, "regionSelect.html"));
  });

  return readyPromise;
}

/**
 * 不冻结桌面：半透明遮罩框选 → 隐藏遮罩 → 实时截取选区。
 * @returns {Promise<{ path: string, filename: string, width: number, height: number } | null>}
 */
async function selectRegionScreenshot() {
  if (pendingResolve || selecting || capturing) {
    console.warn("[region] already selecting");
    return null;
  }

  await ensureOverlayReady();
  if (!overlayWin || overlayWin.isDestroyed()) {
    return null;
  }

  const virtual = applyVirtualBounds() || getVirtualBounds();

  return new Promise((resolve) => {
    pendingResolve = resolve;
    capturing = false;
    selecting = true;

    // 窗口早已 map：只打开 DOM 蒙版，避免 GNOME 打开动画 / setOpacity 失效变暗
    overlayWin.setIgnoreMouseEvents(false);
    overlayWin.show();
    overlayWin.focus();
    overlayWin.webContents.send("region:init", {
      virtualOrigin: { x: virtual.x, y: virtual.y },
    });
  });
}

function isRegionSelectOpen() {
  return selecting || capturing;
}

function disposeRegionOverlay() {
  pendingResolve = null;
  selecting = false;
  capturing = false;
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.removeAllListeners("closed");
    overlayWin.close();
  }
  overlayWin = null;
  readyPromise = null;
}

module.exports = {
  selectRegionScreenshot,
  isRegionSelectOpen,
  warmRegionOverlay,
  disposeRegionOverlay,
};
