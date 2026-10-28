const { createHistoryPlugin } = require("../electron/plugins/dialogueHistory");
const test = require("node:test");
const assert = require("node:assert/strict");
const { MessageBus } = require("../electron/architecture/messageBus");
const EVENTS = require("../electron/architecture/events");
const { createPerceptionService } = require("../electron/architecture/perceptionService");
const { createDecisionProviders } = require("../electron/architecture/decisionProviders");
const { registerDecisionModule } = require("../electron/modules/decision");
const { registerExecutionModule } = require("../electron/modules/execution");
const { createPluginHost } = require("../electron/pluginHost");
const menuHooks = require("../electron/menuHooks");
const { createMemoryPlugin } = require("../electron/plugins/memory");
const { createServiceRegistry } = require("../electron/architecture/serviceRegistry");
const { createChatService } = require("../electron/plugins/aiConversation/chat");
const { createScreenPerceptionPlugin } = require("../electron/plugins/screenPerception");
const { getOptions: getAiOptions } = require("../electron/plugins/aiConversation/options");
const { getOptions: getScreenOptions } = require("../electron/plugins/screenPerception/options");

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

test("provider selection runs exactly one implementation and unregister makes it unavailable", async () => {
  let selected = "first";
  const providers = createDecisionProviders(() => selected);
  const calls = [];
  providers.register("first", async () => { calls.push("first"); return { reply: "one" }; });
  const unregister = providers.register("second", async () => { calls.push("second"); return { reply: "two" }; });
  await providers.decide({ observations: [] });
  selected = "second";
  assert.equal((await providers.decide({ observations: [] })).reply, "two");
  assert.deepEqual(calls, ["first", "second"]);
  assert.throws(() => providers.register("first", () => {}), /已注册/);
  unregister();
  await assert.rejects(providers.decide({ observations: [] }), /未加载: second/);
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
  const config = { plugins: [{ name: "ai-conversation", enabled: true,
    ai: { endpoint: "https://model.example/v1", apiKey: "test-key", model: "test-model" },
    character: { name: "Test Pet" },
  }] };
  const chat = createChatService({
    getConfig: () => config, getExpressions: () => ["neutral", "smile"],
    configureProxy: async () => {}, writeLog: () => {}, logger: quiet,
    encodeImage: (imagePath) => { assert.equal(imagePath, "/virtual/image.jpg"); return "encoded"; },
    fetchImpl: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: {
        content: JSON.stringify(response),
      } }] }) };
    },
  });
  return { chat, requests };
}

