const test = require("node:test");
const assert = require("node:assert/strict");
const { workStorage } = require("./helpers/workStorage");
const { MessageBus } = require("../electron/architecture/messageBus");
const EVENTS = require("../electron/architecture/events");
const { createLongTermStore } = require("../electron/plugins/memory/longTerm");
const { createWorkStore } = require("../electron/plugins/memory/workStore");
const { validateProfilePlan } = require("../electron/plugins/memory/profileOrganizer");
const { createMemoryPlugin } = require("../electron/plugins/memory");
const { registerExecutionModule } = require("../electron/modules/execution");
const { validatePlan, organizeWithLlm } = require("../electron/plugins/memory/organizer");
const settle = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

function harness(t, generate, overrides = {}) {
  const { db, storage } = workStorage();
  const repo = createLongTermStore(storage);
  const bus = new MessageBus();
  const dialogs = [];
  const bubbles = [], speeches = [];
  t.after(registerExecutionModule(bus, { sendBubble: (bubble) => bubbles.push(bubble) }));
  t.after(bus.subscribe(EVENTS.SPEECH_OUTPUT_REQUESTED, (payload) => speeches.push(payload)));
  const config = { plugins: [{ name: "memory", enabled: true, textService: "model.text",
    shortTerm: { maxTurns: 20 }, longTerm: { enabled: true }, ...overrides }] };
  let menu;
  let model = generate;
  const plugin = createMemoryPlugin({ bus, config: { get: () => config },
    services: { get: (name) => name === "model.text" ? model : storage },
    logger: { info() {}, warn() {}, error() {} },
    decisionContext: { register: () => () => {} },
    menu: { register: (provide) => { menu = provide; return () => {}; }, refresh() {} },
    dialogs: { showMessageBox: async (options) => { dialogs.push(options); return { response: 0 }; } },
  }, { longTerm: repo });
  t.after(async () => { await plugin.dispose(); db.close(); });
  return { repo, db, storage, bus, config, plugin, dialogs, bubbles, speeches,
    menuItem: () => menu()[0].submenu.find((item) => item.label === "整理" || item.label === "正在整理记忆…"),
    setModel: (next) => { model = next; } };
}

function seed(repo) {
  repo.appendBatch([
    { id: "coffee1", text: "用户偏爱咖啡作为日常饮品", type: "preference", importance: 5, createdAt: 100,
      metadata: { sourceDecisionIds: ["d1"], sourceSessionIds: ["s1"] } },
    { id: "coffee2", text: "用户经常选择美式咖啡", type: "preference", importance: 3, createdAt: 200,
      metadata: { sourceDecisionIds: ["d2"], sourceSessionIds: ["s1"] } },
    { id: "temporary", text: "画面里出现了一次加载动画", type: "event", createdAt: 300 },
    { id: "identity", text: "用户是一名软件开发工程师", createdAt: 50 },
  ]);
}
const plan = () => ({ merge: [{ sourceIds: ["coffee1", "coffee2"], type: "preference",
  text: "用户喜欢咖啡，经常选择美式", tags: ["咖啡", "美式"], importance: 2, reason: "合并同一饮品偏好" }],
  archive: [{ id: "temporary", reason: "一次性画面描述" }] });

test("manual menu organization merges facts, archives originals, and preserves unrelated memory", async (t) => {
  let calls = 0;
  const h = harness(t, async (messages, settings) => {
    calls++;
    assert.ok(settings.signal instanceof AbortSignal);
    const input = JSON.parse(messages[1].content);
    assert.equal(input.entries.length, 4);
    return JSON.stringify(plan());
  });
  seed(h.repo);
  const identity = h.repo.list().find((entry) => entry.id === "identity");
  assert.equal(h.menuItem().enabled, true);
  await h.menuItem().click();
  assert.equal(calls, 1);
  assert.equal(h.bubbles[0].type, "say");
  assert.match(h.bubbles[0].text, /记忆整理完成/);
  assert.match(h.bubbles[0].text, /整理前 4 条，整理后 2 条/);
  assert.deepEqual(h.dialogs, []);
  assert.deepEqual(h.speeches, []);
  const current = h.repo.list();
  assert.equal(current.length, 2);
  assert.deepEqual(current.find((entry) => entry.id === "identity"), identity);
  const merged = current.find((entry) => entry.id !== "identity");
  assert.equal(merged.importance, 5);
  assert.equal(merged.createdAt, 200);
  assert.deepEqual(merged.metadata.sourceDecisionIds, ["d1", "d2"]);
  assert.deepEqual(merged.metadata.sourceSessionIds, ["s1"]);
  const reopened = createLongTermStore(h.storage);
  assert.equal(reopened.history().length, 2);
  assert.deepEqual(reopened.history().flatMap((record) => record.originals.map((entry) => entry.id)).sort(),
    ["coffee1", "coffee2", "temporary"]);
  assert.equal(h.plugin.getSnapshot().longTerm.organizationHistory.length, 2);
  assert.equal(h.menuItem().enabled, true);
});

