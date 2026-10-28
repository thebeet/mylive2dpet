const path = require("path");
const EVENTS = require("../../architecture/events");
const { createRawLogRepository } = require("./repository");

function activate(context) {
  const repository = createRawLogRepository(context.services.get("storage-sqlite.database"));
  let win = null;
  let running = true;
  let disposed = false;

  function close() {
    if (win && !win.isDestroyed()) win.destroy();
    win = null;
  }

  function show() {
    if (!running || disposed) return;
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show(); win.focus(); return;
    }
    const created = context.windows.create({
      width: 1040, height: 780, minWidth: 680, minHeight: 480,
      title: "OpenAI 原始日志", show: false, autoHideMenuBar: true, backgroundColor: "#10131a",
      webPreferences: { preload: path.join(__dirname, "preload.js"),
        contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win = created;
    created.once("ready-to-show", () => {
      if (running && !disposed && win === created && !created.isDestroyed()) created.show();
    });
    created.once("closed", () => { if (win === created) win = null; });
    void created.loadFile(path.join(__dirname, "window.html")).catch((error) => {
      context.logger.error("raw log window failed:", error);
      if (!created.isDestroyed()) created.destroy();
    });
  }

  const removers = [
    context.bus.subscribe(EVENTS.AI_REQUEST_STARTED, (entry) => repository.append(entry), { allowWhileStopped: true }),
    context.bus.subscribe(EVENTS.AI_REQUEST_FINISHED, (entry) => repository.finish(entry), { allowWhileStopped: true }),
    context.menu.register(() => [{ label: "原始日志…", enabled: running && !disposed, click: show }]),
    ...["list", "get"].map((method) => context.ipc.handle(method, (event, request) => {
      if (!running || disposed || !win || win.isDestroyed() || event.sender !== win.webContents) {
        throw new Error("日志窗口已关闭或请求来源无效");
      }
      return repository[method](request);
    })),
  ];
  return {
    start() { if (!disposed) running = true; },
    stop() { running = false; close(); },
    dispose() {
      disposed = true; running = false; close();
      for (const remove of removers) remove();
    },
  };
}

module.exports = { activate };
