const test = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { EventEmitter } = require("node:events");
const { createChatService } = require("../electron/plugins/aiConversation/chat");
const { createRawLogRepository } = require("../electron/plugins/rawLog/repository");
const { activate } = require("../electron/plugins/rawLog");
const { MessageBus } = require("../electron/architecture/messageBus");
const EVENTS = require("../electron/architecture/events");

const quiet = { info() {}, warn() {}, error() {} };
function storageFor(db) {
  return { prepare: (sql) => db.prepare(sql), exec: (sql) => db.exec(sql),
    migrate: (_name, migrations) => migrations.forEach((migration) => migration({ exec: (sql) => db.exec(sql) })) };
}
function chat(options = {}) {
  return createChatService({
    getConfig: () => ({ plugins: [{ name: "ai-conversation", ai: {
      endpoint: "https://example.invalid/v1", apiKey: "secret-api-key", model: "test-model",
    } }] }), getExpressions: () => ["neutral"], encodeImage: () => "actual-image",
    configureProxy: async () => {}, writeLog() {}, logger: quiet, ...options,
  });
}

test("raw log captures exact wire messages and images before sending, including text services", async () => {
  const starts = [], ends = [];
  const service = chat({ onRequest: (entry) => starts.push(entry), onResult: (entry) => ends.push(entry),
    fetchImpl: async (_url, init) => {
      assert.deepEqual(starts.at(-1).request, JSON.parse(init.body));
      assert.equal(ends.length, starts.length - 1);
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: {
        role: "assistant", content: '{"response":"hello","expression":"neutral"}',
      } }] }) };
    } });
  await service.decideFromObservations([{ id: "input", source: "screen", role: "context",
    content: [{ type: "text", text: "屏幕观察" }, { type: "image", path: "/image.png" }] }]);
  const messages = [{ role: "system", content: "总结记忆" }, { role: "user", content: "原文\n第二行" }];
  await service.callChatCompletions(messages);
  assert.equal(starts.length, 2);
  assert.equal(starts[0].request.messages[1].content.at(-1).image_url.url, "data:image/jpeg;base64,actual-image");
  assert.deepEqual(starts[1].request.messages, messages);
  assert.equal(starts[0].sessionId, starts[1].sessionId);
  assert.notEqual(starts[0].id, starts[1].id);
  assert.deepEqual(ends.map((entry) => entry.id), starts.map((entry) => entry.id));
  assert.equal(ends[0].status, 200);
  assert.ok(!JSON.stringify({ starts, ends }).includes("secret-api-key"));
});

test("each retry is recorded separately and cancellation completes a pending request", async () => {
  const starts = [], ends = [];
  const controller = new AbortController();
  let attempts = 0;
  const service = chat({ onRequest: (entry) => starts.push(entry), onResult: (entry) => ends.push(entry),
    fetchImpl: async (_url, init) => {
      if (++attempts === 1) return { ok: false, status: 503, text: async () => '{"error":{"message":"try again"}}' };
      controller.abort(new Error("cancelled by user"));
      init.signal.throwIfAborted();
    } });
  await assert.rejects(service.callChatCompletions([{ role: "user", content: "hello" }], { signal: controller.signal }), /cancelled/);
  assert.equal(starts.length, 2);
  assert.equal(ends.length, 2);
  assert.notEqual(starts[0].id, starts[1].id);
  assert.equal(ends[0].status, 503);
  assert.match(ends[0].error, /try again/);
  assert.match(ends[1].error, /cancelled/);
});

test("failing log observers cannot prevent a successful model call", async () => {
  const service = chat({ onRequest() { throw new Error("disk full"); }, onResult() { throw new Error("disk full"); },
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{"choices":[{"message":{"content":"ok"}}]}' }) });
  assert.equal(await service.callChatCompletions([{ role: "user", content: "hello" }]), "ok");
});

test("SQLite pagination omits large content while details preserve raw request and response", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const repository = createRawLogRepository(storageFor(db));
  const request = { model: "test", messages: [{ role: "user", content: "<script>raw text</script>" }] };
  for (let i = 1; i <= 4; i++) repository.append({ id: `id-${i}`, sessionId: "session", t: i, label: "ai:text", request });
  repository.finish({ id: "id-4", finishedAt: 10, status: 200, response: { choices: [{ message: { role: "assistant", content: "reply" } }] } });
  const first = repository.list({ limit: 2 });
  assert.deepEqual(first.entries.map((entry) => entry.id), ["id-4", "id-3"]);
  assert.equal(first.entries[0].request, undefined);
  assert.equal(first.entries[0].finishedAt, 10);
  const second = repository.list({ limit: 2, before: first.nextCursor });
  assert.deepEqual(second.entries.map((entry) => entry.id), ["id-2", "id-1"]);
  assert.equal(second.nextCursor, null);
  assert.deepEqual(repository.get("id-4").request, request);
  assert.equal(repository.get("id-4").response.choices[0].message.content, "reply");
  assert.throws(() => repository.list({ before: "1 OR 1=1" }), /游标/);
  assert.throws(() => repository.get("missing"), /不存在/);
});

test("log plugin validates window identity and records late cancellation while stopped", async (t) => {
  const db = new DatabaseSync(":memory:");
  const bus = new MessageBus({ logger: quiet });
  const handlers = new Map();
  const windows = [];
  let menu;
  const plugin = activate({ bus, logger: quiet,
    services: { get: () => storageFor(db) },
    menu: { register: (provide) => { menu = provide; return () => { menu = null; }; } },
    ipc: { handle: (channel, handler) => { handlers.set(channel, handler); return () => handlers.delete(channel); } },
    windows: { create: (options) => {
      const win = new EventEmitter();
      Object.assign(win, { options, webContents: {}, destroyed: false, shows: 0,
        isDestroyed() { return this.destroyed; }, isMinimized: () => false,
        show() { this.shows++; }, focus() {}, loadFile: async () => {},
        destroy() { this.destroyed = true; this.emit("closed"); } });
      windows.push(win); return win;
    } },
  });
  t.after(() => { plugin.dispose(); db.close(); });
  await bus.notify(EVENTS.AI_REQUEST_STARTED, { id: "pending", sessionId: "session", t: 1,
    label: "ai:text", request: { model: "test", messages: [{ role: "user", content: "hello" }] } });
  menu()[0].click(); menu()[0].click();
  assert.equal(windows.length, 1);
  const win = windows[0];
  assert.equal(win.options.webPreferences.sandbox, true);
  assert.throws(() => handlers.get("list")({ sender: {} }), /来源无效/);
  assert.equal(handlers.get("list")({ sender: win.webContents }).entries.length, 1);
  plugin.stop(); win.emit("ready-to-show");
  assert.equal(win.shows, 1);
  assert.throws(() => handlers.get("get")({ sender: win.webContents }, "pending"), /已关闭/);
  await bus.notify(EVENTS.AI_REQUEST_FINISHED, { id: "pending", finishedAt: 2, error: "cancelled" });
  assert.equal(db.prepare("SELECT error FROM ai_requests WHERE id = 'pending'").get().error, "cancelled");
  plugin.start(); menu()[0].click();
  plugin.dispose();
  assert.equal(windows[1].destroyed, true);
  assert.equal(handlers.size, 0);
});
