const fs = require("fs");
const EVENTS = require("../../architecture/events");
const { isTtsPluginActive, getTtsOptions } = require("./options");
const { createSystemTts } = require("./systemTts");
const { createGptSovitsTts } = require("./gptSovitsTts");
const { createCompatibleTts } = require("./compatibleTts");
const { createAudioPlayer } = require("./playWav");

function createTtsPlugin(context, dependencies = {}) {
  const system = dependencies.system || createSystemTts({ platform: context.platform });
  const gptSovits = dependencies.gptSovits || createGptSovitsTts({ logger: context.logger });
  const player = dependencies.player || createAudioPlayer({ platform: context.platform });
  const compatible = dependencies.compatible || createCompatibleTts({ logger: context.logger,
    onStatus: () => context.menu.refresh() });
  let runtimeEnabled = true;
  let running = true;
  let disposed = false;
  let disposal = null;
  let generation = 0;
  let nextPlaybackId = 0;
  let pending = Promise.resolve();
  const controllers = new Set();

  const isEnabled = () => running && !disposed && runtimeEnabled && isTtsPluginActive(context.config.get());
  const refreshMenu = () => context.menu.refresh();

  function removePrepared(prepared) {
    if (prepared?.path && prepared.deleteAfter !== false) {
      try { fs.unlinkSync(prepared.path); } catch { /* Already removed. */ }
    }
  }

  async function publishState(playbackId, state) {
    await context.bus.notify(EVENTS.SPEECH_OUTPUT_STATE, { playbackId, state });
  }

  function cancelPending() {
    generation += 1;
    for (const controller of controllers) controller.abort();
    // Trigger every cancellation before waiting for any backend to settle.
    const stops = [system, gptSovits, compatible, player].map((backend) => {
      try { return backend.stop(); } catch (error) { return Promise.reject(error); }
    });
    return Promise.allSettled([pending, ...stops]);
  }

  function setEnabled(enabled) {
    if (disposed) return;
    runtimeEnabled = Boolean(enabled);
    if (!runtimeEnabled) void cancelPending();
    else warmService();
    refreshMenu();
  }

  function warmService() {
    if (!isEnabled()) return;
    const options = getTtsOptions(context.config.get());
    if (options.provider !== "openai-compatible") return;
    void compatible.start(options).catch((error) => {
      if (isEnabled()) context.logger.error("语音服务初始化失败:", error.message);
    });
  }

  function requestSpeech({ text }) {
    if (!isEnabled()) return;
    const options = getTtsOptions(context.config.get());
    if (options.interruptOnNewChat) void cancelPending();
    const myGeneration = generation;
    const playbackId = ++nextPlaybackId;
    const controller = new AbortController();
    controllers.add(controller);
    const valid = () => !controller.signal.aborted && myGeneration === generation && isEnabled();
    const task = pending.then(async () => {
      let prepared = null;
      let started = false;
      let terminal = "end";
      let stateNotifications = Promise.resolve();
      try {
        if (!valid()) return;
        context.logger.info(`provider=${options.provider} prepare:`, String(text || "").slice(0, 60));
        if (options.provider === "system") {
          prepared = await system.synthesizeToFile(text, { rate: options.rate, signal: controller.signal });
        } else if (options.provider === "gpt-sovits" || options.provider === "gpt_sovits") {
          prepared = await gptSovits.synthesizeToFile(text, { ...options, signal: controller.signal });
        } else if (options.provider === "openai-compatible") {
          prepared = await compatible.synthesizeToFile(text, { ...options, signal: controller.signal });
        } else {
          throw new Error(`TTS provider not implemented: ${options.provider}`);
        }
        if (!prepared?.path || !valid()) return;
        await player.play(prepared.path, {
          deleteAfter: prepared.deleteAfter !== false,
          signal: controller.signal,
          onStart() {
            started = true;
            stateNotifications = publishState(playbackId, "start");
          },
        });
      } catch (error) {
        if (valid()) {
          terminal = "error";
          context.logger.error("speech preparation/playback failed:", error);
        }
      } finally {
        removePrepared(prepared);
        if (started) {
          await stateNotifications;
          await publishState(playbackId, terminal);
        }
      }
    }).catch((error) => {
      context.logger.error("speech task failed:", error);
    }).finally(() => { controllers.delete(controller); });
    pending = task;
  }

  const unregisterMenu = context.menu.register(() => {
    if (!isTtsPluginActive(context.config.get())) return [];
    const enabled = isEnabled();
    const status = compatible.getState();
    const labels = { idle: "未启动", connecting: "连接中", "checking-docker": "检查本地运行环境",
      "pulling-image": "首次下载模型中", "starting-container": "启动本地服务中",
      "loading-model": "加载模型中", "registering-voice": "创建角色音色中", ready: "已就绪", error: "服务异常" };
    const serviceStatus = getTtsOptions(context.config.get()).provider === "openai-compatible"
      ? [{ label: `服务：${labels[status.phase] || status.phase}${status.error ? `（${status.error.replace(/\s+/g, " ").slice(0, 180)}）` : ""}`, enabled: false }]
      : [];
    return [{ label: "语音 TTS", submenu: [
      ...serviceStatus,
      { label: "开启", type: "radio", checked: enabled, click: () => setEnabled(true) },
      { label: "关闭", type: "radio", checked: !enabled, click: () => setEnabled(false) },
    ] }];
  });
  const unsubscribeStop = context.bus.subscribe(EVENTS.SPEECH_OUTPUT_STOP_REQUESTED, () => cancelPending());
  const unsubscribeSpeech = context.bus.subscribe(EVENTS.SPEECH_OUTPUT_REQUESTED, requestSpeech);

  function stop() {
    running = false;
    const done = cancelPending();
    refreshMenu();
    return Promise.allSettled([done, compatible.shutdown()]).then((results) => {
      for (const result of results) if (result.status === "rejected") context.logger.error("语音服务停止失败:", result.reason);
    });
  }

  return {
    start() { if (!disposed) { running = true; warmService(); refreshMenu(); } },
    stop,
    dispose() {
      if (disposal) return disposal;
      disposed = true;
      unsubscribeSpeech();
      unsubscribeStop();
      unregisterMenu();
      disposal = stop();
      return disposal;
    },
    getState: () => ({ enabled: isEnabled(), running, disposed, pendingCount: controllers.size, service: compatible.getState() }),
    setEnabled,
    async whenIdle() { let task; do { task = pending; await task; } while (task !== pending); },
  };
}

function activate(context) {
  return createTtsPlugin(context);
}

module.exports = { activate, createTtsPlugin };
