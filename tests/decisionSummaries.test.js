const test = require("node:test");
const assert = require("node:assert/strict");
const { MessageBus } = require("../electron/architecture/messageBus");
const { createPromptExtensions } = require("../electron/architecture/promptExtensions");
const { createServiceRegistry } = require("../electron/architecture/serviceRegistry");
const { createPerceptionService } = require("../electron/architecture/perceptionService");
const { createDecisionResult } = require("../electron/architecture/contracts");
const { createPluginHost } = require("../electron/pluginHost");
const { createConversation } = require("../electron/conversation");
const { registerDecisionModule } = require("../electron/modules/decision");
const { extractChatPayload } = require("../electron/conversation/parseChatText");
const { buildSystemPrompt } = require("../electron/conversation/prompt");
const { normalizeConfig } = require("../electron/config");
const { workStorage } = require("./helpers/workStorage");
const { petPayload } = require("./helpers/petPayload");
const EVENTS = require("../electron/architecture/events");
const screenDefinition = require("../electron/plugins/screenPerception/definition");
const audioDefinition = require("../electron/plugins/audioOutputPerception/definition");
const quiet = { info() {}, warn() {}, error() {} };
const image = { source: "screen", role: "context", content: [{ type: "image", path: "/virtual.jpg" }] };
const audio = { source: "audio-output", role: "context", metadata: { modality: "audio" }, content: [{ type: "text", text: "external video narrator" }] };
const text = { source: "manual-input", role: "user", content: [{ type: "text", text: "hello" }] };

function harness(t, { outputFormat = "auto", definitions = [screenDefinition, audioDefinition] } = {}) {
  const stored = workStorage(), services = createServiceRegistry(), bus = new MessageBus({ logger: quiet });
  services.register("storage", stored.storage);
  const perception = createPerceptionService(bus), promptExtensions = createPromptExtensions();
  const config = normalizeConfig({ conversation: { ai: { endpoint: "https://test.invalid/v1", apiKey: "test", model: "test", outputFormat } },
    plugins: [{ name: "screen-perception", enabled: false }, { name: "audio-output-perception", enabled: false }] });
  let payload = petPayload({ shouldSpeak: false, response: "", summaries: { screen: "editor", work: "editing", audio: "external video" } });
  const calls = [];
  const conversation = createConversation({ getConfig: () => config, bus, promptExtensions, storage: stored.storage,
    logger: quiet, encodeImage: () => "encoded", retryWait: async () => {}, configureProxy: async () => {}, writeLog() {},
    fetchImpl: async (_url, init) => {
      calls.push(JSON.parse(init.body));
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }) };
    },
  });
  const host = createPluginHost({ getConfig: () => config, services, bus, promptExtensions, storage: stored.core,
    perception, logger: quiet, definitions, ipc: { handle: () => () => {} } });
  t.after(async () => { await host.dispose(); await conversation.dispose(); stored.db.close(); });
  return { ...stored, host, conversation, bus, perception, promptExtensions, calls,
    setPayload: (next) => { payload = next; } };
}

test("real perception plugins inject summary instructions and schemas in every output mode", async (t) => {
  for (const outputFormat of ["auto", "json_schema", "json_object", "prompt"]) {
    const h = harness(t, { outputFormat });
    await h.host.activate(); await h.host.start();
    const result = await h.conversation.decideFromObservations([image, audio]);
    assert.deepEqual(result.summaries, { screen: "editor", work: "editing", audio: "external video" });
    const request = h.calls[0];
    assert.match(request.messages[0].content, /插件能力：screen-perception/);
    assert.match(request.messages[0].content, /插件能力：audio-output-perception/);
    assert.doesNotMatch(request.messages[0].content, /screenSummary|workSummary|audioSummary/);
    if (["auto", "json_schema"].includes(outputFormat)) {
      const schema = request.response_format.json_schema.schema;
      assert.deepEqual(schema.required, ["shouldSpeak", "expression", "response", "summaries", "effects"]);
      assert.deepEqual(schema.properties.summaries.required, ["screen", "work", "audio"]);
      assert.equal(schema.properties.summaries.additionalProperties, false);
    }
    h.setPayload(petPayload());
    await h.conversation.decideFromObservations([text]);
    const history = JSON.parse(h.calls[1].messages.find((message) => message.role === "assistant").content);
    assert.deepEqual(history.summaries, result.summaries);
    assert.equal(Object.hasOwn(history, "screenSummary"), false);
  }
});