test("AI keeps system messages stable while memory and other context move into user input", async () => {
  const h = chatHarness({ response: "reply", expression: "neutral" });
  const observation = { id: "input", source: "manual", role: "user",
    content: [{ type: "text", text: "本轮用户问题" }, { type: "image", path: "/virtual/image.jpg" }] };
  const context = [
    { id: "memory:long-term-memory", title: "长期记忆", text: "用户偏好 TypeScript" },
    { id: "memory:session-summary", title: "会话摘要", text: "正在处理发布任务" },
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
  for (const request of h.requests) assert.deepEqual(request.body.messages[0], system);
  for (const block of context) assert.ok(!system.content.includes(block.text));
  const user = h.requests[0].body.messages[1];
  assert.equal(user.role, "user");
  const background = user.content.find(({ text }) => text?.startsWith("# 补充上下文"));
  for (const block of context) {
    assert.ok(background.text.includes(block.title));
    assert.ok(background.text.includes(block.text));
  }
  const currentIndex = user.content.findIndex(({ text }) => text === "# 本次输入");
  assert.ok(user.content.indexOf(background) < currentIndex);
  assert.ok(user.content.slice(currentIndex + 1).some(({ text }) => text?.includes("本轮用户问题")));
  assert.equal(user.content.at(-1).image_url.url, "data:image/jpeg;base64,encoded");
  assert.ok(h.requests[1].body.messages[1].content.some(({ text }) => text?.includes("更新后的用户偏好 TypeScript")));
  assert.ok(!h.requests[2].body.messages[1].content.some(({ text }) => text?.includes("# 补充上下文")));
});

test("text-only manual and audio inputs reach output and memory without image encoding", async (t) => {
  const h = chatHarness({ response: "heard", expression: "smile", screenSummary: "invented image", audioSummary: "external video" });
  const bus = new MessageBus();
  const perception = createPerceptionService(bus);
  const providers = createDecisionProviders(() => "ai-conversation");
  providers.register("ai-conversation", ({ observations, context }) =>
    h.chat.decideFromObservations(observations, { context }));
  const memory = createMemoryPlugin({
    bus, logger: quiet,
    config: { get: () => ({ plugins: [{ name: "memory", enabled: true,
      summary: { enabled: false }, longTerm: { enabled: false } }] }) },
    services: createServiceRegistry(),
    decisionContext: { register: (provide) => providers.contextProviders.register("memory", provide) },
  });
  t.after(() => memory.dispose());
  const history = [];
  const historyPlugin = createHistoryPlugin({
    bus, logger: quiet, services: createServiceRegistry(), config: { get: () => ({}) },
    menu: { register: () => () => {} }, ipc: { handle: () => () => {} },
  }, { repository: { append: (entry) => history.push(entry), endSessions() {} } });
  t.after(() => historyPlugin.dispose());
  t.after(registerDecisionModule(bus, { decide: (observations) => providers.decide({ observations }) }));
  const bubbles = [];
  const speech = [];
  t.after(registerExecutionModule(bus, { sendBubble: (bubble) => bubbles.push(bubble) }));
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
  const memoryText = h.requests[1].body.messages[1].content.find(({ text }) => text?.startsWith("# 补充上下文")).text;
  assert.match(memoryText, /用户：hello pet/);
  assert.match(memoryText, /设备音频：external video/);
});

test("AI provider accepts images from new sources and rejects unsupported parts before calling the model", async () => {
  const h = chatHarness({ response: "image seen", screenSummary: "a picture", audioSummary: "invented audio" });
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
  await h.getMenu()[0].click();
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

test("host registration hooks connect and dispose a provider and its contributed menu", async () => {
  const bus = new MessageBus();
  const decisions = createDecisionProviders(() => "test-provider");
  const host = createPluginHost({
    bus, decisions, getConfig: () => ({}), logger: quiet,
    definitions: [{ name: "test-provider", shouldLoad: () => true, load: () => ({
      activate(context) {
        const unregisterDecision = context.decisions.register(async () => ({ reply: "from plugin" }));
        const unregisterMenu = context.menu.register(() => [{ label: "test provider" }]);
        return { dispose() { unregisterDecision(); unregisterMenu(); } };
      },
    }) }],
  });
  await host.activate();
  assert.equal((await decisions.decide({ observations: [] })).reply, "from plugin");
  assert.ok(menuHooks.getMenuContributions().some(({ label }) => label === "test provider"));
  await host.dispose();
  assert.equal(decisions.has("test-provider"), false);
  assert.ok(!menuHooks.getMenuContributions().some(({ label }) => label === "test provider"));
});

test("plugin options come from their named plugin configuration", () => {
  const config = { plugins: [
    { name: "ai-conversation", ai: { model: "model", apiKey: "test-key" }, character: { name: "pet" } },
    { name: "screen-perception", enabled: false, interval_ms: 200, changeDetect: { threshold: 2 } },
  ] };
  assert.equal(getAiOptions(config).ai.model, "model");
  assert.equal(getAiOptions(config).ai.apiKey, "test-key");
  assert.equal(getAiOptions(config).character.name, "pet");
  assert.deepEqual(getScreenOptions(config), {
    enabled: false, intervalMs: 200, observationTtlMs: 60000, changeDetect: { threshold: 2 },
  });
  assert.deepEqual(getAiOptions({}), { ai: {}, character: {} });
});

test("the actual plugin manifest loads AI and manual screenshot capabilities with plugin configurations", async (t) => {
  const ai = { endpoint: "https://model.example/v1", apiKey: "test-key", model: "test-model" };
  for (const config of [
    { plugins: [{ name: "ai-conversation", ai }, { name: "screen-perception", enabled: false }] },
    { decision: { provider: "ai-conversation" }, plugins: [
      { name: "ai-conversation", enabled: true, ai },
      { name: "screen-perception", enabled: false },
    ] },
  ]) {
    const bus = new MessageBus();
    const perception = createPerceptionService(bus);
    const decisions = createDecisionProviders(() => "ai-conversation");
    const services = createServiceRegistry();
    let captures = 0;
    const host = createPluginHost({
      bus, perception, decisions, services, getConfig: () => config, logger: quiet,
      pet: { getExpressions: () => ["neutral"] },
      screen: { captureFullscreen: async () => {
        captures += 1;
        return { path: "/virtual/manual.jpg", filename: "manual.jpg" };
      } },
    });
    t.after(() => host.dispose());
    await host.activate();
    await host.start();
    assert.ok(decisions.has("ai-conversation"));
    assert.equal(typeof services.get("ai-conversation.text"), "function");
    assert.ok(perception.hasSource("screen"));
    assert.equal(captures, 0);
    assert.equal((await perception.capture("screen", { enqueue: false })).path, "/virtual/manual.jpg");
    assert.equal(captures, 1);
    assert.equal(bus.queueSize(EVENTS.PERCEPTION_OBSERVATION), 0);
    await host.dispose();
    assert.equal(decisions.has("ai-conversation"), false);
    assert.equal(services.get("ai-conversation.text"), undefined);
    assert.equal(perception.hasSource("screen"), false);
  }
});
