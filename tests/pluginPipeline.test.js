const { createHistoryPlugin } = require("../electron/plugins/dialogueHistory");
const test = require("node:test");
const assert = require("node:assert/strict");
const { MessageBus } = require("../electron/architecture/messageBus");
const EVENTS = require("../electron/architecture/events");
const { createPerceptionService } = require("../electron/architecture/perceptionService");
const { createContextProviders } = require("../electron/architecture/contextProviders");
const { registerDecisionModule } = require("../electron/modules/decision");
const { createExecutionModule } = require("../electron/modules/execution");
const { createPluginHost } = require("../electron/pluginHost");
const { normalizeConfig } = require("../electron/config");
const menuHooks = require("../electron/menuHooks");
const { createMemoryPlugin } = require("../electron/plugins/memory");
const { createServiceRegistry } = require("../electron/architecture/serviceRegistry");
const { createConversation } = require("../electron/conversation");
const { createScreenPerceptionPlugin } = require("../electron/plugins/screenPerception");
const { getOptions: getAiOptions } = require("../electron/conversation/options");
const { getOptions: getScreenOptions } = require("../electron/plugins/screenPerception/options");
const { petPayload } = require("./helpers/petPayload");

const quiet = { info() {}, warn() {}, error() {} };
const settle = () => new Promise((resolve) => setImmediate(resolve));
const textInput = (text, extras = {}) => ({
  source: "custom-text-source", content: [{ type: "text", text }], ...extras,
});

test("generic observation ingress validates inputs before enqueue and preserves extension content", async () => {
  const bus = new MessageBus();
  const perception = createPerceptionService(bus);
  await assert.rejects(perception.submit({ content: [{ type: "text", text: "hello" }] }), /source/);
  await assert.rejects(perception.submit(textInput(" ")), /non-empty text/);
  await assert.rejects(perception.submit(textInput("hello", { role: "assistant" })), /role/);
  assert.equal(bus.queueSize(EVENTS.PERCEPTION_OBSERVATION), 0);
  const observation = await perception.submit({
    source: "custom-sensor", content: [{ type: "custom-metric", value: 42 }], metadata: { label: "sensor" },
  });
  assert.equal(observation.role, "context");
  assert.ok(observation.id);
  assert.ok(Number.isFinite(Date.parse(observation.capturedAt)));
  assert.equal(observation.content[0].value, 42);
  assert.equal(bus.takeAll(EVENTS.PERCEPTION_OBSERVATION)[0], observation);
});

test("retryable decision failures preserve the batch ahead of observations arriving during a request", async (t) => {
  const bus = new MessageBus();
  const perception = createPerceptionService(bus);
  const older = await perception.submit(textInput("older", { capturedAt: "2026-10-23T00:00:01Z" }));
  const newer = await perception.submit(textInput("newer", { capturedAt: "2026-10-23T00:00:02Z" }));
  await perception.submit(textInput("expired", { expiresAt: 0 }));
  let complete;
  const errors = [];
  bus.subscribe(EVENTS.PIPELINE_FAILED, (event) => errors.push(event));
  bus.subscribe(EVENTS.DECISION_COMPLETED, (event) => { complete = event; });
  let attempt = 0;
  let arriving;
  const unregister = registerDecisionModule(bus, { perception, decide: async (observations) => {
    if (++attempt === 1) {
      assert.deepEqual(observations, [older, newer]);
      arriving = await perception.submit(textInput("arrived"));
      throw Object.assign(new Error("service temporarily unavailable"), { status: 503 });
    }
    assert.deepEqual(observations, [older, newer, arriving]);
    return { reply: "recovered" };
  } });
  t.after(unregister);
  await bus.publish(EVENTS.DECISION_REQUESTED, { trigger: "manual" });
  assert.equal(errors[0].stage, "decision");
  assert.equal(errors[0].observationCount, 2);
  assert.equal(errors[0].retried, 2);
  assert.equal(errors[0].rejected, 0);
  assert.deepEqual(perception.getRejected(), []);
  assert.equal(bus.queueSize(EVENTS.PERCEPTION_OBSERVATION), 3);
  await bus.publish(EVENTS.DECISION_REQUESTED);
  assert.equal(complete.result.reply, "recovered");
  assert.equal(bus.queueSize(EVENTS.PERCEPTION_OBSERVATION), 0);
});

