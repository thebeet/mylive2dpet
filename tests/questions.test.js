const test = require("node:test");
const assert = require("node:assert/strict");
const { workStorage, mockWindows } = require("./helpers/workStorage");
const { createWorkStore } = require("../electron/plugins/memory/workStore");
const { createQuestionsPlugin } = require("../electron/plugins/questions");
const { MessageBus } = require("../electron/architecture/messageBus");
const EVENTS = require("../electron/architecture/events");
const quiet = { info() {}, warn() {}, error() {} };

function harness(t) {
  const { db, storage } = workStorage();
  let clock = Date.now(), idle = 20;
  const repo = createWorkStore(storage, { now: () => clock });
  const bus = new MessageBus({ logger: quiet }), windowService = mockWindows(), handlers = new Map();
  const config = { plugins: [{ name: "questions", enabled: true, cooldownMs: 100, deferMs: 100, timeoutMs: 90000 }] };
  let menu, timers = 0;
  const api = { nextQuestion: (config) => repo.nextQuestion(config), getQuestion: repo.getQuestion,
    markShown: repo.markShown, answer: repo.answer,
    pauseQuestions: (until) => repo.setState("questionsPausedUntil", until),
    attention: () => ({ audioUntil: repo.getState("audioUntil", 0), meetingUntil: repo.getState("meetingUntil", 0), questionsPausedUntil: repo.getState("questionsPausedUntil", 0) }) };
  const plugin = createQuestionsPlugin({ bus, logger: quiet, config: { get: () => config },
    services: { get: () => api }, windows: windowService,
    attention: { getIdleSeconds: () => idle },
    pet: { getBounds: () => ({ x: 600, y: 650, width: 380, height: 560 }) },
    screen: { getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
      getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
    menu: { register: (provide) => { menu = provide; return () => { menu = null; }; }, refresh() {} },
    ipc: { handle: (name, handler) => { handlers.set(name, handler); return () => handlers.delete(name); } },
  }, { now: () => clock, setTimer: () => { timers++; return { unref() {} }; }, clearTimer: () => { timers--; } });
  t.after(() => { plugin.dispose(); db.close(); });
  function seed(name = "张琳") {
    repo.addEvidence({ id: name, source: "screen", text: `${name}参与支付讨论` });
    repo.applyExtraction({ entities: [], claims: [], questions: [{ subject: { kind: "person", name }, field: "project_role", scope: "支付项目",
      prompt: `${name}主要负责什么？`, options: [{ label: "开发", value: "接口开发" }, { label: "协调", value: "项目协调" }], reason: "最近多次出现", priority: 5 }] }, repo.pending());
  }
  return { repo, storage, plugin, bus, handlers, windows: windowService.windows, config, seed,
    idle: (value) => { idle = value; }, advance: (ms) => { clock += ms; }, now: () => clock,
    menu: () => menu(), timers: () => timers };
}

test("automatic questions wait for idle, silence and meeting cooldown, without stealing focus", async (t) => {
  const h = harness(t); h.seed(); h.plugin.start();
  h.idle(0); h.plugin.tick(); assert.equal(h.windows.length, 0);
  h.idle(20); h.repo.setState("meetingUntil", h.now() + 1000);
  h.plugin.tick(); assert.equal(h.windows.length, 0);
  h.advance(1001);
  await h.bus.notify(EVENTS.DECISION_STARTED, { id: "busy" });
  h.plugin.tick(); assert.equal(h.windows.length, 0);
  await h.bus.notify(EVENTS.DECISION_COMPLETED, { id: "busy" });
  h.plugin.tick(); assert.equal(h.windows.length, 1);
  const win = h.windows[0]; win.emit("ready-to-show");
  assert.equal(win.shows, 1); assert.equal(win.focuses, 0); assert.equal(win.inactive, true);
  assert.equal(win.options.webPreferences.sandbox, true);
  h.idle(0); h.plugin.tick(); assert.equal(win.destroyed, false);
  await h.bus.notify(EVENTS.PERCEPTION_OBSERVATION_QUEUED, { observation: { source: "audio-output" } });
  assert.equal(win.destroyed, true);
  assert.ok(h.repo.snapshot().questions[0].nextAt > h.now());
});

test("answers validate sender and selected option, update profile immediately, and close only once", (t) => {
  const h = harness(t); h.seed();
  h.plugin.show({ manual: true });
  const win = h.windows[0]; win.emit("ready-to-show");
  const current = h.handlers.get("current"), answer = h.handlers.get("answer");
  assert.throws(() => current({ sender: {} }), /来源无效/);
  assert.throws(() => answer({ sender: {} }, { action: "answer", optionIndex: 0 }), /来源无效/);
  assert.throws(() => answer({ sender: win.webContents }, { action: "answer", optionIndex: 99 }), /请选择/);
  assert.throws(() => answer({ sender: win.webContents }, { action: "answer", text: "a".repeat(601) }), /过长/);
  const result = answer({ sender: win.webContents }, { action: "answer", optionIndex: 1 });
  assert.equal(result.value, "项目协调");
  assert.equal(h.repo.profiles()[0].basis, "user_answer");
  assert.equal(h.repo.profiles()[0].scope, "支付项目");
  assert.equal(win.destroyed, true);
  assert.throws(() => answer({ sender: win.webContents }, { action: "answer", optionIndex: 0 }), /已关闭/);
});

test("stopping and clearing reject late answers and late window readiness", async (t) => {
  const h = harness(t); h.seed(); h.plugin.start();
  h.plugin.show({ manual: true }); const win = h.windows[0], answer = h.handlers.get("answer");
  h.plugin.stop(); win.emit("ready-to-show");
  assert.equal(win.shows, 0); assert.equal(h.timers(), 0);
  assert.throws(() => answer({ sender: win.webContents }, { action: "answer", optionIndex: 0 }), /已关闭/);
  h.advance(1000); h.plugin.start(); h.plugin.show({ manual: true }); const reopened = h.windows[1];
  h.repo.clear(); await h.bus.notify(EVENTS.MEMORY_CLEARED, {});
  reopened.emit("ready-to-show"); assert.equal(reopened.shows, 0);
  assert.throws(() => answer({ sender: reopened.webContents }, { action: "answer", optionIndex: 0 }), /已关闭/);
  assert.equal(h.repo.profiles().length, 0);
});

test("manual questions remain open when automatic questions are disabled", (t) => {
  const h = harness(t); h.seed(); h.config.plugins[0].auto = false; h.idle(0);
  assert.equal(h.plugin.show({ manual: true }), true);
  const win = h.windows[0]; win.emit("ready-to-show");
  h.plugin.tick(); assert.equal(win.destroyed, false); assert.equal(win.focuses, 1);
  h.handlers.get("answer")({ sender: win.webContents }, { action: "unknown" });
  assert.equal(h.repo.profiles().length, 0);
});

test("daily limits survive repository reopening; manual selection can bypass the daily limit", (t) => {
  const h = harness(t); for (const name of ["张琳", "王哲", "李明", "小周"]) h.seed(name);
  for (let i = 0; i < 3; i++) {
    const q = h.repo.nextQuestion({ cooldownMs: 100, dailyLimit: 3 });
    assert.ok(q); h.repo.markShown(q.id); h.repo.answer(q.id, { action: "answer", optionIndex: 0 }); h.advance(101);
  }
  const reopened = createWorkStore(h.storage, { now: h.now });
  assert.equal(reopened.nextQuestion({ cooldownMs: 100, dailyLimit: 3 }), null);
  assert.ok(reopened.nextQuestion({ manual: true }));
});

test("pause-today menu suppresses automatic questions and can resume them", (t) => {
  const h = harness(t); h.seed();
  h.menu()[0].submenu[1].click(); h.plugin.tick(); assert.equal(h.windows.length, 0);
  assert.equal(h.menu()[0].submenu[1].label, "恢复自动提问");
  assert.ok(h.repo.getState("questionsPausedUntil") > h.now());
  h.menu()[0].submenu[1].click(); h.plugin.tick(); assert.equal(h.windows.length, 1);
});
