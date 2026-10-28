const EVENTS = require("../../architecture/events");
const { createPerceptionService } = require("../../architecture/perceptionService");
const { getAudioOutputOptions } = require("./options");
const { AudioSegmenter } = require("./segmenter");
const { resolveMonitorSource, startLinuxCapture } = require("./capture/linux");
const { transcribeAudio, validateAsrOptions } = require("./transcribe");
const { createLiveWindow } = require("./liveWindow");

const isAudio = (observation) => observation.source === "audio-output";

/** Audio source plugin; publishes observations to the shared perception queue. */
function registerAudioOutputPerceptionPlugin(bus, dependencies = {}) {
  const readConfig = dependencies.loadConfig || (() => ({}));
  const platform = dependencies.platform || process.platform;
  const logger = dependencies.logger || console;
  const resolveSource = dependencies.resolveSource || resolveMonitorSource;
  const capture = dependencies.capture || startLinuxCapture;
  const transcribe = dependencies.transcribe || transcribeAudio;
  const perception = dependencies.perception || createPerceptionService(bus);
  let disposed = false;
  const tasks = new Set();
  function track(task) {
    const pending = Promise.resolve(task).catch((error) => {
      if (!disposed) logger.warn("audio task failed:", error);
    }).finally(() => tasks.delete(pending));
    tasks.add(pending);
    return pending;
  }
  let options = getAudioOutputOptions(readConfig());
  let state = { enabled: false, status: "disabled", source: "", error: "" };
  const liveWindow = createLiveWindow({ ...dependencies, logger });
  let captureHandle = null;
  let segmenter = null;
  let retryTimer = null;
  let generation = 0;
  let abortController = null;
  let processingGeneration = null;
  let pendingSegments = [];
  let suppressedUntil = 0;
  const playbacks = new Set();
  const recentTranscripts = new Map();

  function setState(update) {
    const next = { ...state, ...update };
    if (JSON.stringify(next) === JSON.stringify(state)) return;
    state = next;
    liveWindow.setState(state);
    dependencies.menu?.refresh?.();
    logger.info(
      "audio state:",
      state.status,
      state.source || "",
      state.error || "",
    );
  }

  function suppressed() {
    return playbacks.size > 0 || Date.now() < suppressedUntil;
  }

  function reportError(error, stage) {
    setState({ status: "error", error: error.message || String(error) });
    void bus.notify(EVENTS.PIPELINE_FAILED, {
      stage, trigger: "audio-output", error,
    });
  }

  async function processSegments(sessionGeneration) {
    if (processingGeneration === sessionGeneration) return;
    processingGeneration = sessionGeneration;
    try {
      while (state.enabled && generation === sessionGeneration && pendingSegments.length) {
        const segment = pendingSegments.shift();
        if (Date.now() - Date.parse(segment.endedAt) > options.observationTtlMs) continue;
        abortController = new AbortController();
        try {
          const result = await transcribe(segment, options.asr, {
            signal: abortController.signal,
            fetchImpl: dependencies.fetchImpl || (async (url, init) => {
              // An isolated session prevents ASR proxy changes from racing with chat.
              const { session } = require("electron");
              const audioSession = session.fromPartition("audio-asr");
              await audioSession.setProxy(options.asr.proxy
                ? { proxyRules: options.asr.proxy, proxyBypassRules: "<local>" }
                : { mode: "direct" });
              return audioSession.fetch(url, init);
            }),
          });
          if (!state.enabled || generation !== sessionGeneration) return;
          if (!result.text || Date.now() - Date.parse(segment.endedAt) > options.observationTtlMs) continue;
          liveWindow.addTranscript({ text: result.text, capturedAt: segment.endedAt });
          const normalized = result.text.replace(/[\s\p{P}\p{S}]+/gu, "").toLowerCase();
          const now = Date.now();
          for (const [text, at] of recentTranscripts) {
            if (now - at > options.duplicateWindowMs) recentTranscripts.delete(text);
          }
          if (!normalized || recentTranscripts.has(normalized)) continue;
          recentTranscripts.set(normalized, now);
          const observation = {
            source: "audio-output", trigger: "audio-output",
            capturedAt: segment.capturedAt,
            expiresAt: Date.parse(segment.endedAt) + options.observationTtlMs,
            content: [{ type: "text", text: result.text }],
            metadata: {
              modality: "audio", label: "设备音频输出转写",
              endedAt: segment.endedAt, durationMs: segment.durationMs,
              language: result.language, confidence: result.confidence,
              device: state.source,
            },
          };
          await perception.discard((item) => isAudio(item) && item.expiresAt <= now, "expired");
          await perception.submit(observation, {
            maxMatching: options.maxPendingObservations, matches: isAudio,
          });
          logger.info("transcript:", result.text);
          if (captureHandle) setState({ status: suppressed() ? "suppressed" : "listening", error: "" });
        } catch (error) {
          if (state.enabled && generation === sessionGeneration) reportError(error, "audio-transcription");
        } finally {
          if (generation === sessionGeneration) abortController = null;
        }
      }
    } finally {
      if (processingGeneration === sessionGeneration) processingGeneration = null;
    }
  }

  function onSegment(segment) {
    if (!state.enabled || suppressed()) return;
    pendingSegments.push(segment);
    if (pendingSegments.length > options.maxPendingSegments) pendingSegments.shift();
    void track(processSegments(generation));
  }

  async function connect(sessionGeneration) {
    if (!state.enabled || generation !== sessionGeneration) return;
    try {
      const source = await resolveSource(options.source);
      if (!state.enabled || generation !== sessionGeneration) return;
      segmenter = new AudioSegmenter(options, onSegment);
      captureHandle = capture(source, options, {
        onData(chunk) {
          if (generation !== sessionGeneration || !state.enabled) return;
          if (suppressed()) {
            segmenter.reset();
            return;
          }
          if (state.status === "suppressed") setState({ status: "listening", error: "" });
          segmenter.push(chunk);
        },
        onError(error) {
          if (generation !== sessionGeneration || !state.enabled) return;
          if (captureHandle) void track(captureHandle.stop());
          captureHandle = null;
          segmenter?.reset();
          reportError(error, "audio-capture");
          scheduleReconnect(sessionGeneration);
        },
      });
      setState({ source, status: suppressed() ? "suppressed" : "listening", error: "" });
    } catch (error) {
      if (generation !== sessionGeneration || !state.enabled) return;
      reportError(error, "audio-capture");
      scheduleReconnect(sessionGeneration);
    }
  }

  function scheduleReconnect(sessionGeneration) {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => void track(connect(sessionGeneration)), 5000);
  }

  function stop() {
    generation += 1;
    liveWindow.stop();
    clearTimeout(retryTimer);
    retryTimer = null;
    const captureStopped = captureHandle?.stop();
    if (captureStopped) void track(captureStopped);
    captureHandle = null;
    segmenter?.reset();
    segmenter = null;
    abortController?.abort();
    abortController = null;
    pendingSegments = [];
    recentTranscripts.clear();
    void track(perception.discard(isAudio, "source-stopped"));
    setState({ enabled: false, status: "disabled", source: "", error: "" });
    return Promise.allSettled([...tasks]);
  }

  async function start({ enabled } = {}) {
    if (disposed || state.enabled) return;
    try {
      options = getAudioOutputOptions(readConfig());
      if (!(enabled ?? options.enabled)) return;
      if (platform !== "linux") throw new Error("设备音频感知目前支持 Linux PipeWire/PulseAudio");
      validateAsrOptions(options.asr);
      generation += 1;
      setState({ enabled: true, status: "starting", error: "" });
      await track(connect(generation));
    } catch (error) {
      reportError(error, "audio-perception");
    }
  }

  const unsubscribeTts = bus.subscribe(EVENTS.SPEECH_OUTPUT_STATE, ({ playbackId, state: playbackState }) => {
    if (playbackState === "start") playbacks.add(playbackId);
    else if (!playbacks.delete(playbackId)) return;
    suppressedUntil = Date.now() + options.ttsCooldownMs;
    segmenter?.reset();
    if (state.enabled && captureHandle && state.status !== "error") setState({ status: "suppressed" });
  }, { allowWhileStopped: true });

  const plugin = {
    start, stop,
    getState: () => ({ ...state }),
    dispose() {
      disposed = true;
      const done = stop();
      unsubscribeTts();
      unregisterMenuContribution();
      liveWindow.dispose();
      playbacks.clear();
      return done;
    },
  };

  let unregisterMenuContribution = () => {};
  if (typeof dependencies.menu?.register === "function") {
    unregisterMenuContribution = dependencies.menu.register(() => {
      const audioState = plugin.getState();
      return [
        {
          label: "感知设备播放的语音",
          enabled: platform === "linux",
          submenu: [
            {
              label: "开启",
              type: "radio",
              checked: audioState.enabled,
              click: () => { void plugin.start({ enabled: true }); },
            },
            {
              label: "关闭",
              type: "radio",
              checked: !audioState.enabled,
              click: () => plugin.stop(),
            },
            {
              label: "实时显示内容",
              submenu: [
                { label: "开启", type: "radio", checked: liveWindow.isEnabled(),
                  click: () => liveWindow.setEnabled(true) },
                { label: "关闭", type: "radio", checked: !liveWindow.isEnabled(),
                  click: () => liveWindow.setEnabled(false) },
              ],
            },
            { type: "separator" },
            {
              label: `设备音频：${audioStatusLabel(audioState, platform)}`,
              enabled: false,
            },
          ],
        },
      ];
    });
  }

  return plugin;
}

function activate(context) {
  return registerAudioOutputPerceptionPlugin(context.bus, {
    loadConfig: () => context.config.get(),
    platform: context.platform,
    menu: context.menu,
    logger: context.logger,
    perception: context.perception,
    windows: context.windows,
    screen: context.screen,
    ipc: context.ipc,
  });
}

function audioStatusLabel(state, platform) {
  if (platform !== "linux") return "当前系统暂不支持";
  if (state.status === "error") return state.error || "采集异常";
  return {
    disabled: "未开启", starting: "启动中", listening: "监听中",
    suppressed: "等待桌宠语音结束",
  }[state.status] || state.status;
}

module.exports = {
  activate,
  registerAudioOutputPerceptionPlugin,
};
