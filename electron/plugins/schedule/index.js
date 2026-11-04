const path = require("node:path");
const { getPlugin } = require("../registry");
const { normalizeOptions } = require("./definition");
const { createScheduleScheduler } = require("./scheduler");
const { promptExtension, handleScheduleEffects } = require("./effects");
const EVENTS = require("../../architecture/events");

function createSchedulePlugin(context, dependencies = {}) {
  const scheduler = createScheduleScheduler({
    storage: context.storage, submit: (observation) => context.perception.submit(observation),
    options: normalizeOptions(getPlugin(context.config.get(), "schedule") || {}),
    logger: context.logger, ...dependencies,
  });
  let win = null;
  let running = false;
  let disposed = false;
  let disposal = null;

  const unregisterPrompt = context.systemPrompt.register(promptExtension);
  const unsubscribeDecision = context.bus.subscribe(EVENTS.DECISION_COMPLETED, (event) => {
    if (running && !disposed) handleScheduleEffects(event, scheduler, context.logger);
  });

  function show() {
    if (!running || disposed) return;
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show(); win.focus(); return;
    }
    const created = context.windows.create({
      width: 600, height: 680, minWidth: 420, minHeight: 420,
      title: "定时通知", show: false, autoHideMenuBar: true, backgroundColor: "#11131a",
      webPreferences: { preload: path.join(__dirname, "preload.js"),
        contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win = created;
    created.once("ready-to-show", () => {
      if (running && !disposed && !created.isDestroyed()) created.show();
    });
    created.on("closed", () => { if (win === created) win = null; });
    void created.loadFile(path.join(__dirname, "window.html")).catch((error) => {
      context.logger.error("schedule window failed:", error);
      if (!created.isDestroyed()) created.destroy();
    });
  }

  const unregisterService = context.services.register("tasks", {
    create: scheduler.create, list: scheduler.list, cancel: scheduler.cancel,
  });
  const unregisterIpc = ["create", "list", "cancel"].map((method) => context.ipc.handle(method, (event, input) => {
    if (!running || disposed || !win || win.isDestroyed() || event.sender !== win.webContents) {
      throw new Error("定时通知窗口已关闭");
    }
    return scheduler[method](input);
  }));
  const unregisterMenu = context.menu.register(() => [{ label: "定时通知…", click: show }]);

  async function stop() {
    running = false;
    const current = win;
    win = null;
    if (current && !current.isDestroyed()) current.destroy();
    await scheduler.stop();
  }

  return {
    start() {
      if (disposed || running) return;
      scheduler.start();
      running = true;
    },
    stop,
    dispose() {
      if (disposal) return disposal;
      disposed = true;
      unregisterMenu(); unregisterService();
      unregisterPrompt(); unsubscribeDecision();
      unregisterIpc.forEach((release) => release());
      disposal = stop();
      return disposal;
    },
  };
}

module.exports = { activate: createSchedulePlugin, createSchedulePlugin };
