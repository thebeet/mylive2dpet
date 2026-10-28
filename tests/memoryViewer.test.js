const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { MessageBus } = require("../electron/architecture/messageBus");
const EVENTS = require("../electron/architecture/events");
const { createMemoryPlugin } = require("../electron/plugins/memory");
const { listEntries } = require("../electron/plugins/memory/longTerm");
const { createWorkStore } = require("../electron/plugins/memory/workStore");
const { workStorage } = require("./helpers/workStorage");

function harness({ storage, durable, showMessageBox } = {}) {
  const bus = new MessageBus();
  const handlers = new Map();
  const windows = [];
  let menu;
  const config = { plugins: [{ name: "memory", enabled: true,
    shortTerm: { maxTurns: 8 }, longTerm: { enabled: false, maxInject: 1 },
  }] };
  const plugin = createMemoryPlugin({
    bus, config: { get: () => config }, logger: { info() {}, warn() {}, error() {} },
    services: { get: () => storage },
    decisionContext: { register: () => () => {} },
    dialogs: { showMessageBox },
    menu: { register: (provide) => { menu = provide; return () => { menu = null; }; }, refresh() {} },
    ipc: { handle: (channel, handler) => { handlers.set(channel, handler); return () => handlers.delete(channel); } },
    windows: { create: (options) => {
      const win = new EventEmitter();
      Object.assign(win, { options, webContents: {}, destroyed: false, minimized: false, shows: 0,
        isDestroyed() { return this.destroyed; }, isMinimized() { return this.minimized; },
        restore() { this.minimized = false; }, show() { this.shows++; }, focus() {},
        destroy() { this.destroyed = true; this.emit("closed"); }, loadFile: async () => {},
      });
      windows.push(win);
      return win;
    } },
  }, { longTerm: durable });
  return { bus, plugin, handlers, windows, config, view: () => menu()[0].submenu[0].click(),
    history: () => menu()[0].submenu.find((item) => item.label === "查看提问记录…").click(),
    clearItem: () => menu()[0].submenu.at(-1) };
}

test("memory viewer reads current contents, reuses its window, and rejects foreign senders", async (t) => {
  const facts = Array.from({ length: 7 }, (_, id) => ({ id, text: `fact ${id}` }));
  const h = harness({ durable: { list: () => facts, retrieve() { throw new Error("must not retrieve"); } } });
  t.after(() => h.plugin.dispose());
  await h.bus.notify(EVENTS.DECISION_COMPLETED, {
    id: "turn", observations: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    result: { reply: "hi", summaries: { screen: "a desktop" } },
  });
  h.view();
  const win = h.windows[0];
  win.emit("ready-to-show");
  const snapshot = h.handlers.get("snapshot")({ sender: win.webContents });
  assert.equal(snapshot.shortTerm.turns[0].userMessage, "hello");
  assert.equal(snapshot.longTerm.enabled, false);
  assert.equal(snapshot.longTerm.entries.length, 7);
  assert.equal(snapshot.totalTurns, 1);
  assert.throws(() => h.handlers.get("snapshot")({ sender: {} }), /请求来源无效/);
  win.minimized = true;
  h.view();
  assert.equal(h.windows.length, 1);
  assert.equal(win.minimized, false);
  assert.equal(win.options.webPreferences.sandbox, true);
  win.destroy();
  h.view();
  assert.equal(h.windows.length, 2);
});

test("stop closes the viewer, blocks late readiness and requests, and restart can reopen it", async () => {
  const h = harness();
  h.view();
  const first = h.windows[0];
  const handler = h.handlers.get("snapshot");
  await h.plugin.stop();
  first.emit("ready-to-show");
  assert.equal(first.shows, 0);
  assert.equal(first.destroyed, true);
  assert.throws(() => handler({ sender: first.webContents }), /已关闭/);
  h.view();
  assert.equal(h.windows.length, 1);
  h.plugin.start();
  h.view();
  assert.equal(h.windows.length, 2);
  await h.plugin.dispose();
  assert.equal(h.windows[1].destroyed, true);
  assert.equal(h.handlers.size, 0);
});

test("question-history menu opens its tab and reuses the memory window", async (t) => {
  const h = harness(); t.after(() => h.plugin.dispose());
  h.history();
  const win = h.windows[0];
  assert.equal(h.handlers.get("snapshot")({ sender: win.webContents }).viewTab, "question-history");
  h.view(); h.history();
  assert.equal(h.windows.length, 1);
  assert.equal(h.handlers.get("snapshot")({ sender: win.webContents }).viewTab, "question-history");
});

test("long-term inspection handles missing tables and missing storage without hiding recent memory", (t) => {
  const queries = [];
  const storage = { prepare(sql) {
    queries.push(sql);
    return { get: () => null };
  } };
  assert.deepEqual(listEntries(storage), []);
  assert.equal(queries.length, 1);
  assert.match(queries[0], /sqlite_master/);
  const h = harness();
  t.after(() => h.plugin.dispose());
  const snapshot = h.plugin.getSnapshot();
  assert.deepEqual(snapshot.shortTerm.turns, []);
  assert.equal(Object.hasOwn(snapshot, "summary"), false);
  assert.equal(snapshot.longTerm.error, "长期记忆存储不可用");
});