test("invalid decision results reject and release their batch while preserving new arrivals", async (t) => {
  const bus = new MessageBus();
  const perception = createPerceptionService(bus);
  const inputs = [await perception.submit(textInput("older")), await perception.submit(textInput("newer"))];
  const released = [];
  let failure;
  let completed;
  let arriving;
  t.after(bus.subscribe(EVENTS.PERCEPTION_OBSERVATION_RELEASED, (event) => released.push(event)));
  t.after(bus.subscribe(EVENTS.PIPELINE_FAILED, (event) => { failure = event; }));
  t.after(bus.subscribe(EVENTS.DECISION_COMPLETED, (event) => { completed = event; }));
  t.after(registerDecisionModule(bus, { perception, decide: async (observations) => {
    if (!arriving) {
      assert.deepEqual(observations, inputs);
      arriving = await perception.submit(textInput("arrived"));
      return { reply: "" };
    }
    assert.deepEqual(observations, [arriving]);
    return { reply: "new message answered" };
  } }));
  await bus.publish(EVENTS.DECISION_REQUESTED);
  assert.equal(failure.retried, 0);
  assert.equal(failure.rejected, 2);
  assert.equal(completed, undefined);
  assert.deepEqual(perception.getRejected().map(({ observation }) => observation.id), inputs.map(({ id }) => id));
  assert.deepEqual(released.map(({ observation, reason }) => ({ id: observation.id, reason })),
    inputs.map(({ id }) => ({ id, reason: "failed" })));
  assert.equal(perception.pendingCount(), 1);
  await bus.publish(EVENTS.DECISION_REQUESTED);
  assert.equal(completed.result.reply, "new message answered");
  assert.equal(perception.pendingCount(), 0);
  assert.equal(released.at(-1).observation.id, arriving.id);
  assert.equal(released.at(-1).reason, "completed");
});

function chatHarness(response) {
  const requests = [];
  const config = { conversation: { enabled: true,
    ai: { endpoint: "https://model.example/v1", apiKey: "test-key", model: "test-model" },
    character: { name: "Test Pet" },
  } };
  const contexts = createContextProviders({ logger: quiet });
  const chat = createConversation({
    contextProviders: contexts,
    getConfig: () => config, getExpressions: () => ["neutral", "smile"],
    configureProxy: async () => {}, writeLog: () => {}, logger: quiet,
    encodeImage: (imagePath) => { assert.equal(imagePath, "/virtual/image.jpg"); return "encoded"; },
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      requests.push({ url, body });
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: {
        content: JSON.stringify(petPayload(typeof response === "function" ? response(body) : response)),
      } }] }) };
    },
  });
  return { chat, requests, contexts };
}

