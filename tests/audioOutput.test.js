const test = require("node:test");
const assert = require("node:assert/strict");
const { MessageBus } = require("../electron/architecture/messageBus");
const EVENTS = require("../electron/architecture/events");
const { getAudioOutputOptions } = require("../electron/plugins/audioOutputPerception/options");
const { AudioSegmenter, pcmToWav } = require("../electron/plugins/audioOutputPerception/segmenter");
const { resolveMonitorSource } = require("../electron/plugins/audioOutputPerception/capture/linux");
const { transcribeAudio, transcriptionEndpoint, validateAsrOptions } = require("../electron/plugins/audioOutputPerception/transcribe");
const { registerAudioOutputPerceptionPlugin } = require("../electron/plugins/audioOutputPerception");
const { registerDecisionModule } = require("../electron/modules/decision");
const { buildRequestBody } = require("../electron/plugins/aiConversation/request");
const { extractChatPayload } = require("../electron/plugins/aiConversation/parseChatText");
const { createShortTermStore } = require("../electron/plugins/memory/shortTerm");
const { formatRecentDialogue } = require("../electron/plugins/memory/context");

function pcm(ms, amplitude = 4000) {
  const data = Buffer.alloc(ms * 32);
  for (let offset = 0; offset < data.length; offset += 2) data.writeInt16LE(amplitude, offset);
  return data;
}
const utterance = (amplitude = 4000) => Buffer.concat([pcm(600, amplitude), pcm(1000, 0)]);
const settle = () => new Promise((resolve) => setImmediate(resolve));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness(overrides = {}, configOverrides = {}) {
  const bus = new MessageBus();
  const captures = [];
  const config = { perception: { audioOutput: {
    enabled: true, ttsCooldownMs: 100,
    asr: { endpoint: "https://asr.example/v1", model: "whisper-1" },
    ...configOverrides,
  } } };
  const controller = registerAudioOutputPerceptionPlugin(bus, {
    platform: "linux", loadConfig: () => config,
    resolveSource: async () => "output.monitor",
    capture: (_source, _options, handlers) => {
      const handle = { ...handlers, stopped: false, stop() { this.stopped = true; } };
      captures.push(handle);
      return handle;
    },
    transcribe: async () => ({ text: "播放的是编程讲解。", language: "zh", confidence: null }),
    ...overrides,
  });
  return { bus, captures, controller, config };
}

test("silence and short bursts are skipped; arbitrary PCM chunks preserve complete speech", () => {
  const segments = [];
  const options = getAudioOutputOptions();
  const segmenter = new AudioSegmenter(options, (segment) => segments.push(segment));
  segmenter.push(pcm(1000, 0));
  segmenter.push(Buffer.concat([pcm(100), pcm(1000, 0)]));
  assert.equal(segments.length, 0);
  const audio = utterance();
  // Includes odd-byte splits, which must not corrupt PCM framing.
  for (let offset = 0; offset < audio.length; offset += 333) segmenter.push(audio.subarray(offset, offset + 333));
  assert.equal(segments.length, 1);
  assert.ok(segments[0].durationMs >= 1400);
  assert.equal(segments[0].pcm.length, segments[0].durationMs * 32);
  const wav = pcmToWav(segments[0].pcm);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt32LE(40), segments[0].pcm.length);
});

test("continuous output is split into bounded segments; reset discards partial speech", () => {
  const options = getAudioOutputOptions({ perception: { audioOutput: { maxSegmentMs: 3000 } } });
  const segments = [];
  const segmenter = new AudioSegmenter(options, (segment) => segments.push(segment));
  segmenter.push(pcm(9100));
  assert.equal(segments.length, 3);
  assert.ok(segments.every((segment) => segment.durationMs === 3000));
  segmenter.reset();
  segmenter.push(pcm(1000, 0));
  assert.equal(segments.length, 3);
});

