const test = require("node:test");
const assert = require("node:assert/strict");
const { workStorage, mockWindows } = require("./helpers/workStorage");
const { createWorkStore } = require("../electron/plugins/memory/workStore");
const { createQuestionsPlugin } = require("../electron/plugins/questions");
const { getOptions } = require("../electron/plugins/questions/options");
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
  const expiries = [];
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
  }, { now: () => clock, setTimer: () => { timers++; return { unref() {} }; }, clearTimer: () => { timers--; },
    setExpiryTimer: (callback, ms) => { const timer = { callback, ms, cleared: false, unref() {} }; expiries.push(timer); return timer; },
    clearExpiryTimer: (timer) => { timer.cleared = true; } });
  t.after(() => { plugin.dispose(); db.close(); });
  function seed(name = "张琳") {
    repo.addEvidence({ id: name, source: "screen", text: `${name}参与支付讨论` });
    repo.applyExtraction({ entities: [], claims: [], questions: [{ subject: { kind: "person", name }, field: "project_role", scope: "支付项目",
      prompt: `${name}主要负责什么？`, options: [{ label: "开发", value: "接口开发" }, { label: "协调", value: "项目协调" }], reason: "最近多次出现", priority: 5 }] }, repo.pending());
  }
  return { repo, storage, plugin, bus, handlers, windows: windowService.windows, config, seed,
    idle: (value) => { idle = value; }, advance: (ms) => { clock += ms; }, now: () => clock,
    menu: () => menu(), timers: () => timers, expiries };
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
  assert.equal(win.destroyed, false);
});

test("background decisions, speech and observations preserve the displayed question and allow answering", async (t) => {
  const h = harness(t); h.seed(); h.plugin.tick();
  const win = h.windows[0]; win.emit("ready-to-show");
  const question = h.handlers.get("current")({ sender: win.webContents });
  await h.bus.notify(EVENTS.DECISION_STARTED, { id: "background" });
  await h.bus.notify(EVENTS.SPEECH_OUTPUT_STATE, { state: "start", playbackId: "voice" });
  for (const observation of [{ source: "audio-output" }, { role: "user", source: "chat" }]) {
    await h.bus.notify(EVENTS.PERCEPTION_OBSERVATION_QUEUED, { observation });
  }
  await h.bus.notify(EVENTS.WORK_MEMORY_UPDATED, {});
  h.idle(0); h.plugin.tick();
  assert.equal(win.destroyed, false);
  assert.equal(h.handlers.get("current")({ sender: win.webContents }).id, question.id);
  assert.deepEqual(h.repo.snapshot().questionHistory[0].records.map((event) => event.action), ["shown"]);
  h.handlers.get("answer")({ sender: win.webContents }, { action: "answer", text: "主要负责开发" });
  assert.equal(h.repo.profiles()[0].value, "主要负责开发");
  assert.equal(win.destroyed, true);
  h.seed("李明"); h.idle(20); h.advance(1000); h.plugin.tick();
  assert.equal(h.windows.length, 1); // Background work still gates the next popup.
  await h.bus.notify(EVENTS.DECISION_COMPLETED, { id: "background" });
  await h.bus.notify(EVENTS.SPEECH_OUTPUT_STATE, { state: "end", playbackId: "voice" });
  h.plugin.tick(); assert.equal(h.windows.length, 2);
});

