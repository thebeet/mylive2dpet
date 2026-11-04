const test = require("node:test");
const assert = require("node:assert/strict");
const { MessageBus } = require("../electron/architecture/messageBus");
const { createPromptExtensions } = require("../electron/architecture/promptExtensions");
const { createContextProviders } = require("../electron/architecture/contextProviders");
const { createDecisionResult } = require("../electron/architecture/contracts");
const { createServiceRegistry } = require("../electron/architecture/serviceRegistry");
const { createPerceptionService } = require("../electron/architecture/perceptionService");
const { createPluginHost } = require("../electron/pluginHost");
const { createConversation } = require("../electron/conversation");
const { registerDecisionModule } = require("../electron/modules/decision");
const { extractChatPayload } = require("../electron/conversation/parseChatText");
const EVENTS = require("../electron/architecture/events");
const { promptExtension } = require("../electron/plugins/schedule/effects");
const scheduleDefinition = require("../electron/plugins/schedule/definition");
const { workStorage } = require("./helpers/workStorage");
const { petPayload } = require("./helpers/petPayload");
const quiet = { info() {}, warn() {}, error() {} };
const observation = { source: "test", role: "context", content: [{ type: "text", text: "current input" }] };

function harness(t, { outputFormat = "auto", definitions = [scheduleDefinition] } = {}) {
  const stored = workStorage(), services = createServiceRegistry();
  services.register("storage", stored.storage);
  const bus = new MessageBus({ logger: quiet });
  const perception = createPerceptionService(bus);
  const promptExtensions = createPromptExtensions();
  const contextProviders = createContextProviders({ logger: quiet });
  const config = { conversation: { ai: { endpoint: "https://test.invalid/v1", apiKey: "test", model: "test", outputFormat } },
    plugins: [{ name: "schedule", enabled: true }] };
  const calls = [];
  let payload = petPayload({ shouldSpeak: false, response: "" });
  const conversation = createConversation({ getConfig: () => config, bus, contextProviders, promptExtensions,
    storage: stored.storage, logger: quiet, retryWait: async () => {}, configureProxy: async () => {}, writeLog() {},
    fetchImpl: async (_url, init) => {
      calls.push(JSON.parse(init.body));
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }) };
    },
  });
  const host = createPluginHost({ getConfig: () => config, services, bus, contextProviders, promptExtensions,
    storage: stored.core, perception, logger: quiet, definitions, ipc: { handle: () => () => {} } });
  const unregisterDecision = registerDecisionModule(bus, { perception,
    decide: (observations) => conversation.decideFromObservations(observations) });
  t.after(async () => { unregisterDecision(); await host.dispose(); await conversation.dispose(); stored.db.close(); });
  return { ...stored, host, bus, perception, conversation, promptExtensions, config, calls,
    setPayload: (value) => { payload = value; }, tasks: () => stored.storage.collection("schedule.tasks").list().map(({ value }) => value) };
}

test("silent effects pass through every output mode, broadcast to plugins and persist schedule tasks once", async (t) => {
  for (const outputFormat of ["auto", "json_schema", "json_object", "prompt"]) {
    let received;
    const observer = { name: "observer", shouldLoad: () => true, load: () => ({ activate(context) {
      context.bus.subscribe(EVENTS.DECISION_COMPLETED, (event) => { received = event; });
      return {};
    } }) };
    const h = harness(t, { outputFormat, definitions: [observer, scheduleDefinition] });
    await h.host.activate(); await h.host.start();
    const effect = { type: "schedule.create", text: "提醒我开会", scheduledAt: new Date(Date.now() + 120000).toISOString() };
    h.setPayload(petPayload({ shouldSpeak: false, response: "", effects: [effect] }));
    await h.perception.submit(observation);
    await h.bus.publish(EVENTS.DECISION_REQUESTED);
    assert.equal(received.result.speak, false);
    assert.equal(received.result.reply, "");
    assert.deepEqual(received.result.effects, [effect]);
    assert.equal(h.tasks().length, 1);
    assert.equal(h.tasks()[0].text, effect.text);
    assert.equal(h.tasks()[0].decisionId, received.id);
    assert.equal(h.tasks()[0].effectIndex, 0);
    assert.match(h.calls[0].messages[0].content, /插件能力：schedule/);
    assert.match(h.calls[0].messages[0].content, /schedule\.create/);
    if (["auto", "json_schema"].includes(outputFormat)) {
      assert.deepEqual(h.calls[0].response_format.json_schema.schema.properties.effects.items.anyOf, promptExtension.effectSchemas);
    }
    await h.bus.notify(EVENTS.DECISION_COMPLETED, received);
    assert.equal(h.tasks().length, 1, "duplicate completion must not create another task");
    await h.conversation.decideFromObservations([observation]);
    const history = h.calls.at(-1).messages.find((message) => message.role === "assistant");
    assert.deepEqual(JSON.parse(history.content).effects, [effect]);
  }
});

