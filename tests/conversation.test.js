const test = require("node:test");
const assert = require("node:assert/strict");
const { createConversation } = require("../electron/conversation");
const { createContextProviders } = require("../electron/architecture/contextProviders");
const { createPluginHost } = require("../electron/pluginHost");
const { MessageBus } = require("../electron/architecture/messageBus");
const { petPayload } = require("./helpers/petPayload");
const quiet = { info() {}, warn() {}, error() {} };
const settle = () => new Promise((resolve) => setImmediate(resolve));
const messages = [{ role: "user", content: "test" }];
const observations = [{ id: "input", source: "manual-input", role: "user", content: [{ type: "text", text: "hello" }] }];
const config = (model = "old", enabled = true) => ({ conversation: { enabled,
  ai: { endpoint: `https://${model}.example/v1`, apiKey: model, model, proxy: model },
  character: { name: model },
} });
const response = (content) => {
  try { const parsed = JSON.parse(content); if (Object.hasOwn(parsed, "response")) content = JSON.stringify(petPayload(parsed)); } catch {}
  return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content } }] }) };
};
function harness(t, dependencies = {}) {
  const calls = [], proxies = [];
  const conversation = createConversation({ getConfig: () => config(), logger: quiet,
    configureProxy: async (proxy) => { proxies.push(proxy); }, writeLog() {},
    fetchImpl: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return response(JSON.stringify({ response: "reply", expression: "neutral" }));
    }, ...dependencies });
  t.after(() => conversation.dispose());
  return { conversation, calls, proxies };
}

test("core collects context extensions without requiring a decision plugin", async (t) => {
  const contexts = createContextProviders({ logger: quiet });
  const unregister = contexts.register("memory", async () => [{ id: "facts", title: "facts", text: "remember this" }]);
  const { conversation, calls } = harness(t, { contextProviders: contexts });
  assert.equal((await conversation.decideFromObservations(observations)).reply, "reply");
  assert.ok(JSON.stringify(calls[0].body.messages).includes("remember this"));
  unregister();
  await conversation.decideFromObservations(observations);
  assert.ok(!JSON.stringify(calls[1].body.messages).includes("remember this"));
});

test("stop cancels simultaneous decision and text requests and rejects late responses", async (t) => {
  const pending = [];
  const { conversation } = harness(t, { fetchImpl: (url, init) => new Promise((resolve) => pending.push({ init, resolve })) });
  const decision = assert.rejects(conversation.decideFromObservations(observations), /abort/i);
  const text = assert.rejects(conversation.generateText(messages), /abort/i);
  await settle();
  assert.equal(pending.length, 2);
  await conversation.stop();
  await Promise.all([decision, text]);
  assert.ok(pending.every(({ init }) => init.signal.aborted));
  assert.equal(conversation.model.isAvailable(), false);
  for (const request of pending) request.resolve(response("late"));
  await settle();
  await assert.rejects(conversation.generateText(messages), /已停止/);
  conversation.start();
  assert.equal(conversation.model.isAvailable(), true);
});

test("a stalled context extension cannot block core shutdown or issue a late model request", async (t) => {
  let release;
  const contexts = createContextProviders({ logger: quiet });
  contexts.register("slow", () => new Promise((resolve) => { release = resolve; }));
  const { conversation, calls } = harness(t, { contextProviders: contexts });
  const rejected = assert.rejects(conversation.decideFromObservations(observations), /abort/i);
  await settle();
  await conversation.dispose();
  await rejected;
  release([]);
  await settle();
  assert.equal(calls.length, 0);
  conversation.start();
  await assert.rejects(conversation.generateText(messages), /已停止/);
});

test("reconfiguration cancels old requests, serializes changes and uses the new model and character", async (t) => {
  const requests = [], proxies = [], availability = [];
  const { conversation } = harness(t, {
    configureProxy: async (proxy) => { proxies.push(proxy); },
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      requests.push({ url, init, body });
      if (body.model === "old") return new Promise(() => {});
      return response(JSON.stringify({ response: "new reply", expression: "neutral" }));
    },
  });
  conversation.model.subscribe(() => availability.push(conversation.model.isAvailable()));
  const old = assert.rejects(conversation.generateText(messages), /已更新/);
  await settle();
  const revision = conversation.model.getRevision();
  await conversation.reconfigure(config());
  assert.equal(conversation.model.getRevision(), revision);
  assert.equal(requests[0].init.signal.aborted, false);
  const first = conversation.reconfigure(config("middle"));
  const second = conversation.reconfigure(config("new"));
  await assert.rejects(conversation.generateText(messages), /正在更新/);
  await Promise.all([first, second, old]);
  assert.equal(requests[0].init.signal.aborted, true);
  assert.deepEqual(availability, [false, false, false, true]);
  const result = await conversation.decideFromObservations(observations);
  assert.equal(result.reply, "new reply");
  const latest = requests.at(-1);
  assert.equal(latest.body.model, "new");
  assert.match(latest.url, /new\.example/);
  assert.equal(latest.init.headers.Authorization, "Bearer new");
  assert.ok(latest.body.messages[0].content.includes("new"));
  assert.deepEqual(proxies, ["old", "new"]);
});

