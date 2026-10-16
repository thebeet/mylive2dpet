/**
 * Linux/X11：Chromium 的 screen.getCursorScreenPoint() 在指针离开窗口后会冻结
 * （Electron #42519）。这里直接 XQueryPointer 读全局坐标（物理像素）。
 * Windows / macOS 不加载 x11。
 */

let client = null;
let root = null;
let ready = false;
let querying = false;
/** @type {{ x: number, y: number } | null} */
let latestPhysical = null;

function canUseX11() {
  if (process.platform !== "linux") return false;
  if (!process.env.DISPLAY) return false;
  return true;
}

function loadX11() {
  try {
    return require("x11");
  } catch (err) {
    console.warn(
      "[cursor] x11 module missing, fallback to Electron API:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

function startX11Cursor() {
  if (!canUseX11() || client) return;

  const x11 = loadX11();
  if (!x11) return;

  x11.createClient((err, display) => {
    if (err || !display) {
      console.warn(
        "[cursor] X11 unavailable, fallback to Electron API:",
        err?.message || "no display",
      );
      return;
    }
    client = display.client;
    root = display.screen[0].root;
    ready = true;
    client.on("error", (e) => {
      console.warn("[cursor] X11 error:", e?.message || e);
      ready = false;
    });
    refresh();
    console.log("[cursor] using X11 XQueryPointer for global mouse position");
  });
}

function refresh() {
  if (!ready || !client || querying) return;
  querying = true;
  client.QueryPointer(root, (err, pointer) => {
    querying = false;
    if (!err && pointer) {
      latestPhysical = { x: pointer.rootX, y: pointer.rootY };
    }
  });
}

/**
 * @returns {{ x: number, y: number } | null} 物理像素；尚未就绪时返回 null
 */
function getPhysicalCursorPoint() {
  refresh();
  return latestPhysical;
}

function isX11CursorReady() {
  return ready && latestPhysical != null;
}

module.exports = {
  startX11Cursor,
  getPhysicalCursorPoint,
  isX11CursorReady,
};
