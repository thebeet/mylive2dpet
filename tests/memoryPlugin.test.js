const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { MessageBus } = require("../electron/architecture/messageBus");
const EVENTS = require("../electron/architecture/events");
const { createServiceRegistry } = require("../electron/architecture/serviceRegistry");
const { createContextProviders } = require("../electron/architecture/contextProviders");
const { createPluginHost } = require("../electron/pluginHost");
const { registerDecisionModule } = require("../electron/modules/decision");
const { createMemoryPlugin, getOptions } = require("../electron/plugins/memory");
const { createShortTermStore } = require("../electron/plugins/memory/shortTerm");
const { createConversation } = require("../electron/conversation");
const longTerm = require("../electron/plugins/memory/longTerm");
const quiet = { info() {}, warn() {}, error() {} };
const settle = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}

function harness(overrides = {}, dependencies = {}) {
  const bus = new MessageBus();
  const services = createServiceRegistry();
  const contexts = createContextProviders({ logger: quiet });
  const config = { plugins: [{ name: "memory", enabled: true,
    shortTerm: { maxTurns: 20 },
    longTerm: { enabled: false }, ...overrides,
  }] };
  const plugin = createMemoryPlugin({
    bus, services, model: {
      get generateText() { return services.get("model.text"); },
      subscribe: (listener) => services.subscribe(({ name }) => { if (name === "model.text") listener(); }),
    }, logger: quiet, config: { get: () => config },
    decisionContext: { register: (provide) => contexts.register("memory", provide) },
  }, dependencies);
  async function record(reply, { userMessage = "", summaries = {} } = {}) {
    const observations = [{ source: "manual-input", role: "user", trigger: "manual-input",
      content: [{ type: "text", text: userMessage || reply }] }];
    await bus.publish(EVENTS.DECISION_COMPLETED, {
      observations, result: { reply, expression: "neutral", summaries }, trigger: "manual-input",
    });
  }
  return { bus, services, contexts, config, plugin, record };
}

const fakeDurable = (added) => ({
  retrieve: () => [], formatForPrompt: () => "", isDuplicate: () => false,
  append: (fact) => added.push(fact),
  list: () => added,
  updateFromDialogue: (plan) => { added.push(...plan.add); return { updated: plan.update.length, added: plan.add.length }; },
});
const addition = (messages, facts) => JSON.stringify({ update: [], add: facts.map((fact) => ({
  type: "fact", tags: [], importance: 4, ...fact, sourceTurnIds: JSON.parse(messages[1].content).turns.map((t) => t.id),
})) });

test("memory uses nested plugin options and the whole-plugin switch", () => {
  const config = { plugins: [{ name: "memory", enabled: true,
    shortTerm: { maxTurns: 12 },
    longTerm: { enabled: false, maxInject: 7 },
  }] };
  const options = getOptions(config);
  assert.equal(options.enabled, true);
  assert.equal(options.shortTerm.enabled, true);
  assert.equal(options.shortTerm.maxTurns, 12);
  assert.equal(Object.hasOwn(options, "summary"), false);
  assert.equal(options.longTerm.enabled, false);
  assert.equal(options.longTerm.maxInject, 7);
  config.plugins[0].enabled = false;
  assert.equal(getOptions(config).enabled, false);
  assert.equal(getOptions({ plugins: [] }).enabled, false);
  assert.equal(getOptions({ plugins: [{ name: "memory" }] }).enabled, true);
});

test("buffers are isolated, honor expiry and fold only snapshot turn IDs", () => {
  let stamp = 100;
  const first = createShortTermStore({ now: () => stamp });
  const second = createShortTermStore({ now: () => stamp });
  first.append({ reply: "one" });
  first.append({ reply: "two" });
  const snapshot = first.list();
  first.append({ reply: "new after snapshot" });
  first.foldSnapshot(snapshot, 0);
  assert.deepEqual(first.list().map(({ reply }) => reply), ["new after snapshot"]);
  assert.deepEqual(second.list(), []);
  stamp += 1000;
  assert.deepEqual(first.list({ ttlMs: 100 }), []);
});

