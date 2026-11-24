const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { normalizeConfig } = require("../electron/config");
const { normalizeOptions } = require("../electron/plugins/tts/options");
const { createCompatibleTts } = require("../electron/plugins/tts/compatibleTts");
const { createDockerService } = require("../electron/plugins/tts/dockerService");
const { createTtsPlugin } = require("../electron/plugins/tts");
const { MessageBus } = require("../electron/architecture/messageBus");
const EVENTS = require("../electron/architecture/events");

const quiet = { info() {}, error() {}, warn() {} };
const tick = () => new Promise(resolve => setImmediate(resolve));
const json = body => Response.json(body);
const cloud = overrides => normalizeOptions({ provider: "openai-compatible", apiBase: "https://tts.example/v1/", model: "speech-model", voice: "role", ...overrides });
const local = overrides => normalizeOptions({ provider: "openai-compatible", service: { type: "docker" }, refAudio: "reference.wav", promptText: "参考录音。", ...overrides });
function wav() {
  const bytes = Buffer.alloc(48);
  bytes.write("RIFF"); bytes.writeUInt32LE(40, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(24000, 24); bytes.writeUInt32LE(48000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write("data", 36); bytes.writeUInt32LE(4, 40);
  return bytes;
}
function reference(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pet-tts-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "reference.wav");
  fs.writeFileSync(file, wav());
  return file;
}
function fakeDocker() {
  const calls = [];
  let container = null;
  let image = false;
  const run = async (args, { signal } = {}) => {
    signal?.throwIfAborted();
    calls.push(args);
    if (args[0] === "info") return "28";
    if (args[0] === "ps") return container ? "container-id" : "";
    if (args[0] === "inspect") return JSON.stringify([container]);
    if (args[0] === "image") return image ? "image-id" : "";
    if (args[0] === "pull") { image = true; return "pulled"; }
    if (args[0] === "run") {
      const labels = {};
      args.forEach((arg, i) => { if (arg === "--label") { const [key, value] = args[i + 1].split("="); labels[key] = value; } });
      container = { Config: { Labels: labels }, State: { Running: true } };
      return "container-id";
    }
    if (args[0] === "stop") { container.State.Running = false; return "stopped"; }
    if (args[0] === "start") { container.State.Running = true; return "started"; }
    if (args[0] === "rm") { container = null; return "removed"; }
    if (args[0] === "logs") return "model error";
    throw new Error(`Unexpected docker command: ${args}`);
  };
  return { run, calls, container: () => container, setContainer: value => { container = value; } };
}
const healthy = async () => json({ status: "healthy", gpu: { model_loaded: true } });

test("TTS cloud and managed-local configurations normalize immutably and reject invalid deployment settings", () => {
  for (const plugin of [cloud(), local()]) {
    const config = normalizeConfig({ plugins: [{ name: "tts", ...plugin }] });
    assert.deepEqual(normalizeConfig(config), config);
    assert.ok(Object.isFrozen(config.plugins[0].service));
  }
  assert.equal(local().apiBase, "http://127.0.0.1:8188/v1");
  assert.equal(local().service.image, "neosun/cosyvoice:v3.4.0");
  for (const changes of [{ service: [] }, { service: { type: "bad" } },
    { service: { type: "docker", port: 80 } }, { service: { type: "docker", gpu: "yes" } },
    { service: { type: "docker", preset: "unknown" } }, { apiBase: "file:///tmp/tts" },
    { responseFormat: "mp3" }, { voice: 42 }, { speed: 0 }, { timeoutMs: -1 }]) {
    assert.throws(() => cloud(changes), /tts/);
  }
  assert.throws(() => cloud({ voice: "" }), /voice/);
  assert.throws(() => cloud({ model: "" }), /model/);
  assert.throws(() => normalizeOptions({ provider: "system", service: { type: "docker" } }), /provider/);
});

test("cloud speech sends credentials and voice to the API, writes WAV and never provisions Docker", async (t) => {
  const calls = [];
  const backend = createCompatibleTts({ logger: quiet,
    dockerService: { ensure() { assert.fail("cloud must not provision Docker"); }, async stop() {} },
    fetchImpl: async (url, init) => { calls.push({ url, init }); return new Response(wav()); },
  });
  t.after(() => backend.shutdown());
  const output = await backend.synthesizeToFile("你好", cloud({ apiKey: "secret", speed: 1.2 }));
  t.after(() => fs.rmSync(output.path, { force: true }));
  assert.equal(calls[0].url, "https://tts.example/v1/audio/speech");
  assert.equal(calls[0].init.headers.Authorization, "Bearer secret");
  assert.deepEqual(JSON.parse(calls[0].init.body), { model: "speech-model", input: "你好", voice: "role", response_format: "wav", speed: 1.2 });
  assert.deepEqual(fs.readFileSync(output.path), wav());
});

test("HTTP failures and JSON disguised as audio never become playback files and do not expose credentials", async (t) => {
  for (const response of [new Response("secret", { status: 401 }), json({ error: "bad" })]) {
    const backend = createCompatibleTts({ logger: quiet, fetchImpl: async () => response });
    t.after(() => backend.shutdown());
    await assert.rejects(backend.synthesizeToFile("hello", cloud({ apiKey: "secret" })), error => {
      assert.doesNotMatch(error.message, /secret/);
      assert.match(error.message, /HTTP 401|WAV/);
      return true;
    });
  }
});

test("local setup registers a reference once, reuses its persisted voice after restart and sends instruction control", async (t) => {
  const options = local({ refAudio: reference(t), instruct: "开心地说" });
  let saved = null;
  let creations = 0;
  let ensures = 0;
  const fetchImpl = async (url, init) => {
    if (url.endsWith("/voices/custom")) return json({ voices: saved ? [saved] : [] });
    if (url.endsWith("/voices/create")) {
      creations++;
      assert.equal(init.body.get("text"), "参考录音。");
      assert.equal(init.body.get("audio").size, wav().length);
      saved = { id: "cloned-role", name: init.body.get("name") };
      return json({ success: true, voice_id: saved.id });
    }
    assert.equal(JSON.parse(init.body).voice, "cloned-role");
    assert.equal(JSON.parse(init.body).instruct, "开心地说");
    return new Response(wav());
  };
  for (let i = 0; i < 2; i++) {
    const backend = createCompatibleTts({ logger: quiet, fetchImpl,
      dockerService: { async ensure() { ensures++; return options.apiBase; }, async stop() {} },
    });
    await Promise.all([backend.start(options), backend.start(options)]);
    const output = await backend.synthesizeToFile("你好", options);
    fs.unlinkSync(output.path);
    assert.equal(backend.getState().phase, "ready");
    await backend.shutdown();
  }
  assert.equal(creations, 1);
  assert.equal(ensures, 2);
});

test("canceling an utterance during image preparation leaves setup available for the next utterance", async () => {
  let release;
  let setupSignal;
  const options = local({ voice: "known-role" });
  const backend = createCompatibleTts({ logger: quiet,
    dockerService: { ensure(service, signal) { setupSignal = signal; return new Promise(resolve => { release = resolve; }); }, async stop() {} },
    fetchImpl: async url => url.includes("/voices/") ? json({ id: "known-role" }) : new Response(wav()),
  });
  const controller = new AbortController();
  const pending = backend.synthesizeToFile("old", { ...options, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(setupSignal.aborted, false);
  release(options.apiBase);
  const output = await backend.synthesizeToFile("new", options);
  fs.unlinkSync(output.path);
  await backend.shutdown();
});

test("invalid reference audio fails before pulling images or starting the local runtime", async (t) => {
  const backend = createCompatibleTts({ logger: quiet,
    dockerService: { ensure() { assert.fail("invalid reference must not start Docker"); }, async stop() {} },
  });
  t.after(() => backend.shutdown());
  await assert.rejects(backend.start(local({ refAudio: path.join(os.tmpdir(), `missing-${process.pid}.wav`) })), /无法读取/);
  assert.equal(backend.getState().phase, "error");
});

test("shutdown aborts model preparation, cleans Docker, and supports a later restart", async () => {
  let stopped = 0;
  let attempts = 0;
  const options = local({ voice: "known-role" });
  const backend = createCompatibleTts({ logger: quiet, fetchImpl: async () => json({}),
    dockerService: { ensure(service, signal) {
      if (++attempts > 1) return Promise.resolve(options.apiBase);
      return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    }, async stop() { stopped++; } },
  });
  const starting = backend.start(options);
  const rejected = assert.rejects(starting, { name: "AbortError" });
  await backend.shutdown();
  await rejected;
  assert.equal(stopped, 1);
  assert.equal(backend.getState().phase, "idle");
  await backend.start(options);
  assert.equal(backend.getState().phase, "ready");
  await backend.shutdown();
});

test("request timeout covers synthesis and allows retry after a failed request", async (t) => {
  let attempts = 0;
  const backend = createCompatibleTts({ logger: quiet, fetchImpl: async (url, { signal }) => {
    if (++attempts > 1) return new Response(wav());
    return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  } });
  t.after(() => backend.shutdown());
  // Keep the event loop alive while AbortSignal.timeout's unref'ed timer expires.
  const keepAlive = setInterval(() => {}, 100);
  try { await assert.rejects(backend.synthesizeToFile("hello", { ...cloud(), timeoutMs: 20 }), { name: "TimeoutError" }); }
  finally { clearInterval(keepAlive); }
  const output = await backend.synthesizeToFile("retry", cloud());
  fs.unlinkSync(output.path);
});

test("Docker bootstrap pulls missing images, binds loopback, persists data, reuses containers and stops without deleting data", async () => {
  const fake = fakeDocker();
  const service = createDockerService({ run: fake.run, fetchImpl: healthy, logger: quiet });
  const options = local().service;
  const signal = new AbortController().signal;
  assert.equal(await service.ensure(options, signal), "http://127.0.0.1:8188/v1");
  assert.ok(fake.calls.some(args => args[0] === "pull"));
  const args = fake.calls.find(args => args[0] === "run");
  assert.ok(args.includes("127.0.0.1:8188:8188"));
  assert.ok(args.includes("mylive2dpet-cosyvoice-8188-data:/data"));
  assert.ok(args.includes("--gpus"));
  assert.deepEqual(args.slice(-5, -1), ["neosun/cosyvoice:v3.4.0", "python", "-u", "-c"]);
  assert.match(args.at(-1), /prepare_resources/);
  await service.stop();
  await service.ensure(options, signal);
  assert.equal(fake.calls.filter(args => args[0] === "run").length, 1);
  assert.equal(fake.calls.filter(args => args[0] === "start").length, 1);
  await service.stop();
  assert.equal(fake.calls.filter(args => args[0] === "rm" || args[0] === "volume").length, 0);
});

test("Docker refuses unrelated containers and will not stop a container whose ownership has changed", async () => {
  const fake = fakeDocker();
  const service = createDockerService({ run: fake.run, fetchImpl: healthy, logger: quiet });
  fake.setContainer({ Config: { Labels: {} }, State: { Running: true } });
  await assert.rejects(service.ensure(local().service, new AbortController().signal), /占用/);
  await service.stop();
  assert.equal(fake.calls.some(args => ["rm", "stop", "start"].includes(args[0])), false);
  fake.setContainer(null);
  await service.ensure(local().service, new AbortController().signal);
  fake.container().Config.Labels = {};
  await service.stop();
  assert.equal(fake.calls.some(args => args[0] === "stop"), false);
});

test("Docker configuration changes replace only the owned container and preserve its data volume", async () => {
  const fake = fakeDocker();
  const service = createDockerService({ run: fake.run, fetchImpl: healthy, logger: quiet });
  const signal = new AbortController().signal;
  await service.ensure(local().service, signal);
  await service.ensure({ ...local().service, gpu: false }, signal);
  assert.equal(fake.calls.filter(args => args[0] === "rm").length, 1);
  const runs = fake.calls.filter(args => args[0] === "run");
  assert.equal(runs[1].includes("--gpus"), false);
  assert.equal(runs[0][runs[0].indexOf("-v") + 1], runs[1][runs[1].indexOf("-v") + 1]);
  await service.stop();
});

test("Docker waits for a loaded model and reports container exit instead of treating a listening endpoint as ready", async () => {
  const fake = fakeDocker();
  let polls = 0;
  const service = createDockerService({ run: fake.run, logger: quiet,
    fetchImpl: async () => { polls++; return json({ status: "healthy", gpu: { model_loaded: false } }); },
    wait: async () => { fake.container().State.Running = false; },
  });
  await assert.rejects(service.ensure(local().service, new AbortController().signal), /model error/);
  assert.equal(polls, 1);
  await service.stop();
});

test("shutdown waits for an issued Docker create so cancellation cannot leave a late-started container", async () => {
  const fake = fakeDocker();
  let created;
  let finishCreate;
  const creationIssued = new Promise(resolve => { created = resolve; });
  const creationDone = new Promise(resolve => { finishCreate = resolve; });
  const service = createDockerService({ logger: quiet, fetchImpl: healthy,
    run: async (args, options) => {
      const result = await fake.run(args, options);
      if (args[0] === "run") {
        assert.equal(options.signal, undefined);
        created();
        await creationDone;
      }
      return result;
    },
  });
  const controller = new AbortController();
  const starting = service.ensure(local().service, controller.signal);
  const rejected = assert.rejects(starting, { name: "AbortError" });
  await creationIssued;
  controller.abort();
  finishCreate();
  await rejected;
  await service.stop();
  assert.equal(fake.container().State.Running, false);
});

test("plugin warms the compatible backend, cancels stale speech and shuts down on disposal", async () => {
  const bus = new MessageBus();
  const backend = createCompatibleTts({ logger: quiet, fetchImpl: async (url, { signal }) => {
    if (signal.aborted) throw signal.reason;
    return new Response(wav());
  } });
  const played = [];
  const states = [];
  bus.subscribe(EVENTS.SPEECH_OUTPUT_STATE, state => states.push(state.state));
  const plugin = createTtsPlugin({ platform: "linux", logger: quiet, bus,
    config: { get: () => ({ plugins: [{ name: "tts", enabled: true, ...cloud() }] }) },
    menu: { register: () => () => {}, refresh() {} },
  }, { compatible: backend, player: { async stop() {}, async play(file, options) {
    played.push(fs.readFileSync(file)); options.onStart();
  } } });
  plugin.start();
  await bus.publish(EVENTS.SPEECH_OUTPUT_REQUESTED, { text: "old" });
  await bus.publish(EVENTS.SPEECH_OUTPUT_REQUESTED, { text: "new" });
  await plugin.whenIdle();
  assert.ok(played.length >= 1);
  assert.equal(played.at(-1).toString("ascii", 0, 4), "RIFF");
  assert.equal(states.at(-1), "end");
  await plugin.dispose();
  assert.equal(plugin.getState().service.phase, "idle");
  await tick();
});
