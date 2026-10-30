const test = require("node:test");
const assert = require("node:assert/strict");
const { workStorage } = require("./helpers/workStorage");
const { createWorkStore } = require("../electron/plugins/memory/workStore");
const { parseWorkJson, extractWork } = require("../electron/plugins/memory/workExtractor");
const { parseFactsJson } = require("../electron/plugins/memory/extractor");
const { createLongTermStore } = require("../electron/plugins/memory/longTerm");
const { createMemoryPlugin } = require("../electron/plugins/memory");
const { createConversation } = require("../electron/conversation");
const { createDecisionResult } = require("../electron/architecture/contracts");
const { createExecutionModule } = require("../electron/modules/execution");
const { MessageBus } = require("../electron/architecture/messageBus");
const EVENTS = require("../electron/architecture/events");
const quiet = { info() {}, warn() {}, error() {} };
const subject = { kind: "person", name: "张琳" };
const question = { subject, field: "project_role", scope: "支付改造", prompt: "张琳在支付改造中主要负责什么？",
  options: [{ label: "开发对接", value: "开发对接" }, { label: "项目协调", value: "协调推进" }], reason: "最近的讨论中多次出现她", priority: 8 };
function extraction(evidence, value = "服务端接口对接") {
  return { entities: [{ ...subject, aliases: ["琳姐"] }], claims: [{ subject, field: "project_role", scope: "支付改造", value,
    basis: "inference", confidence: 0.7, evidenceIds: [evidence[0].id] }], questions: [question] };
}
function storeHarness(t, now = Date.now) {
  const { db, storage } = workStorage(); t.after(() => db.close());
  const repo = createWorkStore(storage, { now });
  return { repo, storage, db };
}

test("work profiles retain scoped revisions and explicit answers override later guesses", (t) => {
  const { repo } = storeHarness(t);
  repo.addEvidence({ id: "chat", source: "screen", text: "张琳：我来对接支付接口" });
  repo.applyExtraction(extraction(repo.pending()), repo.pending());
  assert.equal(repo.profiles()[0].basis, "inference");
  assert.deepEqual(repo.profiles()[0].aliases, ["琳姐"]);
  const q = repo.nextQuestion();
  repo.answer(q.id, { action: "answer", optionIndex: 1 });
  assert.equal(repo.profiles()[0].value, "协调推进");
  assert.equal(repo.profiles()[0].basis, "user_answer");
  repo.addEvidence({ id: "meeting", source: "audio-output", text: "张琳说由她负责接口" });
  repo.applyExtraction(extraction(repo.pending()), repo.pending());
  assert.equal(repo.profiles()[0].value, "协调推进");
  assert.equal(repo.profiles({ includeHistory: true }).filter((p) => p.status === "superseded").length, 1);
  assert.equal(repo.snapshot().questions.length, 1);
  assert.equal(repo.snapshot().questions[0].status, "answered");
  repo.addEvidence({ id: "other", source: "screen", text: "张琳是报表项目开发对接" });
  const other = extraction(repo.pending()); other.claims[0].scope = "报表项目"; other.questions = [];
  repo.applyExtraction(other, repo.pending());
  assert.equal(repo.profiles().length, 2);
  assert.match(repo.context("支付改造 张琳"), /用户回答/);
  const profile = repo.profiles().find((p) => p.scope === "支付改造");
  repo.correctProfile(profile.id, "现在负责接口开发，协调工作已经交接");
  assert.match(repo.profiles().find((p) => p.scope === "支付改造").value, /已经交接/);
  assert.throws(() => repo.correctProfile(profile.id, "旧版本再次提交"), /已更新/);
});

