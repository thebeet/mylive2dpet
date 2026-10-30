const test = require("node:test");
const assert = require("node:assert/strict");
const { workStorage } = require("./helpers/workStorage");
const { createMemoryPlugin } = require("../electron/plugins/memory");
const { createLongTermStore } = require("../electron/plugins/memory/longTerm");
const { createUpdateBuffer } = require("../electron/plugins/memory/updateBuffer");
const { validateUpdatePlan } = require("../electron/plugins/memory/updater");
const { MessageBus } = require("../electron/architecture/messageBus");
const EVENTS = require("../electron/architecture/events");
const quiet = { info() {}, warn() {}, error() {} };
const empty = JSON.stringify({ update: [], add: [] });
const settle = () => new Promise((resolve) => setImmediate(resolve));

function database(t) {
  const { db, storage } = workStorage();
  t.after(() => db.close());
  return { db, storage, repo: createLongTermStore(storage) };
}
function app(t, storage, repo, generate, options = {}) {
  const bus = new MessageBus({ logger: quiet });
  const config = { plugins: [{ name: "memory", enabled: true,
    shortTerm: { maxTurns: 8, ttlMs: 5 }, longTerm: { enabled: true }, ...options }] };
  let clock = 1000;
  const plugin = createMemoryPlugin({ bus, config: { get: () => config }, logger: quiet,
    model: { generateText: generate },
    services: { get: (name) => name === "storage-sqlite.database" ? storage : undefined },
    decisionContext: { register: () => () => {} },
  }, { longTerm: repo, now: () => clock });
  t.after(() => plugin.dispose());
  async function record(i, silent = false) {
    clock += 10;
    await bus.notify(EVENTS.DECISION_COMPLETED, { id: `decision${i}`, sessionId: "session",
      observations: [{ id: `observation${i}`, role: "user", source: "manual-input", content: [{ type: "text", text: `用户对话${i}` }] }],
      result: silent ? { reply: "", speak: false, summaries: { screen: "画面变化" } } : { reply: `回答${i}`, summaries: {} },
    });
  }
  return { plugin, record, config };
}

test("20 dialogues reconcile all originals with existing facts despite recent expiry", async (t) => {
  const { storage, repo } = database(t);
  repo.appendBatch([{ id: "coffee", text: "用户喜欢美式咖啡", type: "preference", importance: 5, createdAt: 50,
    metadata: { sourceEvidenceIds: ["original"], sourceProfileIds: ["portrait"] } }]);
  let calls = 0;
  const h = app(t, storage, repo, async (messages) => {
    calls++;
    const input = JSON.parse(messages[1].content);
    assert.equal(input.entries[0].id, "coffee");
    assert.equal(input.turns.length, 20);
    assert.equal(input.turns[0].userMessage, "用户对话1");
    assert.equal(input.turns.at(-1).userMessage, "用户对话20");
    const sourceTurnIds = [input.turns.at(-1).id];
    return JSON.stringify({ update: [{ id: "coffee", type: "preference", text: "用户喜欢咖啡，目前更偏爱拿铁", tags: ["咖啡"], importance: 4, sourceTurnIds }],
      add: [{ type: "preference", text: "用户偏好先看结论和操作步骤", tags: ["沟通"], importance: 4, sourceTurnIds }] });
  });
  for (let i = 1; i < 20; i++) { await h.record(i); await h.plugin.whenIdle(); }
  assert.equal(calls, 0);
  assert.equal(repo.list().length, 1);
  await h.record("silent", true);
  await h.plugin.whenIdle();
  assert.equal(h.plugin.getState().pendingFacts.length, 19);
  await h.record(20);
  await h.plugin.whenIdle();
  assert.equal(calls, 1);
  assert.equal(repo.list().length, 2);
  const updated = repo.list().find((e) => e.id === "coffee");
  assert.equal(updated.createdAt, 50);
  assert.equal(updated.importance, 5);
  assert.deepEqual(updated.metadata.sourceEvidenceIds, ["original"]);
  assert.deepEqual(updated.metadata.sourceProfileIds, ["portrait"]);
  assert.deepEqual(updated.metadata.sourceDecisionIds, ["decision20"]);
  assert.equal(repo.history()[0].originals[0].text, "用户喜欢美式咖啡");
  assert.equal(h.plugin.getState().pendingFacts.length, 0);
});