test("plugins reject invented summaries, missing declarations and unknown summary fields before completion", async (t) => {
  const h = harness(t);
  await h.host.activate(); await h.host.start();
  let completed = 0;
  h.bus.subscribe(EVENTS.DECISION_COMPLETED, () => completed++);
  t.after(registerDecisionModule(h.bus, { perception: h.perception,
    decide: (observations) => h.conversation.decideFromObservations(observations) }));
  await h.perception.submit(text);
  await h.bus.publish(EVENTS.DECISION_REQUESTED);
  assert.equal(completed, 0);
  assert.equal(h.perception.getRejected().length, 1);
  assert.equal(h.calls.length, 4);
  for (const summaries of [{ screen: "invented", work: "", audio: "" },
    { screen: "", work: "invented", audio: "" }, { screen: "", work: "", audio: "invented" },
    { screen: "", work: "" }, { screen: "", work: "", audio: "", unknown: "" }]) {
    h.setPayload(petPayload({ summaries }));
    await assert.rejects(h.conversation.decideFromObservations([text]), /JSON 不符合约定/);
  }
  h.setPayload(petPayload());
  await h.conversation.decideFromObservations([text]);
  assert.equal(h.calls.at(-1).messages.some((message) => message.role === "assistant"), false);
});

test("summary declarations disappear on stop, return on start and reset the next conversation history", async (t) => {
  const h = harness(t);
  await h.host.activate(); await h.host.start();
  await h.conversation.decideFromObservations([image, audio]);
  await h.host.stop();
  assert.deepEqual(h.promptExtensions.collect().summarySchemas, {});
  h.setPayload(petPayload());
  await h.conversation.decideFromObservations([text]);
  const request = h.calls.at(-1);
  assert.deepEqual(request.response_format.json_schema.schema.properties.summaries.properties, {});
  assert.doesNotMatch(request.messages[0].content, /插件能力：screen-perception|插件能力：audio-output-perception/);
  assert.equal(request.messages.some((message) => message.role === "assistant"), false);
  await h.host.start();
  assert.deepEqual(Object.keys(h.promptExtensions.collect().summarySchemas), ["screen", "work", "audio"]);
  h.setPayload(petPayload());
  await h.conversation.decideFromObservations([text]);
  assert.equal(h.calls.at(-1).messages.some((message) => message.role === "assistant"), false);
  await h.host.dispose();
  assert.deepEqual(h.promptExtensions.collect().summarySchemas, {});
});

test("a new plugin-defined summary is preserved in broadcast and history without changing core fields", async (t) => {
  let completed;
  const extension = { name: "custom", shouldLoad: () => true, load: () => ({ activate(context) {
    context.systemPrompt.register({ text: "summaries.focus 描述本轮注意力信息。", summarySchemas: { focus: { type: "string" } } });
    context.bus.subscribe(EVENTS.DECISION_COMPLETED, (event) => { completed = event; });
    return {};
  } }) };
  const h = harness(t, { definitions: [extension] });
  await h.host.activate(); await h.host.start();
  h.setPayload(petPayload({ summaries: { focus: "  focused  " } }));
  t.after(registerDecisionModule(h.bus, { perception: h.perception,
    decide: (observations) => h.conversation.decideFromObservations(observations) }));
  await h.perception.submit(text); await h.bus.publish(EVENTS.DECISION_REQUESTED);
  assert.deepEqual(completed.result.summaries, { focus: "focused" });
  assert.ok(Object.isFrozen(completed.result.summaries));
  await h.conversation.decideFromObservations([text]);
  const assistant = h.calls.at(-1).messages.find((message) => message.role === "assistant");
  assert.deepEqual(JSON.parse(assistant.content).summaries, { focus: "focused" });
});