test("disable and re-enable expose availability while disposal prevents queued updates from reviving core", async (t) => {
  const { conversation } = harness(t);
  await conversation.reconfigure(config("new", false));
  assert.equal(conversation.model.isAvailable(), false);
  await assert.rejects(conversation.generateText(messages), /已关闭/);
  await conversation.reconfigure(config("new"));
  assert.equal(conversation.model.isAvailable(), true);
  await conversation.generateText(messages);
  const update = conversation.reconfigure(config("last"));
  await Promise.all([update, conversation.dispose()]);
  conversation.start();
  assert.equal(conversation.model.isAvailable(), false);
  await conversation.reconfigure(config("revived"));
  await assert.rejects(conversation.generateText(messages), /已停止/);
});

test("host model capability cancels plugin requests and cleans subscriptions without stopping core", async (t) => {
  const pending = [];
  const { conversation } = harness(t, { fetchImpl: (_url, init) => new Promise((resolve) => pending.push({ init, resolve })) });
  let context, notifications = 0;
  const host = createPluginHost({ bus: new MessageBus({ logger: quiet }), getConfig: () => ({}),
    model: conversation.model, logger: quiet,
    definitions: [{ name: "extension", shouldLoad: () => true, load: () => ({ activate(ctx) {
      context = ctx;
      ctx.model.subscribe(() => { notifications++; });
      return { start() {}, stop() {}, dispose() {} };
    } }) }],
  });
  t.after(() => host.dispose());
  await host.activate();
  await host.start();
  const external = new AbortController();
  const rejected = assert.rejects(context.model.generateText(messages, { signal: external.signal }), /abort/i);
  await settle();
  await host.stop();
  await rejected;
  assert.equal(pending[0].init.signal.aborted, true);
  assert.equal(external.signal.aborted, false);
  assert.equal(context.model.isAvailable(), false);
  assert.equal(conversation.model.isAvailable(), true);
  await conversation.reconfigure(config("next"));
  assert.equal(notifications, 0);
  await host.start();
  await conversation.reconfigure(config("another"));
  assert.equal(notifications, 2);
  await host.dispose();
  await conversation.reconfigure(config("final"));
  assert.equal(notifications, 2);
  assert.throws(() => context.model.generateText(messages), /卸载/);
});

test("memory keeps queued dialogues and existing facts through model disable and resumes with the new core client", async (t) => {
  const { workStorage } = require("./helpers/workStorage");
  const { createMemoryPlugin } = require("../electron/plugins/memory");
  const { createLongTermStore } = require("../electron/plugins/memory/longTerm");
  const EVENTS = require("../electron/architecture/events");
  const { db, storage } = workStorage();
  const repo = createLongTermStore(storage);
  repo.appendBatch([{ id: "existing", type: "fact", text: "用户使用 TypeScript", importance: 5, createdAt: 10 }]);
  let oldRequest;
  const batches = [];
  const { conversation } = harness(t, { fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.model === "old") return new Promise((resolve) => { oldRequest = { init, resolve }; });
    batches.push(JSON.parse(body.messages[1].content));
    return response(JSON.stringify({ update: [], add: [] }));
  } });
  const bus = new MessageBus({ logger: quiet });
  const plugin = createMemoryPlugin({ bus, logger: quiet, model: conversation.model,
    config: { get: () => ({ plugins: [{ name: "memory", enabled: true,
      work: { enabled: false }, practice: { enabled: false }, longTerm: { enabled: true },
    }] }) },
    services: { get: (name) => name === "storage-sqlite.database" ? storage : undefined },
    decisionContext: { register: () => () => {} },
  }, { longTerm: repo });
  t.after(async () => { await plugin.dispose(); db.close(); });
  for (let i = 1; i <= 20; i++) {
    await bus.notify(EVENTS.DECISION_COMPLETED, { id: `decision${i}`, sessionId: "test",
      observations: [{ ...observations[0], id: `observation${i}` }], result: { reply: `reply${i}`, summaries: {} },
    });
  }
  await settle();
  assert.ok(oldRequest);
  await conversation.reconfigure(config("new", false));
  await plugin.whenIdle();
  assert.equal(oldRequest.init.signal.aborted, true);
  assert.equal(plugin.getState().pendingFacts.length, 20);
  assert.equal(repo.list()[0].text, "用户使用 TypeScript");
  assert.equal(batches.length, 0);
  await conversation.reconfigure(config("new"));
  await plugin.whenIdle();
  assert.equal(batches.length, 1);
  assert.equal(batches[0].turns.length, 20);
  assert.equal(batches[0].entries[0].id, "existing");
  assert.equal(plugin.getState().pendingFacts.length, 0);
  assert.equal(repo.list()[0].text, "用户使用 TypeScript");
  oldRequest.resolve(response(JSON.stringify({ update: [], add: [] })));
  await settle();
  assert.equal(batches.length, 1);
  assert.equal(repo.list().length, 1);
});
