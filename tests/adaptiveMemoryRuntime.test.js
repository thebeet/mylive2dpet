const test = require("node:test");
const assert = require("node:assert/strict");
const { harness, emptyPlan, candidate, seed } = require("./helpers/adaptiveMemory");
const { createConversation } = require("../electron/conversation");
const { createLongTermStore } = require("../electron/plugins/memory/longTerm");
const { createWorkStore } = require("../electron/plugins/memory/workStore");
const { migrateLegacy } = require("../electron/plugins/memory/migration");
const { petPayload } = require("./helpers/petPayload");
const EVENTS = require("../electron/architecture/events");
const settle = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test("direct user statements are maintained promptly with model-defined topics", async t => {
  const h = harness(t, { generate: async messages => {
    const input = JSON.parse(messages[1].content); return JSON.stringify({ ...emptyPlan(), upsert: [candidate(input.pending[0], { title: "追剧进度", topics: ["追剧进度"], aliases: ["那部剧看到哪了"] })] });
  } });
  await h.record("我追《迷雾》，看到第五集了。"); await h.plugin.whenIdle();
  assert.equal(h.repo.list().length, 1); assert.equal(h.repo.stats().pending, 0);
  const blocks = await h.providers.collect({ observations: [h.observation("那部剧看到哪了")], conversationHistory: true });
  assert.equal(blocks[0].scope, "turn"); assert.ok(blocks[0].text.includes("第五集"));
  assert.deepEqual(h.repo.list()[0].topics, ["追剧进度"]);
});
test("background observations use event/time thresholds without forcing speech", async t => {
  let clock = 10000, calls = 0;
  const h = harness(t, { now: () => clock, generate: async () => { calls++; return JSON.stringify(emptyPlan()); }, options: { maintenance: { extractEveryNEvents: 3, flushAfterMs: 60000 } } });
  await h.record("", { observations: [h.observation("画面出现游戏菜单", "context", "screen")], result: { reply: "", speak: false } });
  await h.plugin.whenIdle(); assert.equal(calls, 0); assert.equal(h.repo.stats().pending, 1);
  clock += 61000; h.plugin.start(); await h.plugin.whenIdle(); assert.equal(calls, 1); assert.equal(h.repo.stats().pending, 0);
});
test("disabling recent memory does not disable durable source extraction", async t => {
  const h = harness(t, { options: { shortTerm: { enabled: false } }, generate: async messages => {
    const input = JSON.parse(messages[1].content); return JSON.stringify({ ...emptyPlan(), upsert: [candidate(input.pending[0])] });
  } });
  await h.record("我最近在学日语"); await h.plugin.whenIdle();
  assert.equal(h.plugin.getSnapshot().shortTerm.turns.length, 0); assert.equal(h.repo.list().length, 1);
});
test("arrivals during extraction are handled in a later snapshot exactly once", async t => {
  const pending = deferred(), inputs = [];
  const h = harness(t, { generate: async messages => { inputs.push(JSON.parse(messages[1].content)); return inputs.length === 1 ? pending.promise : JSON.stringify(emptyPlan()); } });
  await h.record("先说一件事"); await settle(); await h.record("又想起另一件事");
  pending.resolve(JSON.stringify(emptyPlan())); await h.plugin.whenIdle();
  assert.equal(inputs.length, 2); assert.equal(inputs[0].pending.length, 1); assert.equal(inputs[1].pending.length, 1); assert.equal(h.repo.stats().pending, 0);
});
test("failed extraction keeps raw evidence and read-only recall does not retry it", async t => {
  let calls = 0; const h = harness(t, { generate: async () => { calls++; throw new Error("provider unavailable"); } });
  await h.record("喜欢解谜游戏"); await h.plugin.whenIdle(); assert.equal(calls, 1); assert.equal(h.repo.stats().pending, 1);
  await h.providers.collect({ observations: [h.observation("游戏")] }); await h.providers.collect({ observations: [h.observation("游戏")] });
  assert.equal(calls, 1); assert.equal(h.plugin.getSnapshot().lastError, "provider unavailable");
});
test("clearing cancels extraction and rejects late results without waiting for the provider", async t => {
  const pending = deferred(); let input, signal;
  const h = harness(t, { generate: async (messages, settings) => { input = JSON.parse(messages[1].content); signal = settings.signal; return pending.promise; } });
  await h.record("需要忘记的旧内容"); await settle(); await h.plugin.clear(); assert.ok(signal.aborted);
  pending.resolve(JSON.stringify({ ...emptyPlan(), upsert: [candidate(input.pending[0])] })); await h.plugin.whenIdle();
  assert.equal(h.repo.list().length, 0); assert.equal(h.repo.stats().events, 0); assert.equal(h.repo.stats().pending, 0);
});
test("manual correction during a model call rejects the obsolete result", async t => {
  const pending = deferred(); let input;
  const h = harness(t, { generate: async messages => { input = JSON.parse(messages[1].content); return pending.promise; } });
  const e = seed(h.repo, "看到第五集"); await h.record("看到第六集了"); await settle(); h.plugin.correct(e.id, "看到第七集了");
  pending.resolve(JSON.stringify({ ...emptyPlan(), upsert: [candidate(input.pending[0], { id: e.id })] })); await h.plugin.whenIdle();
  assert.equal(h.repo.get(e.id).text, "看到第七集了"); assert.equal(h.repo.stats().pending, 1);
});
test("stopped plugins do not ingest or inject and recover pending evidence on restart", async t => {
  let calls = 0; const h = harness(t, { generate: async () => { calls++; return JSON.stringify(emptyPlan()); } });
  h.repo.ingest({ id: "saved", text: "昨天的游戏经历", role: "user" }); await h.plugin.stop();
  await h.record("停止期间的内容"); assert.deepEqual(await h.providers.collect({}), []); assert.equal(calls, 0);
  h.plugin.start(); await h.plugin.whenIdle(); assert.equal(calls, 1); assert.equal(h.repo.stats().pending, 0);
});
test("pinned preferences accompany relevant recall but unrelated memories stay out", async t => {
  const h = harness(t); seed(h.repo, "别给我剧透", { pinned: true }); seed(h.repo, "爱喝咖啡", { importance: 5 });
  const blocks = await h.providers.collect({ observations: [h.observation("今天天气怎么样")], conversationHistory: true });
  assert.ok(blocks[0].text.includes("别给我剧透")); assert.ok(!blocks[0].text.includes("咖啡"));
});
test("core refreshes turn-scoped memory on topic changes and keeps the history prefix stable", async t => {
  const h = harness(t), requests = []; seed(h.repo, "迷雾看到第五集", { title: "迷雾" }); seed(h.repo, "星露谷修好了温室", { title: "星露谷" });
  const conversation = createConversation({ getConfig: () => ({ conversation: { ai: { endpoint: "https://test", apiKey: "test", model: "test" } } }),
    contextProviders: h.providers, promptExtensions: h.extensions, logger: { info() {}, warn() {} }, writeLog() {}, configureProxy: async () => {},
    fetchImpl: async (_url, init) => { requests.push(JSON.parse(init.body)); return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify(petPayload({ response: "记得的" })) } }] }) }; },
  }); t.after(() => conversation.dispose());
  await conversation.decideFromObservations([h.observation("迷雾看到哪了")]);
  await conversation.decideFromObservations([h.observation("星露谷怎么样了")]);
  const firstCurrent = requests[0].messages.at(-1), secondCurrent = requests[1].messages.at(-1);
  assert.ok(JSON.stringify(firstCurrent).includes("第五集")); assert.ok(!JSON.stringify(firstCurrent).includes("温室"));
  assert.ok(JSON.stringify(secondCurrent).includes("温室")); assert.ok(!JSON.stringify(secondCurrent).includes("第五集"));
  assert.ok(!JSON.stringify(requests[1].messages.slice(0, -1)).includes("# 本轮动态背景"));
  assert.equal(requests[0].messages[0].content, requests[1].messages[0].content);
});
test("semantic transport failure falls back to lexical recall without failing conversation", async t => {
  const h = harness(t, { options: { embedding: { enabled: true, endpoint: "https://test", model: "test" } }, embedding: { provider: () => "test", embed: async () => { throw new Error("offline"); } } });
  seed(h.repo, "合作游戏伙伴是小林"); const results = await h.plugin.search("小林");
  assert.equal(results.length, 1); assert.equal(h.plugin.getSnapshot().lastRetrieval.mode, "lexical");
});
test("legacy facts and profiles migrate once, preserve provenance and never resume fixed pipelines", async t => {
  const h = harness(t); const facts = createLongTermStore(h.storage); facts.appendBatch([{ id: "legacy-fact", text: "以前喜欢悬疑剧" }]);
  const profiles = createWorkStore(h.storage); profiles.applyExtraction({ entities: [], claims: [], questions: [{ subject: { kind: "user", name: "用户" },
    field: "preference", scope: "", prompt: "偏好哪种游戏？", options: [{ label: "种田", value: "喜欢种田游戏" }, { label: "解谜", value: "喜欢解谜游戏" }] }] }, []);
  const q = profiles.nextQuestion(); profiles.answer(q.id, { action: "answer", optionIndex: 0 });
  h.repo.setState("legacyImported", false); migrateLegacy(h.storage, h.repo, () => 10000);
  assert.equal(h.repo.list().length, 2); assert.equal(h.repo.list().find(e => e.legacy.namespace === "profile").basis, "user");
  assert.ok(h.repo.events({ limit: 20 }).some(s => s.metadata.original)); migrateLegacy(h.storage, h.repo); assert.equal(h.repo.list().length, 2);
  await h.plugin.clear(); h.repo.setState("legacyImported", true); migrateLegacy(h.storage, h.repo); assert.equal(h.repo.list().length, 0); assert.equal(facts.list().length, 0);
});
test("model search/read tools produce bounded local results and do not re-ingest them", async t => {
  const h = harness(t); seed(h.repo, "团子是我的猫", { title: "团子" });
  await h.record("团子是谁", { result: { effects: [{ type: "memory.search", query: "团子" }] } }); await h.plugin.whenIdle();
  assert.equal(h.toolResults.length, 1); assert.equal(h.decisions.length, 1); assert.ok(h.toolResults[0].content[0].text.includes("猫"));
  const before = h.repo.stats().events;
  await h.bus.publish(EVENTS.DECISION_COMPLETED, { id: "tool-result", observations: [h.toolResults[0]], result: { reply: "你的猫咪", summaries: {} } }); await h.plugin.whenIdle();
  assert.equal(h.repo.stats().events, before);
});
test("manual organization covers bounded chunks instead of sending the whole library", async t => {
  const inputs = []; const h = harness(t, { options: { maintenance: { candidateLimit: 2, maxContextChars: 10000 } }, generate: async messages => { inputs.push(JSON.parse(messages[1].content)); return JSON.stringify(emptyPlan()); } });
  for (let i = 0; i < 5; i++) seed(h.repo, `自由主题内容 ${i}`);
  const result = await h.plugin.organize(); assert.equal(inputs.length, 3); assert.equal(inputs.flatMap(i => i.entries).length, 5); assert.ok(inputs.every(i => i.entries.length <= 2));
  assert.equal(result.before, 5); assert.equal(result.after, 5);
});
test("generic questions preserve user answers as evidence without predefined profile fields", async t => {
  const h = harness(t, { options: { questions: { enabled: true } } });
  h.repo.setState("questions", [{ id: "q", prompt: "聊天要不要聊后续剧情？", topic: "我们的看剧约定", reason: "避免剧透", status: "pending", options: [{ label: "不要", value: "不要剧透" }, { label: "可以", value: "可以剧透" }], skips: 0, nextAt: 0, lastShownAt: 0, createdAt: 0, answers: [] }]);
  const service = h.services.get("memory.work"); service.answer("q", { action: "answer", optionIndex: 0 }); await h.plugin.whenIdle();
  assert.equal(h.repo.state("questions")[0].status, "answered"); assert.ok(h.repo.events({ limit: 10 }).some(s => s.text === "不要剧透" && s.role === "user"));
});
test("forgetting an answer-backed memory also removes the question's retained answer text", async t => {
  const h = harness(t, { options: { questions: { enabled: true } }, generate: async messages => {
    const input = JSON.parse(messages[1].content); return JSON.stringify({ ...emptyPlan(), upsert: [candidate(input.pending[0])] });
  } });
  h.repo.setState("questions", [{ id: "q", prompt: "喜欢怎样交流？", topic: "交流方式", reason: "了解偏好", status: "pending", options: [{ label: "简短", value: "简短回应" }, { label: "详细", value: "详细解释" }], skips: 0, nextAt: 0, lastShownAt: 0, createdAt: 0, answers: [] }]);
  h.services.get("memory.work").answer("q", { action: "answer", optionIndex: 0 }); await h.plugin.whenIdle();
  const e = h.repo.list()[0]; assert.equal(h.repo.state("questions")[0].answers[0].value, "简短回应");
  h.plugin.forget(e.id); assert.equal(h.repo.state("questions").length, 0);
});
test("perception ingestion buffers transient disk failures and restores raw evidence", async t => {
  let clock = 10000;
  const h = harness(t, { now: () => clock }); h.storage.exec("CREATE TRIGGER reject_ingress BEFORE INSERT ON adaptive_memory_events BEGIN SELECT RAISE(ABORT,'disk failure'); END");
  await h.record("游戏中的重要回忆"); await h.plugin.whenIdle(); assert.equal(h.plugin.getSnapshot().bufferedSources, 1);
  h.storage.exec("DROP TRIGGER reject_ingress"); clock += 31000; await h.plugin.stop(); h.plugin.start(); await h.plugin.whenIdle();
  assert.equal(h.plugin.getSnapshot().bufferedSources, 0); assert.ok(h.repo.events({ limit: 10 }).some(s => s.text === "游戏中的重要回忆"));
});
