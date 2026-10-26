const path = require("path");

/** Manual conversation owns its window, input policy and decision requests. */
function createManualInputPlugin(context) {
  let win = null;
  let running = true;
  let disposed = false;
  let disposal = null;
  let controller = new AbortController();
  const requests = new Set();

  function closeWindow() {
    const current = win;
    win = null;
    if (current && !current.isDestroyed()) current.destroy();
  }

  function show() {
    if (disposed || !running) return;
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      return;
    }

    const bounds = context.pet.getBounds() || context.screen.getPrimaryDisplay().workArea;
    const { workArea } = context.screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y });
    const width = Math.min(480, workArea.width - 32);
    const height = Math.min(250, workArea.height - 48);
    const created = context.windows.create({
      width, height, minWidth: Math.min(360, width), minHeight: Math.min(220, height),
      frame: false, resizable: true, minimizable: false, maximizable: false,
      skipTaskbar: true, show: false, alwaysOnTop: true, backgroundColor: "#11131a",
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    win = created;
    const x = Math.max(workArea.x + 16, Math.min(
      bounds.x + Math.round((bounds.width - width) / 2),
      workArea.x + workArea.width - width - 16,
    ));
    const y = Math.max(workArea.y + 16, Math.min(
      bounds.y - height - 12,
      workArea.y + workArea.height - height - 16,
    ));
    created.setPosition(x, y);
    created.once("ready-to-show", () => {
      if (!disposed && running && !created.isDestroyed()) {
        created.show();
        created.focus();
      }
    });
    created.on("closed", () => { if (win === created) win = null; });
    void created.loadFile(path.join(__dirname, "window.html")).catch((error) => {
      if (disposed || !running || created.isDestroyed()) return;
      context.logger.error("input window failed:", error);
      created.destroy();
    });
  }

  function requireSender(event) {
    if (disposed || !running) throw new Error("手动对话插件已停止");
    if (!win || win.isDestroyed() || event.sender !== win.webContents) {
      throw new Error("手动对话窗口已关闭");
    }
  }

  const unregisterSubmit = context.ipc.handle("submit", async (event, rawText) => {
    requireSender(event);
    const text = typeof rawText === "string" ? rawText.trim() : "";
    if (!text) throw new Error("请输入消息内容");
    if (text.length > 4000) throw new Error("消息不能超过 4000 个字符");
    const { signal } = controller;
    await context.perception.submit({
      source: "manual-input", role: "user", trigger: "manual-input",
      content: [{ type: "text", text }],
      metadata: { label: "用户手动输入", modality: "text" },
    });
    // Acknowledge queueing immediately; the shared scheduler waits for an idle turn.
    if (!signal.aborted && !disposed && running) {
      const task = Promise.resolve().then(() => context.decisions.request({ trigger: "manual-input", signal }))
        .catch((error) => {
          if (!signal.aborted) context.logger.error("decision request failed:", error);
        }).finally(() => requests.delete(task));
      requests.add(task);
    }
    return { ok: true };
  });
  const unregisterClose = context.ipc.handle("close", (event) => {
    requireSender(event);
    win.close();
    return { ok: true };
  });
  const unregisterMenu = context.menu.register(() => [{
    label: "手动对话…", enabled: running && !disposed, click: show,
  }]);

  function stop() {
    running = false;
    controller.abort();
    closeWindow();
    context.menu.refresh();
    return Promise.allSettled([...requests]);
  }

  return {
    start() {
      if (disposed || running) return;
      controller = new AbortController();
      running = true;
      context.menu.refresh();
    },
    stop,
    dispose() {
      if (disposal) return disposal;
      disposed = true;
      unregisterSubmit();
      unregisterClose();
      unregisterMenu();
      disposal = stop();
      return disposal;
    },
  };
}

function activate(context) { return createManualInputPlugin(context); }

module.exports = { activate, createManualInputPlugin };