test("recording is independent of the decision provider and optional context failures are isolated", async (t) => {
  const h = harness();
  t.after(() => h.plugin.dispose());
  h.contexts.register("broken", () => { throw new Error("optional extension failure"); });
  h.contexts.register("invalid", () => [{ text: "missing id" }]);
  const inputs = [];
  const decide = async (observations) => {
    const input = { observations, context: await h.contexts.collect({ observations }) };
    inputs.push(input);
    return { reply: "custom reply", summaries: { custom: "sensor context" } };
  };
  t.after(registerDecisionModule(h.bus, { decide }));
  const input = { source: "new-source", role: "user", content: [{ type: "text", text: "hello" }] };
  h.bus.enqueue(EVENTS.PERCEPTION_OBSERVATION, input);
  await h.bus.publish(EVENTS.DECISION_REQUESTED);
  assert.equal(h.plugin.getState().turns[0].userMessage, "hello");
  h.bus.enqueue(EVENTS.PERCEPTION_OBSERVATION, input);
  await h.bus.publish(EVENTS.DECISION_REQUESTED);
  assert.match(inputs[1].context.find(({ id }) => id === "memory:recent-dialogue").text, /custom reply/);
  assert.match(inputs[1].context.find(({ id }) => id === "memory:recent-dialogue").text, /custom：sensor context/);
  assert.ok(!inputs[1].context.some(({ id }) => id.startsWith("invalid:")));
});









test("extraction preserves arrivals after its snapshot and processes each later batch once", async (t) => {
  const pending = deferred();
  const h = harness({ longTerm: { enabled: true, extractEveryNTurns: 2 } }, { longTerm: fakeDurable([]) });
  t.after(() => h.plugin.dispose());
  const requests = [];
  h.services.register("model.text", async (messages) => {
    requests.push(messages);
    return requests.length === 1 ? pending.promise : '{"update":[],"add":[]}';
  });
  await h.record("one");
  await h.record("two");
  await settle();
  await h.record("new three");
  pending.resolve('{"update":[],"add":[]}');
  await h.plugin.whenIdle();
  assert.equal(requests.length, 1);
  assert.deepEqual(h.plugin.getState().pendingFacts.map(({ reply }) => reply), ["new three"]);
  await h.record("new four");
  await h.plugin.whenIdle();
  assert.equal(requests.length, 2);
  assert.match(requests[1][1].content, /new three/);
  assert.match(requests[1][1].content, /new four/);
  assert.doesNotMatch(requests[1][1].content, /\] one/);
});

test("missing core model retains recent context and durable memory", async (t) => {
  const fact = { text: "用户喜欢喝咖啡", tags: ["咖啡"] };
  const h = harness({ longTerm: { enabled: true, extractEveryNTurns: 1 } }, {
    longTerm: { ...fakeDurable([]), retrieve: () => [fact], formatForPrompt: longTerm.formatForPrompt },
  });
  t.after(() => h.plugin.dispose());
  await h.record("still responding", { userMessage: "喝杯咖啡" });
  await h.plugin.whenIdle();
  const blocks = await h.contexts.collect({ observations: [] });
  assert.match(blocks.find(({ id }) => id === "memory:long-term-memory").text, /用户喜欢喝咖啡/);
  assert.match(blocks.find(({ id }) => id === "memory:recent-dialogue").text, /still responding/);
  assert.equal(h.plugin.getState().extractedThrough, 0);
  h.plugin.dispose();
  assert.deepEqual(await h.contexts.collect({}), []);
});

test("long-term updates recover when their service becomes available without losing buffered turns", async (t) => {
  const h = harness({ longTerm: { enabled: true, extractEveryNTurns: 2 } }, { longTerm: fakeDurable([]) });
  t.after(() => h.plugin.dispose());
  await h.record("one"); await h.record("two"); await h.plugin.whenIdle();
  assert.equal(h.plugin.getState().pendingFacts.length, 2);
  h.services.register("model.text", async () => '{"update":[],"add":[]}');
  await h.plugin.whenIdle();
  assert.equal(h.plugin.getState().pendingFacts.length, 0);
  assert.equal(h.plugin.getState().extractedThrough, 2);
});