test("ASR sends in-memory WAV multipart, preserves endpoint queries and filters low-confidence speech", async () => {
  assert.equal(transcriptionEndpoint("https://asr.example/v1/"), "https://asr.example/v1/audio/transcriptions");
  const endpoint = "https://asr.example/v1/audio/transcriptions?version=1";
  const result = await transcribeAudio({ pcm: pcm(600) }, {
    endpoint, model: "whisper-1", apiKey: "test-key", language: "zh", timeoutMs: 1000,
  }, { fetchImpl: async (url, request) => {
    assert.equal(url, endpoint);
    assert.equal(request.headers.Authorization, "Bearer test-key");
    assert.equal(request.body.get("model"), "whisper-1");
    assert.equal(request.body.get("language"), "zh");
    const file = request.body.get("file");
    assert.equal(file.name, "output.wav");
    const wav = Buffer.from(await file.arrayBuffer());
    assert.equal(wav.length, 44 + 600 * 32);
    return { ok: true, json: async () => ({ text: "valid hallucination", segments: [
      { text: "valid", no_speech_prob: 0.1, avg_logprob: -0.2 },
      { text: " hallucination", no_speech_prob: 0.95, avg_logprob: -0.2 },
    ] }) };
  } });
  assert.equal(result.text, "valid");
  assert.ok(result.confidence > 0.8);
});

test("ASR aborts on timeout and accepts services without authentication", async () => {
  await assert.rejects(transcribeAudio({ pcm: pcm(100) }, {
    endpoint: "http://localhost:8080/v1", model: "local", timeoutMs: 20,
  }, { fetchImpl: async (_url, request) => {
    assert.deepEqual(request.headers, {});
    return new Promise((_resolve, reject) => request.signal.addEventListener("abort", () => reject(new Error("aborted"))));
  } }), /超时/);
});

test("Whisper container provider uses /asr query parameters and audio_file without a request model", async () => {
  const options = {
    provider: "whisper-asr-webservice", endpoint: "http://127.0.0.1:9000/asr/?custom=value",
    language: "zh", vadFilter: true, timeoutMs: 1000,
  };
  assert.doesNotThrow(() => validateAsrOptions(options));
  const result = await transcribeAudio({ pcm: pcm(600) }, options, {
    fetchImpl: async (endpoint, request) => {
      const url = new URL(endpoint);
      assert.equal(url.pathname, "/asr");
      assert.equal(url.searchParams.get("custom"), "value");
      assert.equal(url.searchParams.get("task"), "transcribe");
      assert.equal(url.searchParams.get("output"), "json");
      assert.equal(url.searchParams.get("encode"), "true");
      assert.equal(url.searchParams.get("language"), "zh");
      assert.equal(url.searchParams.get("vad_filter"), "true");
      assert.ok(request.body.get("audio_file"));
      assert.equal(request.body.get("file"), null);
      assert.equal(request.body.get("model"), null);
      assert.equal(request.body.get("language"), null);
      return { ok: true, json: async () => ({ text: "本地转写", language: "zh", segments: [] }) };
    },
  });
  assert.equal(result.text, "本地转写");
  assert.equal(result.language, "zh");
});

test("Whisper provider supports automatic language and disabling VAD; unknown providers fail before upload", async () => {
  await transcribeAudio({ pcm: pcm(600) }, {
    provider: "whisper-asr-webservice", endpoint: "http://localhost:9000", vadFilter: false, timeoutMs: 1000,
  }, { fetchImpl: async (endpoint) => {
    const url = new URL(endpoint);
    assert.equal(url.pathname, "/asr");
    assert.equal(url.searchParams.has("language"), false);
    assert.equal(url.searchParams.get("vad_filter"), "false");
    return { ok: true, json: async () => ({ text: "" }) };
  } });
  await assert.rejects(transcribeAudio({ pcm: pcm(600) }, {
    provider: "unknown", endpoint: "http://localhost:9000",
  }), /不支持的 ASR provider/);
});

test("disabled capture never resolves devices, and invalid/unsupported configuration never starts recording", async (t) => {
  for (const [overrides, config] of [
    [{ resolveSource: async () => { throw new Error("unexpected device access"); } }, { enabled: false }],
    [{ platform: "win32" }, {}],
    [{}, { asr: { endpoint: "", model: "" } }],
  ]) {
    const h = harness(overrides, config);
    t.after(() => h.controller.dispose());
    await h.controller.start();
    assert.equal(h.captures.length, 0);
    assert.equal(h.controller.getState().enabled, false);
  }
});

test("PulseAudio JSON variants resolve monitors and never accept microphone sources", async () => {
  const devices = [
    { name: "output.monitor", monitor_source: "output" },
    { name: "other.monitor", monitor_of_sink: 7 },
    { name: "input", monitor_of_sink: 4294967295, monitor_source: "n/a" },
  ];
  const run = async (_command, args) => ({ stdout: args.includes("sources") ? JSON.stringify(devices) : "output\n" });
  assert.equal(await resolveMonitorSource("default", { run }), "output.monitor");
  assert.equal(await resolveMonitorSource("other.monitor", { run }), "other.monitor");
  await assert.rejects(resolveMonitorSource("input", { run }), /未找到音频输出监视源/);
});