test("AI keeps system and memory snapshots stable without appending changed retrieval to current input", async () => {
  const h = chatHarness({ response: "reply", expression: "neutral" });
  const observation = { id: "input", source: "manual", role: "user",
    content: [{ type: "text", text: "本轮用户问题" }, { type: "image", path: "/virtual/image.jpg" }] };
  const context = [
    { id: "memory:long-term-memory", title: "长期记忆", text: "用户偏好 TypeScript" },
    { id: "memory:project", title: "项目状态", text: "正在处理发布任务" },
    { id: "memory:recent-dialogue", title: "近期对话", text: "用户：测试已经通过" },
    { id: "sensor:context", title: "其它上下文", text: "正在使用文档窗口" },
  ];
  await h.chat.decideFromObservations([observation], { context });
  await h.chat.decideFromObservations([observation], {
    context: context.map((block) => ({ ...block, text: `更新后的${block.text}` })),
  });
  await h.chat.decideFromObservations([observation]);
  const system = h.requests[0].body.messages[0];
  assert.equal(system.role, "system");
  assert.match(system.content, /记忆使用说明/);
  assert.match(system.content, /role=user 表示用户直接对你说的话，请优先回应/);
  assert.match(system.content, /role=context 表示补充观察/);
  assert.match(system.content, /只输出一个 JSON 对象/);
  for (const request of h.requests) assert.deepEqual(request.body.messages[0], system);
  for (const block of context) assert.ok(!system.content.includes(block.text));
  const user = h.requests[0].body.messages[1];
  assert.equal(user.role, "user");
  const background = user.content.find(({ text }) => text?.startsWith("# 补充上下文"));
  for (const block of context.filter(({ id }) => !id.endsWith("recent-dialogue"))) {
    assert.ok(background.text.includes(block.title));
    assert.ok(background.text.includes(block.text));
  }
  assert.ok(!background.text.includes("测试已经通过"));
  const current = h.requests[0].body.messages.at(-1);
  assert.match(current.content[0].text, /当前时间.*本轮输入 1 条/);
  assert.ok(!JSON.stringify(current.content).includes("请优先回应"));
  assert.ok(!JSON.stringify(current.content).includes("只返回 JSON"));
  assert.ok(current.content.some(({ text }) => text?.includes("本轮用户问题")));
  assert.equal(current.content.at(-1).image_url.url, "data:image/jpeg;base64,encoded");
  assert.deepEqual(h.requests[1].body.messages[1], user);
  assert.ok(!h.requests[1].body.messages.at(-1).content.some(({ text }) => text?.includes("# 补充上下文")));
  assert.ok(!JSON.stringify(h.requests[1].body.messages).includes("更新后的用户偏好 TypeScript"));
  assert.deepEqual(h.requests[2].body.messages[1], user);
  assert.ok(!h.requests[2].body.messages.at(-1).content.some(({ text }) => text?.includes("# 补充上下文")));
});

test("text-only manual and audio inputs reach output and memory without image encoding", async (t) => {
  const h = chatHarness((body) => ({ response: "heard", expression: "smile",
    audioSummary: JSON.stringify(body.messages.at(-1)).includes("video narrator") ? "external video" : "" }));
  const bus = new MessageBus();
  const perception = createPerceptionService(bus);
  const memory = createMemoryPlugin({
    bus, logger: quiet,
    config: { get: () => ({ plugins: [{ name: "memory", enabled: true,
      longTerm: { enabled: false } }] }) },
    services: createServiceRegistry(),
    decisionContext: { register: (provide) => h.contexts.register("memory", provide) },
  });
  t.after(() => memory.dispose());
  const history = [];
  const historyPlugin = createHistoryPlugin({
    bus, logger: quiet, services: createServiceRegistry(), config: { get: () => ({}) },
    menu: { register: () => () => {} }, ipc: { handle: () => () => {} },
  }, { repository: { append: (entry) => history.push(entry), endSessions() {} } });
  t.after(() => historyPlugin.dispose());
  const bubbles = [];
  const speech = [];
  const execution = createExecutionModule(bus, { sendBubble: (bubble) => bubbles.push(bubble) });
  t.after(() => execution.dispose());
  t.after(registerDecisionModule(bus, { decide: (observations) => h.chat.decideFromObservations(observations),
    presentDecision: execution.presentDecision }));
  bus.subscribe(EVENTS.SPEECH_OUTPUT_REQUESTED, (event) => speech.push(event));
  await perception.submit(textInput("hello pet", { role: "user" }));
  await perception.submit(textInput("video narrator", { source: "audio-output", metadata: { modality: "audio" } }));
  await bus.publish(EVENTS.DECISION_REQUESTED, { trigger: "manual-input" });
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].url, "https://model.example/v1/chat/completions");
  assert.ok(h.requests[0].body.messages[1].content.every(({ type }) => type === "text"));
  assert.match(JSON.stringify(h.requests[0].body), /role=user/);
  assert.match(JSON.stringify(h.requests[0].body), /video narrator/);
  const turns = memory.getState().turns;
  assert.equal(turns.length, 1);
  assert.equal(turns[0].userMessage, "hello pet");
  assert.equal(turns[0].summaries.screen, "");
  assert.equal(turns[0].summaries.audio, "external video");
  assert.equal(history[0].userSaid, "hello pet");
  assert.deepEqual(bubbles.map(({ type }) => type), ["thinking", "say"]);
  assert.equal(speech[0].text, "heard");
  await perception.submit(textInput("continue", { role: "user" }));
  await bus.publish(EVENTS.DECISION_REQUESTED);
  assert.deepEqual(h.requests[1].body.messages[0], h.requests[0].body.messages[0]);
  const historyText = JSON.stringify(h.requests[1].body.messages.slice(1, -1));
  assert.match(historyText, /hello pet/);
  assert.match(historyText, /设备音频：external video/);
  assert.ok(h.requests[1].body.messages.some(({ role }) => role === "assistant"));
});