test("deduplication and invalid evidence references cannot silently consume a pending batch", (t) => {
  let clock = 1000000;
  const { repo, db } = storeHarness(t, () => clock);
  repo.addEvidence({ id: "one", source: "screen", text: "张琳负责支付接口" });
  clock += 1000;
  assert.equal(repo.addEvidence({ id: "overlap", source: "screen", text: "张琳负责支付接口" }), "one");
  assert.equal(repo.pending().length, 1);
  const invalid = extraction(repo.pending()); invalid.claims[0].evidenceIds = ["fabricated-id"];
  assert.throws(() => repo.applyExtraction(invalid, repo.pending()), /来源证据/);
  assert.equal(repo.pending().length, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM work_entities").get().count, 0);
  assert.throws(() => parseWorkJson('{"entities":[],"claims":['), /无效 JSON/);
  assert.throws(() => parseWorkJson("{}"), /结构无效/);
  assert.deepEqual(parseWorkJson('```json\n{"entities":[],"claims":[],"questions":[]}\n```'), { entities: [], claims: [], questions: [] });
});

test("queue, rate limits and pending evidence survive reconstruction; unknown answers do not confirm profiles", (t) => {
  let clock = Date.now();
  const { repo, storage } = storeHarness(t, () => clock);
  repo.addEvidence({ id: "first", source: "screen", text: "张琳对接接口" });
  repo.applyExtraction(extraction(repo.pending()), repo.pending());
  repo.addEvidence({ id: "pending", source: "audio-output", text: "下一场会议还有待整理的事项" });
  repo.setState("attentionNote", "正在推进支付改造");
  const q = repo.nextQuestion(); repo.markShown(q.id);
  const reopened = createWorkStore(storage, { now: () => clock });
  assert.equal(reopened.pending()[0].id, "pending");
  assert.equal(reopened.getState("attentionNote"), "正在推进支付改造");
  assert.equal(reopened.nextQuestion({ cooldownMs: 1800000, dailyLimit: 3 }), null);
  repo.answer(q.id, { action: "unknown" }, { deferMs: 100, maxSkips: 2 });
  assert.equal(repo.profiles()[0].basis, "inference");
  assert.equal(repo.nextQuestion({ manual: true }), null);
  clock += 201;
  assert.equal(repo.nextQuestion({ manual: true }).id, q.id);
  repo.answer(q.id, { action: "skip" }, { deferMs: 100, maxSkips: 2 });
  assert.equal(repo.snapshot().questions[0].status, "dismissed");
  assert.equal(repo.nextQuestion({ manual: true }), null);
});

test("unrelated long-term facts are filtered and malformed fact JSON is retryable", (t) => {
  const { storage } = storeHarness(t);
  const repo = createLongTermStore(storage);
  repo.appendBatch([{ text: "用户喜欢喝咖啡", tags: ["咖啡"], importance: 5 }]);
  assert.deepEqual(repo.retrieve("量子纠缠实验"), []);
  assert.equal(repo.retrieve("咖啡").length, 1);
  assert.throws(() => parseFactsJson('[{"text":"用户喜欢喝咖啡"'), /无效 JSON/);
  assert.deepEqual(parseFactsJson("[]"), []);
});

test("questions prefer stable user profiles, respect deferral, and retain other questions as fallback", (t) => {
  const { repo } = storeHarness(t);
  const user = { kind: "user", name: "用户" };
  repo.applyExtraction({ entities: [], claims: [], questions: [
    { ...question, priority: 10 },
    { ...question, subject: user, field: "task", prompt: "你正在处理什么任务？", priority: 10 },
    { ...question, subject: user, field: "communication", scope: "", prompt: "你更喜欢怎样的沟通方式？", priority: 1 },
  ] }, []);
  const profile = repo.nextQuestion();
  assert.equal(profile.subject.kind, "user");
  assert.equal(profile.field, "communication");
  assert.equal(repo.nextQuestion({ manual: true }).id, profile.id);
  repo.answer(profile.id, { action: "defer" });
  assert.equal(repo.nextQuestion().subject.kind, "person");
  assert.equal(repo.nextQuestion({ manual: true }).subject.kind, "person");
});

test("work details become pending sources while relationship information stays in profiles", async (t) => {
  const { storage } = storeHarness(t);
  const h = memoryHarness(storage, async (messages) => {
    const { evidence } = JSON.parse(messages[1].content);
    return JSON.stringify({ entities: [], questions: [], claims: [
      { subject: { kind: "user", name: "用户" }, field: "task", scope: "支付项目", value: "已确认接口重试需要幂等校验", basis: "observation", evidenceIds: [evidence[0].id] },
      { subject: { kind: "person", name: "张琳" }, field: "relationship", scope: "", value: "用户经常协作的同事", basis: "observation", evidenceIds: [evidence[0].id] },
    ], summary: "正在讨论支付项目，确认重试需要幂等校验。" });
  });
  h.config.plugins[0].longTerm.enabled = true;
  t.after(() => h.plugin.dispose());
  await h.bus.notify(EVENTS.PERCEPTION_OBSERVATION_QUEUED, { observation: { id: "routing", role: "user", source: "manual-input",
    content: [{ type: "text", text: "我和同事张琳确认支付项目接口重试需要幂等校验" }] } });
  await h.plugin.whenIdle();
  const snapshot = h.plugin.getSnapshot();
  assert.equal(snapshot.work.profiles.length, 1);
  assert.equal(snapshot.work.profiles[0].field, "relationship");
  assert.equal(Object.hasOwn(snapshot, "summary"), false);
  assert.equal(snapshot.longTerm.entries.length, 0);
  const sources = require("../electron/plugins/memory/updateBuffer").createUpdateBuffer(storage).evidence();
  assert.equal(sources[0].id, "routing");
  assert.match(sources[0].text, /支付项目.*幂等校验/);
  assert.equal(snapshot.work.pending, 0);
});

test("failed pending-source staging preserves evidence and does not update profiles", async (t) => {
  const { storage } = storeHarness(t);
  const h = memoryHarness(storage, async (messages) => {
    const { evidence } = JSON.parse(messages[1].content);
    return JSON.stringify({ entities: [], questions: [], claims: [], summary: "不应保存的摘要",
      facts: [{ text: "接口结论待确认", type: "event", tags: [], importance: 2, evidenceIds: [evidence[0].id] }] });
  });
  h.config.plugins[0].longTerm.enabled = true;
  createLongTermStore(storage);
  require("../electron/plugins/memory/updateBuffer").createUpdateBuffer(storage);
  storage.exec(`CREATE TRIGGER reject_routed_fact BEFORE INSERT ON memory_update_sources BEGIN SELECT RAISE(ABORT, 'blocked'); END`);
  t.after(() => h.plugin.dispose());
  await h.bus.notify(EVENTS.PERCEPTION_OBSERVATION_QUEUED, { observation: { id: "pending-route", source: "audio-output", role: "context",
    content: [{ type: "text", text: "讨论接口结论" }] } });
  await h.plugin.whenIdle();
  assert.equal(Object.hasOwn(h.plugin.getState(), "sessionSummary"), false);
  assert.equal(h.plugin.getSnapshot().work.pending, 1);
  assert.deepEqual(h.plugin.getSnapshot().longTerm.entries, []);
});

test("legacy work details migrate without losing confirmed content or unrelated long-term facts", (t) => {
  const { repo, storage } = storeHarness(t);
  const long = createLongTermStore(storage);
  long.appendBatch([{ text: "用户喜欢阅读技术书籍" }]);
  repo.applyExtraction({ entities: [], questions: [], claims: [
    { subject: { kind: "user", name: "用户" }, field: "task", scope: "支付项目", value: "确认使用幂等校验", evidenceIds: ["legacy"] },
    { subject: { kind: "person", name: "同事" }, field: "relationship", scope: "", value: "用户的同事", evidenceIds: ["legacy"] },
  ] }, [{ id: "legacy" }]);
  const task = repo.profiles().find((p) => p.field === "task");
  repo.correctProfile(task.id, "重试必须进行幂等校验");
  const confirmed = repo.profiles().find((p) => p.field === "task");
  assert.deepEqual(repo.migrateWorkDetails(long), { moved: 1 });
  assert.equal(repo.profiles().length, 1);
  assert.equal(repo.profiles()[0].field, "relationship");
  const migrated = long.list().find((fact) => fact.text.includes("幂等校验"));
  assert.equal(migrated.metadata.basis, "user_answer");
  assert.deepEqual(migrated.metadata.sourceProfileIds, [confirmed.id]);
  assert.ok(long.list().some((fact) => fact.text === "用户喜欢阅读技术书籍"));
  assert.deepEqual(repo.migrateWorkDetails(long), { moved: 0 });
});

test("history deletion removes answers and whole questions while retaining confirmed profiles", (t) => {
  const { repo, storage } = storeHarness(t);
  repo.addEvidence({ id: "history-delete", source: "screen", text: "张琳负责接口" });
  repo.applyExtraction(extraction(repo.pending()), repo.pending());
  const q = repo.nextQuestion(); repo.markShown(q.id);
  repo.answer(q.id, { action: "answer", optionIndex: 0 });
  const before = repo.profiles();
  const records = repo.snapshot().questionHistory[0].records;
  const answer = records.find((r) => r.action === "answer");
  assert.throws(() => repo.deleteAnswer("foreign-question", answer.id), /不存在/);
  assert.throws(() => repo.deleteAnswer(q.id, records.find((r) => r.action === "shown").id), /答案不存在/);
  repo.deleteAnswer(q.id, answer.id);
  assert.deepEqual(repo.snapshot().questionHistory[0].records.map((r) => r.action), ["shown"]);
  assert.deepEqual(repo.profiles(), before);
  repo.deleteQuestion(q.id);
  assert.deepEqual(repo.snapshot().questionHistory, []);
  assert.deepEqual(repo.profiles(), before);
  assert.equal(storage.prepare("SELECT COUNT(*) AS count FROM work_question_answers").get().count, 0);
});

test("user profiles survive crowded extraction context and answers update the user profile", async (t) => {
  const { repo } = storeHarness(t);
  const user = { subject: { kind: "user", name: "用户" }, field: "responsibility", scope: "",
    value: "服务端开发", basis: "user_answer", aliases: [] };
  const others = Array.from({ length: 45 }, (_, i) => ({ ...user,
    subject: { kind: "person", name: `同事${i}` }, basis: "inference" }));
  const profiles = [...others, user];
  const result = await extractWork({ evidence: [{ id: "chat", source: "user", text: "我喜欢直接看结论" }], profiles,
    callChat: async (messages) => {
      const input = JSON.parse(messages[1].content);
      assert.equal(input.currentProfiles.length, 40);
      assert.deepEqual(input.currentProfiles[0].subject, user.subject);
      assert.equal(input.currentProfiles[0].basis, "user_answer");
      return JSON.stringify({ entities: [], claims: [], questions: [{ ...question,
        subject: user.subject, field: "communication", scope: "", prompt: "你更喜欢先给结论还是完整过程？",
        options: [{ label: "先给结论", value: "先给结论再补充必要细节" }, { label: "完整过程", value: "说明完整过程" }] }] });
    } });
  assert.equal(profiles[0].subject.kind, "person");
  repo.applyExtraction(result, []);
  const q = repo.nextQuestion();
  repo.answer(q.id, { action: "answer", optionIndex: 0 });
  assert.equal(repo.profiles()[0].subject.kind, "user");
  assert.equal(repo.profiles()[0].field, "communication");
  assert.equal(repo.profiles()[0].value, "先给结论再补充必要细节");
});

test("question history preserves every display and response across reopening and excludes unasked candidates", (t) => {
  let clock = Date.now();
  const { repo, storage } = storeHarness(t, () => clock);
  repo.addEvidence({ id: "chat-history", source: "screen", text: "张琳与王哲讨论支付分工" });
  const batch = extraction(repo.pending());
  batch.questions.push({ ...question, subject: { kind: "person", name: "王哲" }, prompt: "王哲负责什么？" });
  repo.applyExtraction(batch, repo.pending());
  const q = repo.nextQuestion();
  repo.markShown(q.id); clock += 1;
  repo.answer(q.id, { action: "defer" }, { deferMs: 10 }); clock += 11;
  repo.markShown(q.id); clock += 1;
  repo.answer(q.id, { action: "answer", text: "负责项目协调" });
  const reopened = createWorkStore(storage, { now: () => clock });
  const history = reopened.snapshot().questionHistory;
  assert.equal(history.length, 1);
  assert.equal(history[0].prompt, question.prompt);
  assert.equal(history[0].status, "answered");
  assert.deepEqual(history[0].records.map((r) => r.action), ["shown", "defer", "shown", "answer"]);
  assert.equal(history[0].records.at(-1).value, "负责项目协调");
  reopened.clear();
  assert.deepEqual(reopened.snapshot().questionHistory, []);
});

function memoryHarness(storage, generate, clock = Date.now) {
  const bus = new MessageBus({ logger: quiet });
  const services = new Map([["storage-sqlite.database", storage], ["model.text", generate]]);
  const config = { plugins: [{ name: "memory", enabled: true,
    longTerm: { enabled: false }, work: { enabled: true, extractEveryNObservations: 1 } }] };
  let provide;
  const plugin = createMemoryPlugin({ bus, logger: quiet, config: { get: () => config },
    model: { get generateText() { return services.get("model.text"); } },
    services: { get: (name) => services.get(name), register: (name, service) => { services.set(`memory.${name}`, service); return () => services.delete(`memory.${name}`); } },
    decisionContext: { register: (fn) => { provide = fn; return () => {}; } },
  }, { now: clock });
  return { plugin, bus, services, config, context: (input) => provide(input) };
}

test("raw meeting speech is remembered without any pet reply and failed extraction retains evidence", async (t) => {
  const { storage } = storeHarness(t);
  let calls = 0;
  const h = memoryHarness(storage, async (messages) => {
    if (++calls === 1) return "truncated";
    const { evidence } = JSON.parse(messages[1].content);
    return JSON.stringify(extraction(evidence));
  });
  t.after(() => h.plugin.dispose());
  const observation = { id: "meeting", source: "audio-output", role: "context", capturedAt: new Date().toISOString(),
    content: [{ type: "text", text: "本次联调请张琳负责接口，我来协调" }], metadata: { modality: "audio", confidence: 0.87 } };
  await h.bus.notify(EVENTS.PERCEPTION_OBSERVATION_QUEUED, { observation });
  await h.plugin.whenIdle();
  assert.equal(h.plugin.getSnapshot().work.pending, 1);
  h.context({ observations: [observation] });
  await h.plugin.whenIdle();
  assert.equal(calls, 1, "reading context does not retry background extraction");
  h.plugin.start();
  await h.plugin.whenIdle();
  const snapshot = h.plugin.getSnapshot();
  assert.equal(snapshot.totalTurns, 0);
  assert.equal(snapshot.work.pending, 0);
  assert.equal(snapshot.work.profiles[0].subject.name, "张琳");
  assert.equal(snapshot.work.recentEvidence[0].metadata.confidence, 0.87);
  assert.ok(h.context({ observations: [observation] }).some((b) => b.id === "work-profiles"));
});

test("late extraction cannot repopulate cleared memory or its question queue", async (t) => {
  const { storage } = storeHarness(t);
  let resolve;
  const request = new Promise((yes) => { resolve = yes; });
  let input;
  const h = memoryHarness(storage, async (messages) => { input = JSON.parse(messages[1].content); return request; });
  t.after(() => h.plugin.dispose());
  await h.bus.notify(EVENTS.PERCEPTION_OBSERVATION_QUEUED, { observation: { id: "old", source: "audio-output", role: "context",
    content: [{ type: "text", text: "张琳负责支付接口" }] } });
  await new Promise((yes) => setImmediate(yes));
  const cleared = h.plugin.clear();
  resolve(JSON.stringify(extraction(input.evidence)));
  await cleared;
  assert.equal(h.plugin.getSnapshot().work.profiles.length, 0);
  assert.equal(h.plugin.getSnapshot().work.questions.length, 0);
  assert.equal(h.plugin.getSnapshot().work.pending, 0);
});

test("work observations survive disposal while legacy session summaries are removed", async (t) => {
  const { storage } = storeHarness(t);
  const h = memoryHarness(storage, async () => "not-json");
  await h.bus.notify(EVENTS.PERCEPTION_OBSERVATION_QUEUED, { observation: { id: "persist", source: "audio-output", role: "context",
    content: [{ type: "text", text: "张琳负责支付接口" }] } });
  await h.plugin.whenIdle();
  createWorkStore(storage).setState("sessionSummary", "支付改造还在联调");
  storage.prepare("UPDATE test_migrations SET version = 2 WHERE namespace = ?").run("work-memory");
  await h.plugin.dispose();
  const reopened = memoryHarness(storage, async (messages) => JSON.stringify(extraction(JSON.parse(messages[1].content).evidence)));
  t.after(() => reopened.plugin.dispose());
  assert.equal(Object.hasOwn(reopened.plugin.getState(), "sessionSummary"), false);
  assert.equal(reopened.plugin.getSnapshot().work.pending, 1);
  assert.equal(storage.prepare("SELECT value FROM work_memory_state WHERE key = ?").get("sessionSummary"), undefined);
  reopened.plugin.start(); await reopened.plugin.whenIdle();
  assert.equal(reopened.plugin.getSnapshot().work.profiles[0].subject.name, "张琳");
});

test("passive decisions can remain silent while preserving screenshot work evidence", async (t) => {
  const { storage } = storeHarness(t);
  const bus = new MessageBus({ logger: quiet }), bubbles = [], speeches = [];
  const execution = createExecutionModule(bus, { sendBubble: (bubble) => bubbles.push(bubble) });
  t.after(() => execution.dispose());
  bus.subscribe(EVENTS.SPEECH_OUTPUT_REQUESTED, (input) => speeches.push(input));
  const h = memoryHarness(storage, async (messages) => JSON.stringify(extraction(JSON.parse(messages[1].content).evidence)));
  t.after(() => h.plugin.dispose());
  let output = { shouldSpeak: false, expression: "neutral", response: "", audioSummary: "", screenSummary: "飞书聊天", workSummary: "张琳在支付群里明确说负责接口联调" };
  const chat = createConversation({ getConfig: () => ({ conversation: { ai: {
    endpoint: "https://example.invalid", apiKey: "test", model: "test" } } }), getExpressions: () => ["neutral"],
    configureProxy: async () => {}, encodeImage: () => "image", writeLog() {}, logger: quiet,
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }] }) }),
  });
  const observations = [{ id: "shot", source: "screen", role: "context", capturedAt: new Date().toISOString(), content: [{ type: "image", path: "/virtual.jpg" }] }];
  const result = createDecisionResult(await chat.decideFromObservations(observations));
  assert.equal(result.speak, false);
  assert.equal(result.reply, "");
  const event = { id: "decision", observations, result };
  await bus.notify(EVENTS.DECISION_COMPLETED, event);
  await execution.presentDecision(event);
  await h.bus.notify(EVENTS.DECISION_COMPLETED, event);
  await h.plugin.whenIdle();
  assert.equal(speeches.length, 0);
  assert.deepEqual(bubbles.at(-1), { type: "hide" });
  assert.equal(h.plugin.getSnapshot().work.profiles.length, 1);
  assert.equal(h.plugin.getState().turns[0].speak, false);
  const evidence = h.plugin.getSnapshot().work.recentEvidence[0];
  assert.equal(evidence.source, "screen");
  assert.deepEqual(evidence.metadata.observationIds, ["shot"]);
  output = { shouldSpeak: true, expression: "neutral", response: "明白，张琳在对接接口", screenSummary: "", audioSummary: "", workSummary: "" };
  const direct = await chat.decideFromObservations([{ source: "manual-input", role: "user", content: [{ type: "text", text: "张琳负责什么？" }] }]);
  assert.equal(direct.speak, undefined);
  assert.equal(direct.reply, "明白，张琳在对接接口");
});

module.exports = { question };