test("disposal aborts model requests and rejects late long-term updates", async (t) => {
  const pending = deferred(), added = [];
  const h = harness({ longTerm: { enabled: true, extractEveryNTurns: 1 } }, { longTerm: fakeDurable(added) });
  t.after(() => h.plugin.dispose());
  let signal, response;
  h.services.register("model.text", async (messages, settings) => {
    signal = settings.signal; response = addition(messages, [{ text: "obsolete fact" }]);
    return pending.promise;
  });
  await h.record("one"); await settle();
  assert.ok(signal); h.plugin.dispose(); assert.equal(signal.aborted, true);
  pending.resolve(response); await h.plugin.whenIdle();
  assert.equal(h.plugin.getState().turns.length, 0);
  assert.equal(added.length, 0);
  assert.deepEqual(await h.contexts.collect({}), []);
});

test("disabled plugins produce no memory; long-term updates work without recent-dialogue injection", async (t) => {
  const disabled = harness({ enabled: false }); t.after(() => disabled.plugin.dispose());
  await disabled.record("not recorded");
  assert.equal(disabled.plugin.getState().turns.length, 0);
  assert.deepEqual(await disabled.contexts.collect({}), []);
  const added = [];
  const h = harness({ shortTerm: { enabled: false }, longTerm: { enabled: true, extractEveryNTurns: 2 } }, { longTerm: fakeDurable(added) });
  t.after(() => h.plugin.dispose());
  h.services.register("model.text", async (messages) => addition(messages, [{ text: "用户偏好先看结论" }]));
  await h.record("one"); await h.record("two"); await h.plugin.whenIdle();
  const blocks = await h.contexts.collect({});
  assert.ok(!blocks.some(({ id }) => id.endsWith("recent-dialogue")));
  assert.equal(added.length, 1);
});

test("activation failures roll back context, services and subscriptions", async () => {
  const bus = new MessageBus();
  const services = createServiceRegistry();
  const contexts = createContextProviders({ logger: quiet });
  let observed = false;
  const host = createPluginHost({
    bus, services, contextProviders: contexts, logger: quiet, getConfig: () => ({}),
    definitions: [{ name: "broken", shouldLoad: () => true, load: () => ({ activate(context) {
      context.services.register("text", () => "text");
      context.decisionContext.register(() => [{ id: "context", title: "context", text: "text" }]);
      context.bus.subscribe("test", () => { observed = true; });
      throw new Error("activation failed");
    } }) }],
  });
  await host.activate();
  assert.equal(services.get("broken.text"), undefined);
  assert.deepEqual(await contexts.collect({}), []);
  await bus.publish("test");
  assert.equal(observed, false);
  await host.dispose();
});

test("text model service forwards cancellation and aborts retry backoff", async () => {
  let calls = 0;
  let requestSignal;
  const controller = new AbortController();
  const chat = createConversation({
    getConfig: () => ({ conversation: { ai: {
      endpoint: "https://model.example/v1", apiKey: "test-key", model: "test-model",
    } } }),
    getExpressions: () => [], configureProxy: async () => {}, writeLog: () => {},
    logger: { ...quiet, warn: () => queueMicrotask(() => controller.abort()) },
    fetchImpl: async (_url, init) => {
      calls += 1;
      requestSignal = init.signal;
      assert.ok(requestSignal instanceof AbortSignal);
      assert.equal(requestSignal.aborted, false);
      return { ok: false, status: 503, text: async () => '{"error":{"message":"busy"}}' };
    },
  });
  await assert.rejects(chat.generateText([{ role: "user", content: "summarize" }], {
    signal: controller.signal,
  }), (error) => error === controller.signal.reason);
  assert.equal(requestSignal.aborted, true);
  assert.equal(requestSignal.reason, controller.signal.reason);
  assert.equal(calls, 1);
});