test("AI provider accepts images from new sources and rejects unsupported parts before calling the model", async () => {
  const h = chatHarness({ response: "image seen", screenSummary: "a picture" });
  const image = { source: "custom-image-source", content: [{ type: "image", path: "/virtual/image.jpg" }] };
  const result = await h.chat.decideFromObservations([image]);
  assert.equal(h.requests[0].body.messages[1].content.find(({ type }) => type === "image_url").image_url.url,
    "data:image/jpeg;base64,encoded");
  assert.deepEqual(result.summaries, { screen: "a picture", audio: "" });
  await assert.rejects(h.chat.decideFromObservations([{
    source: "new-sensor", content: [{ type: "custom-metric", value: 42 }],
  }]), /不支持内容类型/);
  assert.equal(h.requests.length, 1);
});

function screenHarness(overrides = {}) {
  const bus = new MessageBus();
  const perception = createPerceptionService(bus);
  const timers = new Map();
  const removed = [];
  let nextTimer = 0;
  let getMenu;
  let captures = 0;
  let comparisons = 0;
  const context = {
    bus, perception, logger: quiet,
    config: { get: () => ({ plugins: [{ name: "screen-perception", enabled: true, interval_ms: 50 }] }) },
    screen: { captureFullscreen: async () => ({ path: `/virtual/${++captures}.jpg`, filename: `${captures}.jpg` }) },
    menu: { register: (provider) => { getMenu = provider; return () => { getMenu = null; }; } },
    ...overrides,
  };
  const dependencies = {
    detector: { reset() {}, compareWithPrevious: () => ({ changed: ++comparisons === 1, distance: 0, threshold: 4 }) },
    setInterval: (callback) => { timers.set(++nextTimer, callback); return nextTimer; },
    clearInterval: (id) => timers.delete(id),
    removeFile: (imagePath) => removed.push(imagePath),
  };
  const plugin = createScreenPerceptionPlugin(context, dependencies);
  return { bus, perception, plugin, timers, removed, getMenu: () => getMenu?.(),
    getCaptures: () => captures, getComparisons: () => comparisons };
}

test("screen plugin owns its cadence, skips unchanged images and keeps manual capture independent", async (t) => {
  const h = screenHarness();
  t.after(() => h.plugin.dispose());
  h.plugin.start();
  await settle();
  assert.equal(h.timers.size, 1);
  assert.equal(h.bus.queueSize(EVENTS.PERCEPTION_OBSERVATION), 1);
  const observation = h.bus.takeAll(EVENTS.PERCEPTION_OBSERVATION)[0];
  assert.equal(observation.content[0].type, "image");
  assert.equal(observation.metadata.modality, "screen");
  h.timers.values().next().value();
  await settle();
  assert.equal(h.bus.queueSize(EVENTS.PERCEPTION_OBSERVATION), 0);
  assert.deepEqual(h.removed, ["/virtual/2.jpg"]);
  const comparisons = h.getComparisons();
  assert.equal(h.getMenu(), undefined);
  await h.perception.capture("screen", { trigger: "manual-capture", enqueue: false });
  assert.equal(h.getComparisons(), comparisons);
  assert.equal(h.getCaptures(), 3);
  assert.equal(h.bus.queueSize(EVENTS.PERCEPTION_OBSERVATION), 0);
  h.plugin.start();
  assert.equal(h.timers.size, 1);
  h.plugin.stop();
  assert.equal(h.timers.size, 0);
});

