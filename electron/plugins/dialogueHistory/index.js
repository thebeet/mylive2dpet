const path = require("path");
const EVENTS = require("../../architecture/events");
const { getPlugin } = require("../registry");
const { createHistoryRepository } = require("./repository");

function createHistoryPlugin(context, dependencies = {}) {
  const options = getPlugin(context.config.get(), "dialogue-history") || {};
  const storage = context.services.get(options.storageService || "storage-sqlite.database");
  if (!storage && !dependencies.repository) throw new Error("历史对话需要 SQLite 存储服务");
  const repository = dependencies.repository || createHistoryRepository(storage);
  const legacyPath = path.resolve(context.paths?.projectRoot || path.resolve(__dirname, "../../.."), options.legacyPath || "logs/dialogue-history.jsonl");
  repository.importLegacy?.(legacyPath, context.logger);
  let win = null;
  let running = true;
  let disposed = false;

  function show() {
    if (disposed || !running) return;
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show(); win.focus(); return;
    }
    const created = context.windows.create({
      width: 560, height: 720, minWidth: 420, minHeight: 480,
      title: "桌宠历史对话", show: false, autoHideMenuBar: true, backgroundColor: "#10131a",
      webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false },
    });
    win = created;
    created.once("ready-to-show", () => { if (!disposed && !created.isDestroyed()) created.show(); });
    created.on("closed", () => { if (win === created) win = null; });
    void created.loadFile(path.join(__dirname, "window.html")).catch((error) => context.logger.error("history window failed:", error));
  }

  const unregisterIpc = context.ipc.handle("list", (event, request = {}) => {
    if (disposed || !running || !win || win.isDestroyed() || event.sender !== win.webContents) throw new Error("历史窗口已关闭");
    return repository.list(request || {});
  });
  const unregisterMenu = context.menu.register(() => [{ label: "历史对话", click: show }]);
  const unsubscribe = context.bus.subscribe(EVENTS.DECISION_COMPLETED, (event) => {
    if (!running || disposed) return;
    try {
      repository.append({
        id: event.id, sessionId: event.sessionId, sessionStartedAt: event.sessionStartedAt,
        t: event.completedAt, petSaid: event.result.reply, expression: event.result.expression,
        userSaid: event.observations.filter(({ role }) => role === "user")
          .flatMap(({ content }) => content.filter(({ type }) => type === "text"))
          .map(({ text }) => text.trim()).filter(Boolean).join("\n"),
        summaries: event.result.summaries,
        trigger: event.trigger || "",
        metadata: { observationIds: event.observations.map(({ id }) => id).filter(Boolean),
          sources: [...new Set(event.observations.map(({ source }) => source))] },
      });
    } catch (error) { context.logger.warn("history record failed:", error); }
  });

  function stop() {
    running = false;
    if (win && !win.isDestroyed()) win.destroy();
    win = null;
    repository.endSessions();
  }
  return {
    start() { if (!disposed) running = true; },
    stop,
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe(); unregisterMenu(); unregisterIpc();
      try { stop(); } finally { if (win && !win.isDestroyed()) win.destroy(); win = null; }
    },
  };
}

function activate(context) { return createHistoryPlugin(context); }

module.exports = { activate, createHistoryPlugin };