test("unknown IDs, reused sources and malformed plans fail without writing", async (t) => {
  const responses = ["broken JSON", JSON.stringify({ merge: [], archive: [{ id: "foreign", reason: "test" }] }),
    JSON.stringify({ ...plan(), archive: [{ id: "coffee1", reason: "already merged" }] }),
    JSON.stringify({ merge: [{ ...plan().merge[0], sourceIds: ["coffee1"] }], archive: [] })];
  const h = harness(t, async () => responses.shift());
  seed(h.repo);
  const before = h.repo.list();
  while (responses.length) {
    await assert.rejects(h.plugin.organize());
    assert.deepEqual(h.repo.list(), before);
    assert.deepEqual(h.repo.history(), []);
  }
  assert.equal(h.menuItem().enabled, true);
});

test("multi-source topic consolidation retains evidence and ancestry across repeated organization", (t) => {
  const h = harness(t);
  const notes = ["记忆整理接口出现空正文", "推理耗尽输出额度导致正文为空", "整理请求输出预算改为16384", "验证失败时保留待处理记忆"];
  const entries = notes.map((text, i) => ({ id: `topic${i}`, text, createdAt: i + 1,
    metadata: { sourceEvidenceIds: [`e${i}`, "shared"], sourceProfileIds: [`p${i}`], sourceMemoryIds: [`ancestor${i}`] } }));
  h.repo.appendBatch(entries);
  const merge = { sourceIds: entries.map(e => e.id), type: "fact",
    text: "记忆整理空正文由推理耗尽输出额度引起，输出预算改为16384；验证失败保留待处理记忆。",
    tags: ["记忆整理"], importance: 3, reason: "一次归并故障、原因与方案" };
  assert.equal(h.repo.organize({ merge: [merge], archive: [] }, h.repo.list()).after, 1);
  const first = h.repo.list()[0];
  assert.deepEqual(first.metadata.sourceEvidenceIds, ["e0", "shared", "e1", "e2", "e3"]);
  assert.deepEqual(first.metadata.sourceProfileIds, ["p0", "p1", "p2", "p3"]);
  h.repo.appendBatch([{ id: "followup", text: "整理后支持展开查看历史来源", metadata: { sourceEvidenceIds: ["new-evidence"] } }]);
  h.repo.organize({ merge: [{ ...merge, sourceIds: [first.id, "followup"], text: `${merge.text}整理后支持查看历史来源。` }], archive: [] }, h.repo.list());
  const final = h.repo.list()[0];
  for (const id of [first.id, "followup", ...entries.map(e => e.id), ...entries.map((_, i) => `ancestor${i}`)]) {
    assert.ok(final.metadata.sourceMemoryIds.includes(id));
  }
  assert.ok(final.metadata.sourceEvidenceIds.includes("new-evidence"));
  assert.deepEqual(final.metadata.sourceProfileIds, first.metadata.sourceProfileIds);
  assert.equal(h.repo.history().length, 2);
  assert.equal(h.repo.history()[1].originals.length, entries.length);
});

test("a conflicting replacement rolls back all merges and archives", (t) => {
  const h = harness(t);
  seed(h.repo);
  const before = h.repo.list();
  const conflicting = plan();
  conflicting.merge[0].text = before.find((entry) => entry.id === "identity").text;
  assert.throws(() => h.repo.organize(conflicting, before), /重复/);
  assert.deepEqual(h.repo.list(), before);
  assert.deepEqual(h.repo.history(), []);
});