test("each schedule effect is validated independently and failures leave other plugins and valid effects intact", async (t) => {
  const h = harness(t);
  let received;
  h.bus.subscribe(EVENTS.DECISION_COMPLETED, () => { throw new Error("unrelated plugin failure"); });
  h.bus.subscribe(EVENTS.DECISION_COMPLETED, (event) => { event.result.effects.push({ type: "mutated" }); });
  await h.host.activate(); await h.host.start();
  h.bus.subscribe(EVENTS.DECISION_COMPLETED, (event) => { received = event; });
  const date = new Date(Date.now() + 120000).toISOString();
  const effects = [{}, { type: "other.action", arbitrary: { field: 1 } },
    { type: "schedule.create", text: "past", scheduledAt: "2000-01-01T00:00:00Z" },
    { type: "schedule.create", text: "ambiguous", scheduledAt: "tomorrow" },
    { type: "schedule.create", text: "bad", scheduledAt: date, extra: true },
    { type: "schedule.create", text: "valid", scheduledAt: date }];
  h.setPayload(petPayload({ shouldSpeak: false, response: "", effects }));
  await h.perception.submit(observation); await h.bus.publish(EVENTS.DECISION_REQUESTED);
  assert.deepEqual(received.result.effects, effects);
  assert.equal(h.tasks().length, 1);
  assert.equal(h.tasks()[0].text, "valid");
  assert.equal(h.tasks()[0].effectIndex, 5);
  await h.host.reload({ ...h.config, plugins: [{ name: "schedule", enabled: false }] });
  await h.host.reload(h.config);
  await h.bus.notify(EVENTS.DECISION_COMPLETED, received);
  assert.equal(h.tasks().length, 1, "effect deduplication survives plugin reload");
});

test("prompt extensions and schemas follow plugin stop, start, reload and failed activation", async (t) => {
  const h = harness(t);
  await h.host.activate(); await h.host.start();
  await h.conversation.decideFromObservations([observation]);
  await h.conversation.decideFromObservations([observation]);
  assert.ok(h.calls[1].messages.some((message) => message.role === "assistant"));
  await h.host.stop();
  assert.equal(h.promptExtensions.collect().effectSchemas.length, 0);
  await h.conversation.decideFromObservations([observation]);
  assert.doesNotMatch(h.calls[2].messages[0].content, /插件能力：schedule/);
  assert.equal(h.calls[2].messages.some((message) => message.role === "assistant"), false);
  await h.host.start();
  await h.conversation.decideFromObservations([observation]);
  assert.match(h.calls[3].messages[0].content, /插件能力：schedule/);
  assert.equal(h.calls[3].messages.some((message) => message.role === "assistant"), false);
  await h.host.reload({ ...h.config, plugins: [{ name: "schedule", enabled: false }] });
  assert.equal(h.promptExtensions.collect().contributions.length, 0);

  const failed = harness(t, { definitions: [{ name: "broken", shouldLoad: () => true,
    load: () => ({ activate(context) { context.systemPrompt.register({ text: "must be rolled back" }); throw new Error("failed"); } }) }] });
  await failed.host.activate();
  assert.equal(failed.promptExtensions.collect().contributions.length, 0);
});

test("core checks effects structure without interpreting plugin-specific objects", () => {
  const effects = [{}, { type: "extension.custom", nested: { value: [1, true, null] } }];
  const payload = petPayload({ shouldSpeak: false, response: "", effects });
  assert.deepEqual(extractChatPayload(JSON.stringify(payload)).effects, effects);
  for (const invalid of [null, {}, "effects", [null], [1], [[]]]) {
    assert.throws(() => extractChatPayload(JSON.stringify(petPayload({ effects: invalid }))), /effects 必须是对象数组/);
    assert.throws(() => createDecisionResult({ reply: "", speak: false, effects: invalid }), /effects must be/);
  }
  const result = createDecisionResult({ reply: "", speak: false, effects });
  effects[1].nested.value.push(2);
  assert.deepEqual(result.effects[1].nested.value, [1, true, null]);
  assert.ok(Object.isFrozen(result.effects[1].nested));
});

test("multiple plugin prompt contributions merge schemas without altering caller-owned declarations", () => {
  const extensions = createPromptExtensions();
  const unregister = extensions.register("schedule", promptExtension);
  const schema = { type: "object", additionalProperties: false, required: ["type"],
    properties: { type: { type: "string", enum: ["custom.effect"] } } };
  extensions.register("custom", { text: "custom plugin rules", effectSchemas: [schema] });
  schema.properties.type.enum[0] = "changed externally";
  assert.deepEqual(extensions.collect().effectSchemas[1].properties.type.enum, ["custom.effect"]);
  unregister();
  assert.equal(extensions.collect().effectSchemas.length, 1);
  assert.throws(() => extensions.register("invalid", { text: "rules", effectSchemas: [{ type: "object" }] }), /strict object schemas/);
});