test("cancelling the clear confirmation preserves memory and defaults to cancel", async (t) => {
  let deleted = 0;
  const h = harness({ durable: { clear: () => { deleted++; } }, showMessageBox: async (options) => {
    assert.deepEqual(options.buttons, ["取消", "清空全部记忆"]);
    assert.equal(options.defaultId, 0);
    assert.equal(options.cancelId, 0);
    return { response: 0 };
  } });
  t.after(() => h.plugin.dispose());
  await h.bus.notify(EVENTS.DECISION_COMPLETED, {
    observations: [], result: { reply: "保留这条记忆" },
  });
  const before = h.plugin.getState();
  await h.clearItem().click();
  assert.deepEqual(h.plugin.getState(), before);
  assert.equal(deleted, 0);
  assert.equal(h.clearItem().enabled, true);
});

test("clear waits for confirmation and repeated clicks share a single dialog", async (t) => {
  let resolve;
  let prompts = 0;
  let deleted = 0;
  const h = harness({ durable: { clear: () => { deleted++; return 3; } }, showMessageBox: () => {
    prompts++;
    return new Promise((done) => { resolve = done; });
  } });
  t.after(() => h.plugin.dispose());
  await h.bus.notify(EVENTS.DECISION_COMPLETED, {
    observations: [], result: { reply: "等待确认后清空" },
  });
  const item = h.clearItem();
  const pending = item.click();
  assert.equal(item.click(), pending);
  await new Promise((done) => setImmediate(done));
  assert.equal(prompts, 1);
  assert.equal(deleted, 0);
  assert.equal(h.plugin.getState().turns.length, 1);
  assert.equal(h.clearItem().enabled, false);
  resolve({ response: 1 });
  assert.deepEqual(await pending, { deleted: 3 });
  assert.equal(deleted, 1);
  assert.equal(h.plugin.getState().turns.length, 0);
  assert.equal(h.plugin.getState().totalTurns, 0);
  assert.equal(h.clearItem().enabled, true);
});

test("stopping cancels the dialog and a late confirmation cannot clear restarted memory", async (t) => {
  let resolve;
  let signal;
  let deleted = 0;
  const h = harness({ durable: { clear: () => { deleted++; } }, showMessageBox: (options) => {
    signal = options.signal;
    return new Promise((done) => { resolve = done; });
  } });
  t.after(() => h.plugin.dispose());
  const pending = h.clearItem().click();
  await new Promise((done) => setImmediate(done));
  await h.plugin.stop();
  assert.equal(signal.aborted, true);
  h.plugin.start();
  await h.bus.notify(EVENTS.DECISION_COMPLETED, {
    observations: [], result: { reply: "恢复后的新记忆" },
  });
  resolve({ response: 1 });
  await pending;
  assert.equal(deleted, 0);
  assert.equal(h.plugin.getState().turns[0].reply, "恢复后的新记忆");
});

test("history deletion IPC validates the viewer and preserves the confirmed profile", async (t) => {
  const { db, storage } = workStorage();
  const h = harness({ storage });
  h.config.plugins[0].work = { enabled: true };
  t.after(async () => { await h.plugin.dispose(); db.close(); });
  const repo = createWorkStore(storage);
  repo.applyExtraction({ entities: [], claims: [], questions: [{ subject: { kind: "user", name: "用户" },
    field: "communication", scope: "", prompt: "喜欢怎么解释？", options: [{ label: "结论", value: "先给结论" }, { label: "过程", value: "完整过程" }] }] }, []);
  const question = repo.nextQuestion();
  repo.markShown(question.id);
  repo.answer(question.id, { action: "answer", optionIndex: 0 });
  const profile = repo.profiles()[0];
  const answerId = repo.snapshot().questionHistory[0].records.find((r) => r.action === "answer").id;
  h.view(); const win = h.windows[0]; win.emit("ready-to-show");
  const removeAnswer = h.handlers.get("delete-answer"), removeQuestion = h.handlers.get("delete-question");
  assert.throws(() => removeAnswer({ sender: {} }, { questionId: question.id, answerId }), /来源无效/);
  assert.throws(() => removeQuestion({ sender: win.webContents }, null), /ID 无效/);
  removeAnswer({ sender: win.webContents }, { questionId: question.id, answerId });
  assert.deepEqual(repo.profiles()[0], profile);
  removeQuestion({ sender: win.webContents }, question.id);
  assert.deepEqual(repo.snapshot().questionHistory, []);
  assert.deepEqual(repo.profiles()[0], profile);
  await h.plugin.stop();
  assert.throws(() => removeQuestion({ sender: win.webContents }, question.id), /已关闭/);
});