test("summary declarations reject conflicts and invalid schemas and the base prompt contains only generic rules", () => {
  const extensions = createPromptExtensions();
  extensions.register("one", { text: "rules", summarySchemas: { custom: { type: "string" } } });
  assert.throws(() => extensions.register("two", { text: "rules", summarySchemas: { custom: { type: "string" } } }), /重复/);
  assert.throws(() => extensions.register("bad", { text: "rules", summarySchemas: { custom: { type: "number" } } }), /string schemas/);
  assert.throws(() => extensions.register("validator", { text: "rules", validateSummaries: true }), /must be a function/);
  assert.doesNotMatch(buildSystemPrompt(), /summaries\.screen|summaries\.work|summaries\.audio|飞书聊天保留/);
  for (const summaries of [null, [], "text", { custom: 42 }, { custom: null }]) {
    assert.throws(() => extractChatPayload(JSON.stringify(petPayload({ summaries }))), /summaries 必须是/);
  }
  for (const key of ["screenSummary", "audioSummary", "workSummary"]) {
    assert.throws(() => extractChatPayload(JSON.stringify(petPayload({ [key]: "old" }))), /未约定字段/);
  }
  const result = createDecisionResult({ reply: "", speak: false, summaries: { custom: "data" } });
  assert.deepEqual(result.summaries, { custom: "data" });
});

test("summary schemas follow only the current observations without resetting history in any output mode", async (t) => {
  for (const outputFormat of ["auto", "json_schema", "json_object", "prompt"]) {
    const h = harness(t, { outputFormat });
    await h.host.activate(); await h.host.start();
    const scenarios = [
      { observations: [text], summaries: {} },
      { observations: [image], summaries: { screen: "editor", work: "editing" } },
      { observations: [audio], summaries: { audio: "external video" } },
      { observations: [image, audio], summaries: { screen: "editor", work: "editing", audio: "external video" } },
      { observations: [text], summaries: {} },
    ];
    for (const [index, scenario] of scenarios.entries()) {
      h.setPayload(petPayload({ summaries: scenario.summaries }));
      const result = await h.conversation.decideFromObservations(scenario.observations);
      assert.deepEqual(result.summaries, scenario.summaries);
      const request = h.calls.at(-1);
      assert.equal(request.messages.filter((message) => message.role === "assistant").length, index);
      assert.equal(request.messages[0].content, h.calls[0].messages[0].content);
      if (["auto", "json_schema"].includes(outputFormat)) {
        assert.deepEqual(request.response_format.json_schema.schema.properties.summaries.required, Object.keys(scenario.summaries));
      }
    }
    const history = h.calls.at(-1).messages.filter((message) => message.role === "assistant").map((message) => JSON.parse(message.content));
    assert.deepEqual(history.map((payload) => payload.summaries), scenarios.slice(0, -1).map((scenario) => scenario.summaries));
  }
});

test("empty placeholders are rejected when their observations are absent, and present observations require their summaries", async (t) => {
  const h = harness(t);
  await h.host.activate(); await h.host.start();
  for (const [observations, summaries] of [
    [[text], { audio: "" }], [[text], { screen: "", work: "" }],
    [[image], { screen: "editor", work: "editing", audio: "" }],
    [[audio], { screen: "", audio: "external video" }],
    [[image], { screen: "editor" }], [[audio], {}],
  ]) {
    h.setPayload(petPayload({ summaries }));
    await assert.rejects(h.conversation.decideFromObservations(observations), /未声明摘要字段|缺少摘要字段/);
  }
});

test("plugins select fields from their own declarations while the declaration signature stays stable", () => {
  const extensions = createPromptExtensions();
  extensions.register("conditional", { text: "rules", summarySchemas: { custom: { type: "string" } },
    selectSummaryFields: ({ observations }) => observations.length ? ["custom"] : [] });
  const empty = extensions.collect({ observations: [] });
  const present = extensions.collect({ observations: [text] });
  assert.deepEqual(empty.summarySchemas, {});
  assert.deepEqual(Object.keys(present.summarySchemas), ["custom"]);
  assert.equal(empty.signature, present.signature);
  assert.throws(() => extensions.register("bad-type", { text: "rules", selectSummaryFields: true }), /must be a function/);
  extensions.register("bad-selection", { text: "rules", selectSummaryFields: () => ["undeclared"] });
  assert.throws(() => extensions.collect({ observations: [] }), /declared summary field names/);
});
