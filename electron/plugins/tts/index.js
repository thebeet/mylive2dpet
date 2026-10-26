const fs = require("fs");
const EVENTS = require("../../architecture/events");
const { isTtsPluginActive, getTtsOptions } = require("./options");
const { createSystemTts } = require("./systemTts");
const { createGptSovitsTts } = require("./gptSovitsTts");
const { createAudioPlayer } = require("./playWav");

function createTtsPlugin(context, dependencies = {}) {
  const system = dependencies.system || createSystemTts({ platform: context.platform });
  const gptSovits = dependencies.gptSovits || createGptSovitsTts({ logger: context.logger });
  const player = dependencies.player || createAudioPlayer({ platform: context.platform });
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
    const stops = [system, gptSovits, player].map((backend) => {
      try { return backend.stop(); } catch (error) { return Promise.reject(error); }
    });
    return Promise.allSettled([pending, ...stops]);
  }

  function setEnabled(enabled) {
    if (disposed) return;
    runtimeEnabled = Boolean(enabled);
    if (!runtimeEnabled) void cancelPending();
    refreshMenu();
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
    return [{ label: "语音 TTS", submenu: [
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
    return done;
  }

  return {
    start() { if (!disposed) { running = true; refreshMenu(); } },
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
    getState: () => ({ enabled: isEnabled(), running, disposed, pendingCount: controllers.size }),
    setEnabled,
    async whenIdle() { let task; do { task = pending; await task; } while (task !== pending); },
  };
}

function activate(context) {
  return createTtsPlugin(context);
}

module.exports = { activate, createTtsPlugin };