test("only untouched automatic questions expire; focus, input and manual opening protect answers", (t) => {
  const h = harness(t); h.seed(); h.plugin.tick();
  const untouched = h.windows[0]; untouched.emit("ready-to-show");
  assert.equal(h.expiries[0].ms, 90000);
  h.expiries[0].callback(); assert.equal(untouched.destroyed, true);
  assert.ok(h.repo.snapshot().questions[0].nextAt > h.now());
  for (const interaction of ["focus", "activity", "manual"]) {
    h.advance(1000); h.plugin.tick();
    const win = h.windows.at(-1); win.emit("ready-to-show");
    const expiry = h.expiries.at(-1);
    const activity = h.handlers.get("activity");
    assert.throws(() => activity({ sender: {} }), /来源无效/);
    if (interaction === "focus") win.emit("focus");
    else if (interaction === "activity") activity({ sender: win.webContents });
    else h.plugin.show({ manual: true });
    assert.equal(expiry.cleared, true);
    expiry.callback(); // Even an already queued timeout cannot destroy an active answer.
    h.advance(90001); h.plugin.tick(); assert.equal(win.destroyed, false);
    h.handlers.get("answer")({ sender: win.webContents }, { action: "defer" });
  }
  h.advance(1000); h.plugin.show({ manual: true });
  const manual = h.windows.at(-1), count = h.expiries.length;
  manual.emit("ready-to-show"); assert.equal(h.expiries.length, count);
  h.advance(90001); h.plugin.tick(); assert.equal(manual.destroyed, false);
  assert.throws(() => h.handlers.get("activity")({ sender: untouched.webContents }), /来源无效/);
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

test("removing a displayed question deletes its history without recording an answer or updating memory", (t) => {
  const h = harness(t); h.seed(); h.seed("李明");
  const selected = h.repo.nextQuestion({ manual: true });
  h.repo.markShown(selected.id);
  h.repo.answer(selected.id, { action: "defer" }, { deferMs: 100 });
  h.advance(1000);
  h.plugin.tick();
  const win = h.windows[0]; win.emit("ready-to-show");
  const question = h.handlers.get("current")({ sender: win.webContents });
  assert.equal(question.id, selected.id);
  const before = h.repo.snapshot();
  const daily = h.repo.getState("questionDaily");
  const lastQuestionAt = h.repo.getState("lastQuestionAt");
  const answer = h.handlers.get("answer");
  assert.throws(() => answer({ sender: {} }, { action: "remove" }), /来源无效/);
  assert.equal(win.destroyed, false);
  const result = answer({ sender: win.webContents }, { action: "remove", text: "不应记录的草稿", optionIndex: 0 });
  assert.deepEqual(result, { ok: true, action: "remove" });
  assert.equal(win.destroyed, true);
  assert.equal(h.expiries[0].cleared, true);
  h.expiries[0].callback(); // A late expiry must not turn removal into deferral.
  assert.throws(() => answer({ sender: win.webContents }, { action: "remove" }), /已关闭/);
  assert.throws(() => h.repo.getQuestion(question.id), /不存在/);
  assert.equal(h.storage.prepare("SELECT COUNT(*) AS count FROM work_question_answers WHERE question_id = ?").get(question.id).count, 0);
  const after = h.repo.snapshot();
  assert.deepEqual(after.profiles, before.profiles);
  assert.deepEqual(after.recentEvidence, before.recentEvidence);
  assert.equal(after.questions.length, 1);
  assert.ok(after.questions.every((q) => q.id !== question.id));
  assert.deepEqual(after.questionHistory, before.questionHistory.filter((q) => q.id !== question.id));
  assert.deepEqual(h.repo.getState("questionDaily"), daily);
  assert.equal(h.repo.getState("lastQuestionAt"), lastQuestionAt);
  const reopened = createWorkStore(h.storage, { now: h.now });
  assert.throws(() => reopened.getQuestion(question.id), /不存在/);
  assert.ok(reopened.nextQuestion({ manual: true }));
  assert.ok(reopened.nextQuestion({ manual: true }).id !== question.id);
});

test("removal fails atomically and keeps the popup open when deleting the question fails", (t) => {
  const h = harness(t); h.seed(); h.plugin.show({ manual: true });
  const win = h.windows[0]; win.emit("ready-to-show");
  const before = h.repo.snapshot();
  h.storage.exec(`CREATE TRIGGER prevent_question_removal BEFORE DELETE ON work_questions
    BEGIN SELECT RAISE(ABORT, 'delete failed'); END`);
  assert.throws(() => h.handlers.get("answer")({ sender: win.webContents }, { action: "remove" }), /delete failed/);
  assert.equal(win.destroyed, false);
  assert.deepEqual(h.repo.snapshot(), before);
  h.storage.exec("DROP TRIGGER prevent_question_removal");
  h.handlers.get("answer")({ sender: win.webContents }, { action: "remove" });
  assert.equal(win.destroyed, true);
  assert.deepEqual(h.repo.snapshot().questions, []);
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

test("default automatic questions have no daily cap or interval but preserve per-question deferral", (t) => {
  const h = harness(t);
  const options = getOptions({ plugins: [{ name: "questions", enabled: true }] });
  assert.equal(options.dailyLimit, 0);
  assert.equal(options.cooldownMs, 0);
  assert.equal(options.deferMs, 1800000);
  for (const name of ["张琳", "王哲", "李明", "小周", "小陈"]) h.seed(name);
  for (let i = 0; i < 4; i++) {
    const q = h.repo.nextQuestion(options);
    assert.ok(q); h.repo.markShown(q.id); h.repo.answer(q.id, { action: "answer", optionIndex: 0 });
  }
  const deferred = h.repo.nextQuestion(options); assert.ok(deferred);
  h.repo.answer(deferred.id, { action: "defer" }, options);
  assert.equal(h.repo.nextQuestion(options), null);
});

test("pause-today menu suppresses automatic questions and can resume them", (t) => {
  const h = harness(t); h.seed();
  h.menu()[0].submenu[1].click(); h.plugin.tick(); assert.equal(h.windows.length, 0);
  assert.equal(h.menu()[0].submenu[1].label, "恢复自动提问");
  assert.ok(h.repo.getState("questionsPausedUntil") > h.now());
  h.menu()[0].submenu[1].click(); h.plugin.tick(); assert.equal(h.windows.length, 1);
});