test("empty stores skip AI; no-change plans preserve IDs and add no history", async (t) => {
  let calls = 0;
  const h = harness(t, async () => { calls++; return '{"merge":[],"archive":[]}'; });
  assert.deepEqual(await h.plugin.organize(), { before: 0, after: 0, merged: 0, archived: 0 });
  assert.equal(calls, 0);
  seed(h.repo);
  const before = h.repo.list();
  assert.deepEqual(await h.plugin.organize(), { before: 4, after: 4, merged: 0, archived: 0 });
  assert.deepEqual(h.repo.list(), before);
  assert.deepEqual(h.repo.history(), []);
});

test("menu notifications handle empty memory and suppress completion after stopping", async (t) => {
  const empty = harness(t);
  await empty.menuItem().click();
  assert.deepEqual(empty.bubbles, [{ type: "say", text: "暂无记忆可整理。" }]);
  assert.deepEqual(empty.dialogs, []);
  const pending = deferred();
  const h = harness(t, async () => pending.promise);
  seed(h.repo);
  const operation = h.menuItem().click();
  await settle();
  const stopping = h.plugin.stop();
  pending.resolve(JSON.stringify(plan()));
  await Promise.all([operation, stopping]);
  assert.deepEqual(h.bubbles, []);
  assert.deepEqual(h.dialogs, []);
});

test("concurrent manual requests share the operation and disable the menu while running", async (t) => {
  const pending = deferred();
  let calls = 0;
  const h = harness(t, async () => { calls++; return pending.promise; });
  seed(h.repo);
  const first = h.plugin.organize();
  assert.equal(h.plugin.organize(), first);
  await settle();
  assert.equal(calls, 1);
  assert.equal(h.menuItem().label, "正在整理记忆…");
  assert.equal(h.menuItem().enabled, false);
  assert.equal(h.plugin.getSnapshot().organizing, true);
  pending.resolve(JSON.stringify(plan()));
  await first;
  assert.equal(h.menuItem().enabled, true);
});

test("stopping or clearing aborts organization and rejects late results", async (t) => {
  for (const action of ["stop", "clear"]) {
    const pending = deferred();
    let signal;
    const h = harness(t, async (_messages, settings) => { signal = settings.signal; return pending.promise; });
    seed(h.repo);
    const original = h.repo.list();
    const operation = assert.rejects(h.plugin.organize(), /取消/);
    await settle();
    const stopped = h.plugin[action]();
    assert.equal(signal.aborted, true);
    pending.resolve(JSON.stringify(plan()));
    await operation;
    await stopped;
    assert.deepEqual(h.repo.history(), []);
    assert.deepEqual(h.repo.list(), action === "clear" ? [] : original);
  }
});

test("manual organization waits for extraction and defers new extraction until it finishes", async (t) => {
  const extraction = deferred();
  const organization = deferred();
  const calls = [];
  const h = harness(t, async (messages) => {
    calls.push(messages);
    return calls.length === 1 ? extraction.promise : calls.length === 2 ? organization.promise : '{"update":[],"add":[]}';
  }, { longTerm: { enabled: true, extractEveryNTurns: 1 } });
  const record = (id) => h.bus.notify(EVENTS.DECISION_COMPLETED, {
    id, observations: [], result: { reply: `第${id}轮对话` },
  });
  await record("1");
  await settle();
  const operation = h.plugin.organize();
  await settle();
  assert.equal(calls.length, 1);
  extraction.resolve(JSON.stringify({ update: [], add: [{ type: "preference", text: "用户偏爱阅读技术书籍", tags: [], importance: 4,
    sourceTurnIds: JSON.parse(calls[0][1].content).turns.map((t) => t.id) }] }));
  await settle();
  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(calls[1][1].content).entries[0].text, "用户偏爱阅读技术书籍");
  await record("2");
  await settle();
  assert.equal(calls.length, 2);
  organization.resolve('{"merge":[],"archive":[]}');
  await operation;
  await h.plugin.whenIdle();
  assert.equal(calls.length, 3);
  assert.equal(h.plugin.getState().extractedThrough, 2);
});