test("pending dialogue survives plugin reconstruction and does not count the same batch twice", async (t) => {
  const { storage, repo } = database(t);
  let calls = 0;
  const generate = async (messages) => {
    calls++;
    assert.equal(JSON.parse(messages[1].content).turns.length, 20);
    return empty;
  };
  const first = app(t, storage, repo, generate);
  for (let i = 1; i <= 19; i++) await first.record(i);
  await first.plugin.whenIdle();
  await first.plugin.dispose();
  const second = app(t, storage, repo, generate);
  second.plugin.start();
  await second.record(20);
  await second.plugin.whenIdle();
  assert.equal(calls, 1);
  second.plugin.start();
  await second.plugin.whenIdle();
  assert.equal(calls, 1);
  assert.equal(createUpdateBuffer(storage).list().length, 0);
});

test("failure retains all originals for retry, including those no longer visible as recent dialogue", async (t) => {
  const { storage, repo } = database(t);
  let calls = 0;
  const h = app(t, storage, repo, async (messages) => {
    const input = JSON.parse(messages[1].content);
    if (++calls === 1) throw new Error("network failure");
    assert.equal(input.turns.length, 21);
    assert.equal(input.turns[0].userMessage, "用户对话1");
    return empty;
  });
  for (let i = 1; i <= 20; i++) await h.record(i);
  await h.plugin.whenIdle();
  assert.equal(h.plugin.getState().pendingFacts.length, 20);
  await h.record(21);
  await h.plugin.whenIdle();
  assert.equal(calls, 2);
  assert.equal(h.plugin.getState().pendingFacts.length, 0);
  assert.deepEqual(repo.list(), []);
});

test("arrivals during an update remain queued for the next 20-dialogue batch", async (t) => {
  const { storage, repo } = database(t);
  let resolve, calls = 0;
  const pending = new Promise((done) => { resolve = done; });
  const h = app(t, storage, repo, async () => ++calls === 1 ? pending : empty);
  for (let i = 1; i <= 20; i++) await h.record(i);
  await settle();
  await h.record(21);
  resolve(empty);
  await h.plugin.whenIdle();
  assert.equal(calls, 1);
  assert.deepEqual(h.plugin.getState().pendingFacts.map((t) => t.userMessage), ["用户对话21"]);
  for (let i = 22; i <= 40; i++) await h.record(i);
  await h.plugin.whenIdle();
  assert.equal(calls, 2);
  assert.equal(h.plugin.getState().pendingFacts.length, 0);
});

test("invalid plans and queue-consumption failures roll back edits, additions and history together", async (t) => {
  const { storage, repo } = database(t);
  repo.appendBatch([{ id: "existing", text: "用户喜欢技术书籍" }]);
  const before = repo.list();
  const h = app(t, storage, repo, async (messages) => {
    const sourceTurnIds = [JSON.parse(messages[1].content).turns[0].id];
    return JSON.stringify({ update: [{ id: "existing", type: "preference", text: "用户更偏爱系统设计书籍", tags: [], importance: 4, sourceTurnIds }],
      add: [{ type: "preference", text: "用户喜欢先看结论", tags: [], importance: 4, sourceTurnIds }] });
  });
  createUpdateBuffer(storage);
  storage.exec("CREATE TRIGGER reject_consume BEFORE DELETE ON memory_update_turns BEGIN SELECT RAISE(ABORT, 'disk failure'); END");
  for (let i = 1; i <= 20; i++) await h.record(i);
  await h.plugin.whenIdle();
  assert.deepEqual(repo.list(), before);
  assert.deepEqual(repo.history(), []);
  assert.equal(h.plugin.getState().pendingFacts.length, 20);
  const item = { type: "fact", text: "值得保存的新事实", tags: [], importance: 4, sourceTurnIds: ["turn"] };
  assert.throws(() => validateUpdatePlan({ update: [], add: [{ ...item, importance: 3 }] }, before, [{ id: "turn" }]), /至少为4/);
  assert.throws(() => validateUpdatePlan({ update: [], add: [{ ...item, sourceTurnIds: ["foreign"] }] }, before, [{ id: "turn" }]), /本批来源/);
  assert.throws(() => validateUpdatePlan({ update: [{ ...item, id: "missing" }], add: [] }, before, [{ id: "turn" }]), /未知/);
});