test("stopping while source discovery is pending cannot start a stale recorder", async (t) => {
  const discovery = deferred();
  const h = harness({ resolveSource: () => discovery.promise });
  t.after(() => h.controller.dispose());
  const starting = h.controller.start();
  h.controller.stop();
  discovery.resolve("output.monitor");
  await starting;
  assert.equal(h.captures.length, 0);
  assert.equal(h.controller.getState().enabled, false);
});

test("TTS completion without playback does not discard unrelated audio", async (t) => {
  const h = harness();
  t.after(() => h.controller.dispose());
  await h.controller.start();
  await h.bus.publish(EVENTS.TTS_PLAYBACK_STATE, { playbackId: 999, state: "end" });
  h.captures[0].onData(utterance());
  await settle();
  assert.equal(h.bus.queueSize(EVENTS.PERCEPTION_OBSERVATION), 1);
});

test("audio observations share the screenshot queue, deduplicate and preserve source metadata", async (t) => {
  const h = harness();
  t.after(() => h.controller.dispose());
  const screenshot = { source: "screen", content: [{ type: "image", path: "screen.jpg" }] };
  h.bus.enqueue(EVENTS.PERCEPTION_OBSERVATION, screenshot);
  await h.controller.start();
  h.captures[0].onData(utterance());
  await settle();
  h.captures[0].onData(utterance());
  await settle();
  const observations = h.bus.takeAll(EVENTS.PERCEPTION_OBSERVATION);
  assert.equal(observations.length, 2);
  assert.equal(observations[0], screenshot);
  assert.equal(observations[1].content[0].type, "text");
  assert.equal(observations[1].metadata.modality, "audio");
  assert.equal(observations[1].role, "context");
  assert.equal(observations[1].metadata.device, "output.monitor");
  assert.ok(observations[1].expiresAt > Date.now());
  assert.ok(observations[1].content.every((part) => part.type === "text"));
});

test("overlapping TTS and cooldown suppress all self-output and discard partial pre-playback audio", async (t) => {
  const h = harness();
  t.after(() => h.controller.dispose());
  await h.controller.start();
  const capture = h.captures[0];
  capture.onData(pcm(300));
  await h.bus.publish(EVENTS.TTS_PLAYBACK_STATE, { playbackId: 1, state: "start" });
  capture.onData(utterance());
  await h.bus.publish(EVENTS.TTS_PLAYBACK_STATE, { playbackId: 2, state: "start" });
  await h.bus.publish(EVENTS.TTS_PLAYBACK_STATE, { playbackId: 1, state: "end" });
  await wait(120);
  capture.onData(utterance());
  await h.bus.publish(EVENTS.TTS_PLAYBACK_STATE, { playbackId: 2, state: "error" });
  capture.onData(utterance());
  await settle();
  assert.equal(h.bus.queueSize(EVENTS.PERCEPTION_OBSERVATION), 0);
  await wait(120);
  capture.onData(utterance());
  await settle();
  assert.equal(h.bus.queueSize(EVENTS.PERCEPTION_OBSERVATION), 1);
  assert.equal(h.controller.getState().status, "listening");
});

test("stop aborts transcription and flushes audio; late responses cannot pollute a restarted session", async (t) => {
  const old = deferred();
  let calls = 0;
  let oldSignal;
  const h = harness({ transcribe: async (_segment, _options, { signal }) => {
    if (++calls === 1) { oldSignal = signal; return old.promise; }
    return { text: "new session" };
  } });
  t.after(() => h.controller.dispose());
  await h.controller.start();
  h.captures[0].onData(utterance());
  h.bus.enqueue(EVENTS.PERCEPTION_OBSERVATION, { source: "audio-output" });
  h.bus.enqueue(EVENTS.PERCEPTION_OBSERVATION, { source: "screen" });
  h.controller.stop();
  assert.equal(oldSignal.aborted, true);
  assert.equal(h.captures[0].stopped, true);
  assert.equal(h.bus.queueSize(EVENTS.PERCEPTION_OBSERVATION), 1);
  await h.controller.start();
  h.captures[1].onData(utterance());
  old.resolve({ text: "old session" });
  await settle();
  assert.deepEqual(h.bus.takeAll(EVENTS.PERCEPTION_OBSERVATION).flatMap((item) => item.content || []).map((part) => part.text).filter(Boolean), ["new session"]);
});

