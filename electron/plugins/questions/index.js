const path = require("path");
const EVENTS = require("../../architecture/events");
const { getOptions } = require("./options");

function createQuestionsPlugin(context, { now = Date.now, setTimer = setInterval, clearTimer = clearInterval,
  setExpiryTimer = setTimeout, clearExpiryTimer = clearTimeout } = {}) {
  let running = true, disposed = false, win = null, current = null, timer = null, expiry = null;
  let engaged = false;
  let pausedUntil = 0;
  const decisions = new Set(), speech = new Set();
  const options = () => getOptions(context.config.get());
  const memory = () => {
    const service = context.services.get("memory.work");
    if (!service) throw new Error("人物记忆服务不可用");
    return service;
  };
  const available = () => running && !disposed && options().enabled;
  const pauseUntil = () => Math.max(pausedUntil, memory().attention().questionsPausedUntil || 0);
  function clearExpiry() {
    if (expiry !== null) clearExpiryTimer(expiry);
    expiry = null;
  }
  function engage() {
    engaged = true;
    clearExpiry();
  }
  function close() {
    clearExpiry();
    engaged = false;
    const old = win;
    win = current = null;
    if (old && !old.isDestroyed()) old.destroy();
  }
  function dismiss(action = "defer") {
    if (current) {
      try { memory().answer(current.id, { action }, options()); }
      catch (error) { context.logger.warn("question dismissal failed:", error); }
    }
    close();
  }
  function canAsk() {
    if (!available() || !options().auto || decisions.size || speech.size || now() < pauseUntil()) return false;
    // Fail closed if the host cannot determine whether the user is currently busy.
    const idle = context.attention?.getIdleSeconds?.();
    if (!Number.isFinite(idle) || idle < options().minIdleSeconds || idle > options().maxIdleSeconds) return false;
    const attention = memory().attention();
    return now() >= attention.audioUntil && now() >= attention.meetingUntil;
  }
  function show({ manual = false } = {}) {
    if (!available()) return false;
    if (win && !win.isDestroyed()) {
      if (manual) { engage(); win.show(); win.focus(); }
      return true;
    }
    if (!manual && !canAsk()) return false;
    const question = memory().nextQuestion({ ...options(), manual });
    if (!question) return false;
    const bounds = context.pet.getBounds();
    if (!bounds && !manual) return false;
    const area = bounds ? context.screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y }).workArea
      : context.screen.getPrimaryDisplay().workArea;
    const width = Math.max(240, Math.min(420, area.width - 32));
    const height = Math.max(250, Math.min(440, area.height - 32));
    const created = context.windows.create({ width, height, show: false, title: "桌宠想了解一下",
      frame: false, resizable: true, minimizable: false, maximizable: false,
      skipTaskbar: true, alwaysOnTop: true, backgroundColor: "#15131d",
      webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    win = created;
    current = question;
    engaged = manual;
    created.on("focus", () => { if (win === created) engage(); });
    created.setPosition(Math.max(area.x + 16, Math.min(bounds?.x || area.x + area.width - width - 16, area.x + area.width - width - 16)),
      Math.max(area.y + 16, Math.min((bounds?.y || area.y + area.height) - height - 12, area.y + area.height - height - 16)));
    created.once("ready-to-show", () => {
      if (!available() || win !== created || created.isDestroyed()) return;
      try {
        if (!manual && !canAsk()) { close(); return; }
        memory().markShown(question.id);
        if (manual) { created.show(); created.focus(); } else created.showInactive();
        // Only an untouched automatic popup expires. Once answering starts,
        // keep the window and draft until the user explicitly handles it.
        if (!engaged) {
          expiry = setExpiryTimer(() => {
            if (win === created && !engaged) dismiss("defer");
          }, options().timeoutMs);
          expiry.unref?.();
        }
        context.menu?.refresh();
      } catch (error) { context.logger.warn("question display failed:", error); close(); }
    });
    created.once("closed", () => { if (win === created) dismiss("defer"); });
    void created.loadFile(path.join(__dirname, "window.html")).catch((error) => {
      context.logger.error("question window failed:", error);
      if (win === created) close();
    });
    return true;
  }
  function requireSender(event) {
    if (!available() || !win || win.isDestroyed() || event.sender !== win.webContents || !current) throw new Error("提问窗口已关闭或请求来源无效");
    if (memory().getQuestion(current.id).status !== "pending") throw new Error("问题已处理");
  }
  const releases = [
    context.ipc.handle("current", (event) => { requireSender(event); return current; }),
    context.ipc.handle("activity", (event) => { requireSender(event); engage(); }),
    context.ipc.handle("answer", (event, input) => {
      requireSender(event);
      if (!input || typeof input !== "object" || (input.text != null && (typeof input.text !== "string" || input.text.length > 600))) throw new Error("回答内容无效或过长");
      const result = memory().answer(current.id, input, options());
      close(); context.menu?.refresh();
      return result;
    }),
    context.bus.subscribe(EVENTS.MEMORY_CLEARED, () => { pausedUntil = 0; close(); }),
    context.bus.subscribe(EVENTS.WORK_MEMORY_UPDATED, () => {
      if (current) {
        try { if (memory().getQuestion(current.id).status !== "pending") close(); }
        catch { close(); }
      }
      context.menu?.refresh();
    }),
    context.bus.subscribe(EVENTS.DECISION_STARTED, ({ id }) => { decisions.add(id); }),
    context.bus.subscribe(EVENTS.DECISION_COMPLETED, ({ id }) => { decisions.delete(id); }),
    context.bus.subscribe(EVENTS.PIPELINE_FAILED, (event) => { if (event.stage === "decision") decisions.delete(event.id); }),
    context.bus.subscribe(EVENTS.SPEECH_OUTPUT_STATE, (event) => {
      if (event.state === "start") speech.add(event.playbackId);
      else speech.delete(event.playbackId);
    }),
  ];
  const refresh = () => {
    try {
      // Busy/idle conditions gate new popups, never an existing answer.
      if (current) return;
      show();
    } catch (error) { if (available()) context.logger.warn("question scheduling deferred:", error.message); }
  };
  const unregisterMenu = context.menu?.register(() => [{ label: "桌宠提问", submenu: [
    { label: "回答一个问题…", enabled: available(), click: () => {
      try { show({ manual: true }); } catch (error) { context.logger.warn("question unavailable:", error.message); }
    } },
    { label: available() && pauseUntil() > now() ? "恢复自动提问" : "今天暂停自动提问", enabled: available(), click: () => {
      const end = new Date(now()); end.setHours(24, 0, 0, 0);
      pausedUntil = pauseUntil() > now() ? 0 : end.getTime();
      memory().pauseQuestions(pausedUntil);
      if (current) dismiss();
      context.menu?.refresh();
    } },
  ] }]) || (() => {});
  function start() {
    if (disposed) return;
    running = true;
    if (!timer) { timer = setTimer(refresh, options().pollMs); timer?.unref?.(); }
  }
  function stop() {
    if (current) dismiss();
    running = false;
    if (timer) clearTimer(timer);
    timer = null;
    close(); decisions.clear(); speech.clear();
  }
  return { start, stop, show, tick: refresh,
    dispose() { stop(); disposed = true; releases.forEach((release) => release()); unregisterMenu(); } };
}

function activate(context) { return createQuestionsPlugin(context); }
module.exports = { activate, createQuestionsPlugin };