test("changed storage or text service invalidates the snapshot", async (t) => {
  for (const change of ["store", "service"]) {
    const pending = deferred();
    const h = harness(t, async () => pending.promise);
    seed(h.repo);
    const operation = assert.rejects(h.plugin.organize(), change === "store" ? /已变化/ : /取消/);
    await settle();
    if (change === "store") h.repo.appendBatch([{ text: "新加入的事实必须保留" }]);
    else h.setModel(async () => "[]");
    const before = h.repo.list();
    pending.resolve(JSON.stringify(plan()));
    await operation;
    assert.deepEqual(h.repo.list(), before);
    assert.deepEqual(h.repo.history(), []);
  }
});

test("missing AI reports a retryable menu error; disabled memory blocks organization", async (t) => {
  const h = harness(t);
  seed(h.repo);
  const before = h.repo.list();
  await h.menuItem().click();
  assert.equal(h.bubbles[0].type, "error");
  assert.match(h.bubbles[0].text, /文本服务不可用/);
  assert.match(h.bubbles[0].text, /原始记忆已保留/);
  assert.deepEqual(h.dialogs, []);
  assert.deepEqual(h.speeches, []);
  assert.deepEqual(h.repo.list(), before);
  h.config.plugins[0].longTerm.enabled = false;
  assert.equal(h.menuItem().enabled, false);
  await assert.rejects(h.plugin.organize(), /长期记忆已关闭/);
});

test("clearing all memory removes organization history as well", async (t) => {
  const h = harness(t, async () => JSON.stringify(plan()));
  seed(h.repo);
  await h.plugin.organize();
  assert.equal(h.repo.history().length, 2);
  await h.plugin.clear();
  assert.deepEqual(h.repo.history(), []);
  assert.deepEqual(h.repo.list(), []);
});

test("plan validation rejects missing reasons and invalid merged fact fields", () => {
  const entries = [{ id: "a" }, { id: "b" }];
  assert.throws(() => validatePlan({ merge: [], archive: [{ id: "a", reason: "" }] }, entries), /内容无效/);
  assert.throws(() => validatePlan({ merge: [{ ...plan().merge[0], sourceIds: ["a", "b"], importance: 6 }], archive: [] }, entries), /字段无效/);
});

test("organization sends all facts in one request with a larger output and timeout budget", async () => {
  const entries = Array.from({ length: 500 }, (_, i) => ({ id: `entry-${i}`, type: "fact", text: `topic_${i} 独立事实`,
    tags: [`topic_${i}`], importance: 3, createdAt: i + 1, metadata: { sourceDecisionIds: ["x".repeat(2000)] } }));
  entries[0].text = "用户喜欢美式咖啡";
  entries[0].tags = ["咖啡"];
  entries[59].text = "用户每日选择美式咖啡";
  entries[59].tags = ["咖啡"];
  const seen = [];
  let calls = 0;
  const result = await organizeWithLlm({ entries, callChat: async (messages, settings) => {
    calls++;
    const input = JSON.parse(messages[1].content);
    assert.equal(input.entries.length, 500);
    assert.ok(messages[1].content.length > 8000);
    assert.ok(input.entries.every((entry) => !Object.hasOwn(entry, "metadata")));
    assert.equal(settings.timeoutMs, 300000);
    assert.equal(settings.retryBudgetMs, 605000);
    assert.equal(settings.maxRetries, 1);
    assert.equal(settings.max_tokens, 16384);
    seen.push(...input.entries.map((entry) => entry.id));
    await settle();
    return '{"merge":[],"archive":[]}';
  } });
  assert.deepEqual(result, { merge: [], archive: [] });
  assert.equal(calls, 1);
  assert.equal(new Set(seen).size, entries.length);
  assert.equal(seen.length, entries.length);
});

test("a full organization timeout preserves all memory without falling back to batches", async (t) => {
  let calls = 0;
  const h = harness(t, async (messages) => {
    calls++;
    assert.equal(JSON.parse(messages[1].content).entries.length, 201);
    throw new Error("AI request 超时（300000ms）");
  });
  h.repo.appendBatch(Array.from({ length: 201 }, (_, i) => ({ id: `large-${i}`, text: `独立画面记录${i}加载动画`, tags: [] })));
  const before = h.repo.list();
  await assert.rejects(h.plugin.organize(), /超时（300000ms）/);
  assert.equal(calls, 1);
  assert.deepEqual(h.repo.list(), before);
  assert.deepEqual(h.repo.history(), []);
});