test("a slow ASR keeps only the newest pending segments", async (t) => {
  const first = deferred();
  const peaks = [];
  const h = harness({ transcribe: async (segment) => {
    let peak = 0;
    for (let i = 0; i < segment.pcm.length; i += 2) peak = Math.max(peak, segment.pcm.readInt16LE(i));
    peaks.push(peak);
    if (peaks.length === 1) await first.promise;
    return { text: `speech ${peak}` };
  } });
  t.after(() => h.controller.dispose());
  await h.controller.start();
  for (let amplitude = 1000; amplitude <= 6000; amplitude += 1000) h.captures[0].onData(utterance(amplitude));
  first.resolve();
  await settle();
  assert.deepEqual(peaks, [1000, 4000, 5000, 6000]);
});

test("bounded audio enqueue retains screenshots and discards expired observations", () => {
  const bus = new MessageBus();
  const queue = EVENTS.PERCEPTION_OBSERVATION;
  const matches = (item) => item.source === "audio-output";
  bus.enqueue(queue, { source: "screen" });
  for (let i = 0; i < 30; i++) bus.enqueue(queue, { source: "audio-output", i, expiresAt: i === 29 ? 0 : Date.now() + 60000 }, { maxMatching: 20, matches });
  bus.discard(queue, (item) => matches(item) && item.expiresAt <= Date.now());
  const items = bus.takeAll(queue);
  assert.equal(items.length, 20);
  assert.equal(items[0].source, "screen");
  assert.equal(items[1].i, 10);
});

test("decision consumes audio-only batches and retries valid observations in chronological order", async () => {
  const bus = new MessageBus();
  const queue = EVENTS.PERCEPTION_OBSERVATION;
  const earlier = { source: "audio-output", content: [{ type: "text", text: "earlier" }], capturedAt: "2026-10-23T00:00:01Z" };
  const later = { source: "audio-output", content: [{ type: "text", text: "later" }], capturedAt: "2026-10-23T00:00:02Z" };
  bus.enqueue(queue, later);
  bus.enqueue(queue, { text: "expired", expiresAt: Date.now() - 1 });
  bus.enqueue(queue, earlier);
  let attempts = 0;
  let failure;
  let completed;
  bus.subscribe(EVENTS.PIPELINE_FAILED, (event) => { failure = event; });
  bus.subscribe(EVENTS.DECISION_COMPLETED, (event) => { completed = event; });
  const unsubscribe = registerDecisionModule(bus, { decide: async (items) => {
    assert.deepEqual(items, [earlier, later]);
    if (++attempts === 1) throw new Error("service temporarily unavailable");
    return { reply: "heard", summaries: { audio: "external speech" } };
  } });
  await bus.publish(EVENTS.DECISION_REQUESTED);
  assert.equal(failure.stage, "decision");
  assert.equal(failure.observationCount, 2);
  assert.equal(bus.queueSize(queue), 2);
  await bus.publish(EVENTS.DECISION_REQUESTED);
  assert.equal(bus.queueSize(queue), 0);
  assert.equal(completed.result.reply, "heard");
  unsubscribe();
});

test("request content supports both audio-only and mixed observations; audio summaries retain their source", () => {
  const audio = { source: "audio-output", role: "context", content: [{ type: "text", text: "a video narrator" }], capturedAt: "2026-10-23T00:00:01Z", metadata: { modality: "audio", durationMs: 1400 } };
  const audioBody = buildRequestBody({ model: "vision" }, "system", [audio]);
  assert.ok(audioBody.messages[1].content.every((part) => part.type === "text"));
  assert.ok(audioBody.messages[1].content.some((part) => /a video narrator/.test(part.text)));
  const mixed = buildRequestBody({ model: "vision" }, "system", [audio, { source: "screen", role: "context", content: [{ type: "image", uri: "data:image/jpeg;base64,abc" }] }]);
  assert.equal(mixed.messages[1].content.filter((part) => part.type === "image_url").length, 1);
  const parsed = extractChatPayload('{"response":"heard","audioSummary":"外部视频在讲解代码"}');
  assert.equal(parsed.audioSummary, "外部视频在讲解代码");
  assert.equal(extractChatPayload('{"response":"old format"}').audioSummary, null);
  const shortTerm = createShortTermStore();
  shortTerm.append({ reply: parsed.response, summaries: { audio: parsed.audioSummary } });
  assert.match(formatRecentDialogue(shortTerm.list()), /设备音频：外部视频/);
});
