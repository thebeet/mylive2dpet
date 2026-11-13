const EVENTS = require("../../architecture/events");
const { createPerceptionService } = require("../../architecture/perceptionService");
const { AudioSegmenter } = require("./segmenter");
const { resolveAudioSource, startLinuxCapture } = require("./capture/linux");
const { transcribeAudio, validateAsrOptions } = require("./transcribe");
const { createLiveWindow } = require("./liveWindow");
const { createFunAsrStream } = require("./funasr");

const isAudio = (observation) => observation.source === "audio-output";

/** Audio source plugin; publishes observations to the shared perception queue. */
function createAudioSourceSession(bus, options, dependencies = {}) {
  const platform = dependencies.platform || process.platform;
  const logger = dependencies.logger || console;
  const resolveSource = dependencies.resolveSource || resolveAudioSource;
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
  const matchesSource = (item) => isAudio(item) && item.metadata?.sourceId === options.sourceId;
  let state = { enabled: false, status: "disabled", source: "", error: "" };
  const liveWindow = dependencies.liveWindow || createLiveWindow({ ...dependencies, logger });
  let captureHandle = null;
  let segmenter = null;
  let retryTimer = null;
  let generation = 0;
  let cancellationVersion = 0;
  let connection = 0;
  let abortController = null;
  let processingGeneration = null;
  let pendingSegments = [];
  let activeStream = null;
  const streams = new Set();
  const streamFactory = dependencies.createFunAsrStream || createFunAsrStream;
  const speechState = dependencies.speechState;
  const recentTranscripts = new Map();

  function setState(update) {
    const next = { ...state, ...update };
    if (JSON.stringify(next) === JSON.stringify(state)) return;
    state = next;
    liveWindow.setState(state);
    dependencies.onState?.();
    logger.info(
      "audio state:",
      state.status,
      state.source || "",
      state.error || "",
    );
  }

  function suppressed() {
    return speechState.playbacks.size > 0 || Date.now() < speechState.suppressedUntil;
  }

  function reportError(error, stage) {
    setState({ status: "error", error: error.message || String(error) });
    void bus.notify(EVENTS.PIPELINE_FAILED, {
      stage, trigger: "audio-output", error,
    });
  }

  async function acceptResult(segment, result, sessionGeneration, transcriptId, isCurrent = () => true) {
    const valid = () => state.enabled && generation === sessionGeneration && isCurrent();
    if (!valid()) return;
    if (!result.text || Date.now() - Date.parse(segment.endedAt) > options.observationTtlMs) {
      if (transcriptId) liveWindow.removeTranscript(transcriptId);
      return;
    }
    liveWindow.addTranscript({ id: transcriptId, text: result.text, capturedAt: segment.endedAt, final: true });
    const normalized = result.text.replace(/[\s\p{P}\p{S}]+/gu, "").toLowerCase();
    const now = Date.now();
    for (const [text, at] of recentTranscripts) {
      if (now - at > options.duplicateWindowMs) recentTranscripts.delete(text);
    }
    if (!normalized || recentTranscripts.has(normalized)) return;
    const observation = {
      source: "audio-output", trigger: "audio-output",
      capturedAt: segment.capturedAt,
      expiresAt: Date.parse(segment.endedAt) + options.observationTtlMs,
      content: [{ type: "text", text: result.text }],
      metadata: {
        modality: "audio", label: options.label, sourceId: options.sourceId, sourceType: options.type,
        endedAt: segment.endedAt, durationMs: segment.durationMs,
        language: result.language, confidence: result.confidence,
        device: state.source,
      },
    };
    await perception.discard((item) => matchesSource(item) && item.expiresAt <= now, "expired");
    if (!valid()) return;
    recentTranscripts.set(normalized, now);
    await perception.submit(observation, {
      maxMatching: options.maxPendingObservations, matches: matchesSource,
    });
    logger.info("transcript:", result.text);
    if (captureHandle) setState({ status: suppressed() ? "suppressed" : "listening", error: "" });
  }

  function cancelStreams() {
    for (const stream of streams) {
      liveWindow.removeTranscript(stream.id);
      stream.cancel();
    }
    streams.clear();
    activeStream = null;
  }

  function startStream(segment, sessionGeneration) {
    // Retain bounded concurrent finalization; never queue an unbounded live feed.
    while (streams.size >= options.maxPendingSegments) {
      const oldest = streams.values().next().value;
      streams.delete(oldest);
      liveWindow.removeTranscript(oldest.id);
      oldest.cancel();
    }
    const stream = streamFactory(options.asr, {
      socketFactory: dependencies.socketFactory,
      maxAudioBytes: (options.maxSegmentMs + options.preRollMs + options.frameMs) * 32,
      onPartial(result) {
        if (streams.has(stream) && generation === sessionGeneration && state.enabled && !suppressed()) {
          liveWindow.addTranscript({ id: stream.id, text: result.text, capturedAt: segment.capturedAt, final: false });
        }
      },
    });
    activeStream = stream;
    streams.add(stream);
    void track(stream.result.catch((error) => {
      if (error.name !== "AbortError" && state.enabled && generation === sessionGeneration) {
        liveWindow.removeTranscript(stream.id);
        reportError(error, "audio-transcription");
      }
    }));
  }

  async function processSegments(sessionGeneration) {
    if (processingGeneration === sessionGeneration) return;
    processingGeneration = sessionGeneration;
    try {
      while (state.enabled && generation === sessionGeneration && pendingSegments.length) {
        const segment = pendingSegments.shift();
        if (Date.now() - Date.parse(segment.endedAt) > options.observationTtlMs) continue;
        const version = cancellationVersion;
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
          await acceptResult(segment, result, sessionGeneration, undefined, () => version === cancellationVersion && !suppressed());
        } catch (error) {
          if (state.enabled && generation === sessionGeneration && version === cancellationVersion && error.name !== "AbortError") reportError(error, "audio-transcription");
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
    if (options.asr.provider === "funasr") {
      const stream = activeStream;
      activeStream = null;
      if (!stream) return;
      const sessionGeneration = generation;
      void track(stream.finish().then(async (result) => {
        if (streams.has(stream)) {
          if (!result.text) liveWindow.removeTranscript(stream.id);
          await acceptResult(segment, result, sessionGeneration, stream.id,
            () => streams.has(stream) && !suppressed());
        }
      }, () => {}).catch((error) => {
        if (state.enabled && generation === sessionGeneration) reportError(error, "audio-transcription");
      }).finally(() => streams.delete(stream)));
      return;
    }
    pendingSegments.push(segment);
    if (pendingSegments.length > options.maxPendingSegments) pendingSegments.shift();
    void track(processSegments(generation));
  }

  async function connect(sessionGeneration) {
    if (!state.enabled || generation !== sessionGeneration) return;
    const connectionId = ++connection;
    const isCurrent = () => state.enabled && generation === sessionGeneration && connection === connectionId;
    try {
      const source = await resolveSource(options.source, { type: options.type });
      if (!isCurrent()) return;
      segmenter = new AudioSegmenter(options, onSegment, options.asr.provider === "funasr" ? {
        onStart: (segment) => {
          try { startStream(segment, sessionGeneration); }
          catch (error) { activeStream = null; reportError(error, "audio-transcription"); }
        },
        onAudio: (chunk) => activeStream?.push(chunk),
        onCancel: cancelStreams,
      } : {});
      captureHandle = capture(source, options, {
        onData(chunk) {
          if (!isCurrent()) return;
          if (suppressed()) {
            segmenter.reset();
            return;
          }
          if (state.status === "suppressed") setState({ status: "listening", error: "" });
          segmenter.push(chunk);
        },
        onError(error) {
          if (!isCurrent()) return;
          connection++;
          if (captureHandle) void track(captureHandle.stop());
          captureHandle = null;
          segmenter?.reset();
          cancelStreams();
          cancellationVersion++;
          abortController?.abort();
          pendingSegments = [];
          reportError(error, "audio-capture");
          scheduleReconnect(sessionGeneration);
        },
      });
      setState({ source, status: suppressed() ? "suppressed" : "listening", error: "" });
    } catch (error) {
      if (!isCurrent()) return;
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
    cancelStreams();
    abortController?.abort();
    abortController = null;
    pendingSegments = [];
    recentTranscripts.clear();
    void track(perception.discard(matchesSource, "source-stopped"));
    setState({ enabled: false, status: "disabled", source: "", error: "" });
    return Promise.allSettled([...tasks]);
  }

  async function start({ enabled } = {}) {
    if (disposed || state.enabled) return;
    try {
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

  function suppress() {
    segmenter?.reset();
    cancelStreams();
    cancellationVersion += 1;
    abortController?.abort();
    pendingSegments = [];
    if (state.enabled && captureHandle && state.status !== "error") setState({ status: "suppressed" });
  }

  const plugin = {
    start, stop, suppress,
    getState: () => ({ ...state }),
    dispose() {
      disposed = true;
      const done = stop();
      liveWindow.dispose();
      return done;
    },
  };

  return plugin;
}

module.exports = { createAudioSourceSession };