function seedProfiles(storage) {
  const work = createWorkStore(storage);
  work.addEvidence({ id: "profile-source", source: "screen", text: "张琳负责支付接口，用户偏好先看结论" });
  work.applyExtraction({ entities: [], questions: [], claims: [
    { subject: { kind: "person", name: "张琳" }, field: "responsibility", scope: "支付项目", value: "负责支付接口", basis: "observation", confidence: 0.8, evidenceIds: ["profile-source"] },
    { subject: { kind: "person", name: "张琳" }, field: "responsibility", scope: "支付改造", value: "对接支付接口", basis: "observation", confidence: 0.9, evidenceIds: ["profile-source"] },
    { subject: { kind: "user", name: "用户" }, field: "communication", scope: "", value: "先给结论", basis: "observation", evidenceIds: ["profile-source"] },
    { subject: { kind: "user", name: "用户" }, field: "task", scope: "临时活动", value: "观察到一次加载动画", basis: "inference", evidenceIds: ["profile-source"] },
  ] }, work.pending());
  work.correctProfile(work.profiles().find((p) => p.field === "communication").id, "先给结论，再补必要细节");
  return work;
}

function profilePlan(profiles) {
  const sources = profiles.filter((p) => p.subject.kind === "person");
  return { merge: [{ sourceIds: sources.map((p) => p.id), scope: "支付项目", value: "负责支付接口的开发对接", reason: "两个范围指向同一支付项目" }],
    archive: [{ id: profiles.find((p) => p.field === "task").id, reason: "一次性画面描述" }] };
}

test("one manual operation organizes facts and work profiles with source protection and persistent history", async (t) => {
  let calls = 0;
  let originalProfiles;
  const h = harness(t, async (messages, settings) => {
    calls++;
    const input = JSON.parse(messages[1].content);
    assert.equal(input.entries.length, 4);
    assert.equal(input.profiles.length, 4);
    assert.ok(input.profiles.some((p) => p.basis === "user_answer"));
    assert.equal(settings.max_tokens, 16384);
    assert.equal(settings.timeoutMs, 300000);
    return JSON.stringify({ ...plan(), workProfiles: profilePlan(originalProfiles) });
  }, { work: { enabled: true } });
  seed(h.repo);
  const work = seedProfiles(h.storage);
  originalProfiles = work.profiles();
  const confirmed = originalProfiles.find((p) => p.basis === "user_answer");
  await h.menuItem().click();
  assert.equal(calls, 1);
  assert.match(h.bubbles[0].text, /人物画像：整理前 4 条，整理后 2 条/);
  assert.deepEqual(h.dialogs, []);
  assert.equal(h.repo.list().length, 2);
  assert.equal(work.profiles().length, 2);
  assert.deepEqual(work.profiles().find((p) => p.basis === "user_answer"), confirmed);
  const merged = work.profiles().find((p) => p.subject.kind === "person");
  assert.equal(merged.basis, "observation");
  assert.equal(merged.confidence, 0.9);
  assert.deepEqual(merged.evidenceIds, ["profile-source"]);
  assert.equal(merged.updatedAt, Math.max(...originalProfiles.filter((p) => p.subject.kind === "person").map((p) => p.updatedAt)));
  const reopened = createWorkStore(h.storage);
  assert.equal(reopened.snapshot().organizationHistory.length, 2);
  assert.equal(reopened.profiles({ includeHistory: true }).filter((p) => p.status === "archived").length, 1);
  assert.equal(h.plugin.getSnapshot().work.organizationHistory.length, 2);
  assert.ok(h.storage.prepare("SELECT id FROM work_evidence WHERE id = 'profile-source'").get());
  await h.plugin.clear();
  assert.deepEqual(work.snapshot().organizationHistory, []);
});

test("work profiles alone can be organized when long-term facts are disabled", async (t) => {
  let work;
  const h = harness(t, async (messages) => {
    const input = JSON.parse(messages[1].content);
    assert.deepEqual(input.entries, []);
    assert.equal(input.profiles.length, 4);
    return JSON.stringify({ merge: [], archive: [], workProfiles: profilePlan(work.profiles()) });
  }, { longTerm: { enabled: false }, work: { enabled: true } });
  work = seedProfiles(h.storage);
  assert.equal(h.menuItem().enabled, true);
  const result = await h.plugin.organize();
  assert.equal(result.work.before, 4);
  assert.equal(result.work.after, 2);
});

