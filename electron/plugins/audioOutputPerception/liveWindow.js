const path = require("path");

function createLiveWindow({ windows, screen, ipc, menu, logger }) {
  let win = null;
  let disposed = false;
  let state = { status: "disabled", error: "" };
  const entries = [];

  function update() {
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send("audio-output-perception:live-content", { state, entries: [...entries] });
    }
  }

  function setEnabled(enabled) {
    if (disposed) return;
    if (!enabled) {
      if (win && !win.isDestroyed()) win.destroy();
      win = null;
      menu?.refresh();
      return;
    }
    if (win && !win.isDestroyed()) return;
    const { workArea } = screen.getPrimaryDisplay();
    const width = Math.min(360, workArea.width - 32);
    const height = Math.min(260, workArea.height - 32);
    const created = windows.create({
      x: Math.round(workArea.x + workArea.width - width - 16), y: Math.round(workArea.y + 16),
      width, height, title: "设备语音实时内容", frame: false, resizable: false,
      show: false, focusable: false, skipTaskbar: true, alwaysOnTop: true, backgroundColor: "#10131a",
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true, nodeIntegration: false, sandbox: true,
      },
    });
    win = created;
    created.webContents.once("did-finish-load", () => { if (win === created) update(); });
    created.once("ready-to-show", () => {
      if (win === created && !created.isDestroyed()) created.showInactive();
    });
    created.once("closed", () => {
      if (win === created) { win = null; menu?.refresh(); }
    });
    void created.loadFile(path.join(__dirname, "live.html")).catch((error) => {
      logger.error("live audio window failed:", error);
      if (!created.isDestroyed()) created.destroy();
    });
    menu?.refresh();
  }

  const unregisterIpc = ipc?.handle("hide-live-content", (event) => {
    if (disposed || !win || win.isDestroyed() || event.sender !== win.webContents) {
      throw new Error("实时语音窗口已关闭或请求来源无效");
    }
    setEnabled(false);
    return { ok: true };
  }) || (() => {});

  function stop() { setEnabled(false); entries.length = 0; }

  return {
    setEnabled, isEnabled: () => Boolean(win && !win.isDestroyed()),
    setState(next) { state = { ...next }; update(); },
    addTranscript(entry) { entries.push({ ...entry }); if (entries.length > 20) entries.shift(); update(); },
    stop,
    dispose() { if (disposed) return; stop(); disposed = true; unregisterIpc(); },
  };
}

module.exports = { createLiveWindow };