test("restoring a text service while stopped defers maintenance until restart, then disposal removes the observer", async (t) => {
  const h = harness({ longTerm: { enabled: true, extractEveryNTurns: 2 } }, { longTerm: fakeDurable([]) });
  t.after(() => h.plugin.dispose());
  await h.record("one"); await h.record("two"); await h.plugin.whenIdle();
  await h.plugin.stop();
  let calls = 0;
  const remove = h.services.register("model.text", async () => {
    calls++;
    return '{"update":[],"add":[]}';
  });
  await h.contexts.collect({}); await h.plugin.whenIdle();
  assert.equal(calls, 0);
  assert.equal(h.plugin.getState().pendingFacts.length, 2);
  h.plugin.start();
  await h.plugin.whenIdle();
  assert.equal(calls, 1);
  assert.equal(h.plugin.getState().pendingFacts.length, 0);
  await h.plugin.dispose();
  remove();
  h.services.register("model.text", async () => { calls++; return "invalid"; });
  await settle();
  assert.equal(calls, 1);
});

test("reading context does not retry failed maintenance or consume pending dialogue", async (t) => {
  const h = harness({ longTerm: { enabled: true, extractEveryNTurns: 1 } }, { longTerm: fakeDurable([]) });
  t.after(() => h.plugin.dispose());
  let calls = 0;
  h.services.register("model.text", async () => { calls++; throw new Error("temporary failure"); });
  await h.record("one"); await h.plugin.whenIdle();
  assert.equal(calls, 1);
  await h.contexts.collect({});
  await h.contexts.collect({});
  await h.plugin.whenIdle();
  assert.equal(calls, 1);
  assert.equal(h.plugin.getState().pendingFacts.length, 1);
});

test("memory and history use SQLite and leave old JSONL files untouched on startup and clear", async (t) => {
  const { workStorage } = require("./helpers/workStorage");
  const { createHistoryRepository } = require("../electron/plugins/dialogueHistory/repository");
  const { createHistoryPlugin } = require("../electron/plugins/dialogueHistory");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pet-sqlite-only-"));
  const logs = path.join(directory, "logs");
  fs.mkdirSync(logs);
  const files = [
    ["memory.jsonl", JSON.stringify({ text: "旧文件里的记忆" }) + "\n"],
    ["dialogue-history.jsonl", JSON.stringify({ petSaid: "旧文件里的回复" }) + "\n"],
  ];
  for (const [name, content] of files) fs.writeFileSync(path.join(logs, name), content);
  const { db, storage } = workStorage();
  const durable = longTerm.createLongTermStore(storage);
  durable.appendBatch([{ text: "数据库中的记忆" }]);
  const history = createHistoryRepository(storage);
  history.append({ petSaid: "数据库中的回复", userSaid: "hello", summaries: {} });
  const bus = new MessageBus({ logger: quiet });
  const context = { bus, logger: quiet, paths: { projectRoot: directory },
    config: { get: () => ({ plugins: [{ name: "memory", enabled: true, longTerm: { enabled: true } }] }) },
    services: { get: () => storage },
    decisionContext: { register: () => () => {} },
    menu: { register: () => () => {}, refresh() {} }, ipc: { handle: () => () => {} },
  };
  const memoryPlugin = createMemoryPlugin(context);
  const historyPlugin = createHistoryPlugin(context);
  t.after(async () => {
    await memoryPlugin.dispose();
    historyPlugin.dispose();
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  assert.deepEqual(durable.list().map(({ text }) => text), ["数据库中的记忆"]);
  assert.deepEqual(history.list().entries.map(({ petSaid }) => petSaid), ["数据库中的回复"]);
  await memoryPlugin.clear();
  assert.equal(durable.list().length, 0);
  assert.equal(history.list().entries.length, 1);
  for (const [name, content] of files) assert.equal(fs.readFileSync(path.join(logs, name), "utf8"), content);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'legacy_imports'").get(), undefined);
});