test("stopping a visual source drops an unfinished periodic capture and disposal removes its registrations", async () => {
  let finishCapture;
  const h = screenHarness({ screen: { captureFullscreen: () => new Promise((resolve) => { finishCapture = resolve; }) } });
  h.plugin.start();
  await settle();
  h.plugin.stop();
  finishCapture({ path: "/virtual/stale.jpg" });
  await settle();
  assert.equal(h.bus.queueSize(EVENTS.PERCEPTION_OBSERVATION), 0);
  assert.deepEqual(h.removed, ["/virtual/stale.jpg"]);
  h.plugin.dispose();
  assert.equal(h.perception.hasSource("screen"), false);
  assert.equal(h.getMenu(), undefined);
  await assert.rejects(h.perception.capture("screen"), /未加载/);
});

test("host registers context extensions and menus but cannot replace the core decision", async () => {
  const bus = new MessageBus();
  const contexts = createContextProviders({ logger: quiet });
  const host = createPluginHost({
    bus, contextProviders: contexts, getConfig: () => ({}), logger: quiet,
    definitions: [{ name: "test-extension", shouldLoad: () => true, load: () => ({ activate(context) {
      assert.equal(context.decisions.register, undefined);
      context.decisionContext.register(() => [{ id: "extra", text: "plugin context" }]);
      context.menu.register(() => [{ label: "test extension" }]);
      return {};
    } }) }],
  });
  await host.activate();
  assert.equal((await contexts.collect({}))[0].text, "plugin context");
  assert.ok(menuHooks.getMenuContributions().some(({ label }) => label === "test extension"));
  await host.dispose();
  assert.deepEqual(await contexts.collect({}), []);
  assert.ok(!menuHooks.getMenuContributions().some(({ label }) => label === "test extension"));
});

test("conversation options come from the core and plugin options from their named configuration", () => {
  const config = { conversation: { ai: { model: "model", apiKey: "test-key" }, character: { name: "pet" } }, plugins: [
    { name: "screen-perception", enabled: false, interval_ms: 200, changeDetect: { threshold: 2 } },
  ] };
  assert.equal(getAiOptions(config).ai.model, "model");
  assert.equal(getAiOptions(config).ai.apiKey, "test-key");
  assert.equal(getAiOptions(config).character.name, "pet");
  assert.deepEqual(getScreenOptions(config), {
    enabled: false, intervalMs: 200, observationTtlMs: 60000, changeDetect: { threshold: 2 },
  });
  assert.equal(getAiOptions({}).enabled, true);
  assert.equal(getAiOptions({}).ai.timeoutMs, 120000);
});

test("the core owns AI while the plugin manifest retains manual screenshot capabilities", async (t) => {
  const ai = { endpoint: "https://model.example/v1", apiKey: "test-key", model: "test-model" };
  const config = normalizeConfig({ conversation: { ai }, plugins: [{ name: "screen-perception", enabled: false }] });
  const bus = new MessageBus();
  const perception = createPerceptionService(bus);
  const core = createConversation({ getConfig: () => config, logger: quiet, configureProxy: async () => {},
    writeLog() {}, fetchImpl: async () => ({ ok: true, status: 200,
      text: async () => '{"choices":[{"message":{"content":"core text"}}]}' }) });
  t.after(() => core.dispose());
  const services = createServiceRegistry();
  let captures = 0;
  const host = createPluginHost({ bus, perception, model: core.model, services, getConfig: () => config, logger: quiet,
    screen: { captureFullscreen: async () => {
      captures++;
      return { path: "/virtual/manual.jpg", filename: "manual.jpg" };
    } },
  });
  t.after(() => host.dispose());
  await host.activate(); await host.start();
  assert.equal(host.getState()["ai-conversation"], undefined);
  assert.equal(services.get("ai-conversation.text"), undefined);
  assert.ok(perception.hasSource("screen"));
  assert.equal(captures, 0);
  assert.equal((await perception.capture("screen", { enqueue: false })).path, "/virtual/manual.jpg");
  assert.equal(captures, 1);
  assert.equal(perception.pendingCount(), 0);
  await host.dispose();
  assert.equal(perception.hasSource("screen"), false);
  assert.equal(await core.generateText([{ role: "user", content: "hello" }]), "core text");
});