test("missing profile plans and forbidden changes reject the whole result before modifying facts", async (t) => {
  let response;
  const h = harness(t, async () => JSON.stringify(response), { work: { enabled: true } });
  seed(h.repo);
  const work = seedProfiles(h.storage);
  const originalProfiles = work.profiles();
  const originalFacts = h.repo.list();
  const confirmed = originalProfiles.find((p) => p.basis === "user_answer");
  const forbidden = [undefined, { merge: [], archive: [{ id: confirmed.id, reason: "不应删除" }] },
    { merge: [{ sourceIds: [confirmed.id, originalProfiles.find((p) => p.field === "task").id], scope: "", value: "改写答案", reason: "无效" }], archive: [] },
    { merge: [], archive: [{ id: "foreign", reason: "未知记录" }] }];
  for (const workProfiles of forbidden) {
    response = { ...plan(), ...(workProfiles !== undefined ? { workProfiles } : {}) };
    await assert.rejects(h.plugin.organize());
    assert.deepEqual(h.repo.list(), originalFacts);
    assert.deepEqual(work.profiles(), originalProfiles);
    assert.deepEqual(work.snapshot().organizationHistory, []);
  }
});

test("user corrections during a request reject stale profiles and roll back fact consolidation", async (t) => {
  const pending = deferred();
  const h = harness(t, async () => pending.promise, { work: { enabled: true } });
  seed(h.repo);
  const work = seedProfiles(h.storage);
  const originalProfiles = work.profiles();
  const originalFacts = h.repo.list();
  const operation = assert.rejects(h.plugin.organize(), /人物画像已变化/);
  await settle();
  work.correctProfile(originalProfiles.find((p) => p.field === "communication").id, "现在喜欢完整过程");
  const corrected = work.profiles();
  pending.resolve(JSON.stringify({ ...plan(), workProfiles: profilePlan(originalProfiles) }));
  await operation;
  assert.deepEqual(h.repo.list(), originalFacts);
  assert.deepEqual(h.repo.history(), []);
  assert.deepEqual(work.profiles(), corrected);
  assert.deepEqual(work.snapshot().organizationHistory, []);
});

test("a profile storage failure rolls back both fact and profile changes", async (t) => {
  let originalProfiles;
  const h = harness(t, async () => JSON.stringify({ ...plan(), workProfiles: profilePlan(originalProfiles) }), { work: { enabled: true } });
  seed(h.repo);
  const work = seedProfiles(h.storage);
  originalProfiles = work.profiles();
  const originalFacts = h.repo.list();
  h.storage.exec(`CREATE TRIGGER reject_profile_history BEFORE INSERT ON work_profile_organization_history
    BEGIN SELECT RAISE(ABORT, 'profile history failed'); END`);
  await assert.rejects(h.plugin.organize(), /profile history failed/);
  assert.deepEqual(h.repo.list(), originalFacts);
  assert.deepEqual(h.repo.history(), []);
  assert.deepEqual(work.profiles(), originalProfiles);
  assert.deepEqual(work.snapshot().organizationHistory, []);
});

test("profile validation protects confirmed values, scope, subjects, fields and observation basis", () => {
  const base = { entityId: "user", subject: { kind: "user", name: "用户" }, field: "communication", scope: "", value: "先给结论", basis: "user_answer" };
  const profiles = [{ ...base, id: "confirmed" }, { ...base, id: "guess", basis: "inference" }];
  const merge = (value, scope = "") => ({ merge: [{ sourceIds: ["confirmed", "guess"], scope, value, reason: "重复" }], archive: [] });
  assert.throws(() => validateProfilePlan(merge("完整过程"), profiles), /用户确认/);
  assert.throws(() => validateProfilePlan(merge("先给结论", "项目"), profiles), /范围无效/);
  assert.deepEqual(validateProfilePlan(merge("先给结论"), profiles), merge("先给结论"));
  assert.throws(() => validateProfilePlan(merge("先给结论"), [profiles[0], { ...profiles[1], entityId: "other" }]), /不同对象或字段/);
  assert.throws(() => validateProfilePlan(merge("先给结论"), [profiles[0], { ...profiles[1], field: "preference" }]), /不同对象或字段/);
  assert.throws(() => validateProfilePlan(merge("完整过程"), [{ ...profiles[0], basis: "observation" }, profiles[1]]), /猜测升级/);
});