test("completion records memory and history before output even when execution is created first", async (t) => {
  const bus = new MessageBus({ logger: quiet });
  const perception = createPerceptionService(bus);
  const order = [];
  const history = [];
  let memory;
  const execution = createExecutionModule(bus, { sendBubble(bubble) {
    if (bubble.type !== "say") return;
    assert.equal(memory.getState().turns[0].reply, "reply");
    assert.equal(history[0].petSaid, "reply");
    order.push("bubble");
  } });
  t.after(() => execution.dispose());
  bus.subscribe(EVENTS.DECISION_COMPLETED, () => { throw new Error("optional observer failed"); });
  memory = createMemoryPlugin({ bus, logger: quiet, services: createServiceRegistry(),
    config: { get: () => ({ plugins: [{ name: "memory", longTerm: { enabled: false } }] }) },
    decisionContext: { register: () => () => {} },
  });
  t.after(() => memory.dispose());
  const historyPlugin = createHistoryPlugin({ bus, logger: quiet, services: createServiceRegistry(),
    config: { get: () => ({}) }, menu: { register: () => () => {} }, ipc: { handle: () => () => {} },
  }, { repository: { append: (entry) => history.push(entry), endSessions() {} } });
  t.after(() => historyPlugin.dispose());
  let releaseRecorder;
  const recorder = new Promise((resolve) => { releaseRecorder = resolve; });
  bus.subscribe(EVENTS.DECISION_COMPLETED, async () => {
    order.push("recording");
    await recorder;
    order.push("recorded");
  });
  bus.subscribe(EVENTS.SPEECH_OUTPUT_REQUESTED, () => order.push("speech"));
  bus.subscribe(EVENTS.PERCEPTION_OBSERVATION_RELEASED, () => order.push("released"));
  t.after(registerDecisionModule(bus, { perception, presentDecision: execution.presentDecision,
    decide: async () => ({ reply: "reply" }) }));
  await perception.submit(textInput("hello", { role: "user" }));
  const decision = bus.publish(EVENTS.DECISION_REQUESTED);
  await settle();
  assert.deepEqual(order, ["recording"]);
  releaseRecorder();
  await decision;
  assert.deepEqual(order, ["recording", "recorded", "bubble", "speech", "released"]);
});

test("speech failure releases a completed batch and never repeats its decision or recordings", async (t) => {
  const bus = new MessageBus({ logger: quiet });
  const perception = createPerceptionService(bus);
  const bubbles = [], failures = [], released = [], recorded = [];
  let calls = 0;
  const execution = createExecutionModule(bus, { sendBubble: (bubble) => bubbles.push(bubble) });
  t.after(() => execution.dispose());
  bus.subscribe(EVENTS.DECISION_COMPLETED, (event) => recorded.push(event));
  bus.subscribe(EVENTS.SPEECH_OUTPUT_REQUESTED, () => { throw new Error("speaker failed"); });
  bus.subscribe(EVENTS.PIPELINE_FAILED, (event) => failures.push(event));
  bus.subscribe(EVENTS.PERCEPTION_OBSERVATION_RELEASED, (event) => released.push(event));
  t.after(registerDecisionModule(bus, { perception, presentDecision: execution.presentDecision,
    decide: async () => { calls++; return { reply: "already recorded" }; } }));
  await perception.submit(textInput("hello"));
  await bus.publish(EVENTS.DECISION_REQUESTED);
  assert.equal(recorded.length, 1);
  assert.equal(failures[0].stage, "execution");
  assert.equal(released.length, 1);
  assert.equal(released[0].reason, "completed");
  assert.equal(perception.pendingCount(), 0);
  assert.deepEqual(bubbles.map((bubble) => bubble.type), ["thinking", "say", "error"]);
  await bus.publish(EVENTS.DECISION_REQUESTED);
  assert.equal(calls, 1);
  assert.equal(recorded.length, 1);
});

test("practice-only memory is blocked before activation when its storage is missing", async (t) => {
  const config = normalizeConfig({ plugins: [{ name: "memory", shortTerm: { enabled: false },
    longTerm: { enabled: false }, work: { enabled: false }, practice: { enabled: true } }] });
  const host = createPluginHost({ bus: new MessageBus({ logger: quiet }), logger: quiet,
    getConfig: () => config, definitions: [require("../electron/plugins/memory/definition")] });
  t.after(() => host.dispose());
  await host.activate();
  assert.equal(host.getState().memory.status, "blocked");
  assert.match(host.getState().memory.reason, /storage-sqlite.database/);
});
