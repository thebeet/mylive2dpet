const test = require('node:test');
const assert = require('node:assert/strict');
const { workStorage } = require('./helpers/workStorage');
const { createPracticeStore } = require('../electron/plugins/memory/practiceStore');
const { validatePracticePlan } = require('../electron/plugins/memory/practicePlanner');
const { createMemoryPlugin } = require('../electron/plugins/memory');
const { MessageBus } = require('../electron/architecture/messageBus');
const EVENTS = require('../electron/architecture/events');
const quiet = { info() {}, warn() {}, error() {} };
const empty = () => ({ projects: { update: [], add: [] }, lessons: { update: [], add: [] } });
const project = (sourceId, extras = {}) => ({ name: '桌宠ASR', scope: 'mylive2dpet', goal: '接入2-pass识别', status: 'blocked',
  completed: ['接入代码已写好'], pending: ['真实转写未验证'], blockers: ['10096端口未监听'],
  nextSteps: ['检查容器状态'], sourceIds: [sourceId], ...extras });
const lesson = (sourceId, extras = {}) => ({ title: '处理ASR连接拒绝', scope: '本地ASR', condition: '出现ECONNREFUSED',
  steps: ['检查端口监听和容器状态'], outcome: '尚未验证服务可用', status: 'attempted', verification: null,
  sourceIds: [sourceId], ...extras });
function database(t) {
  const { db, storage } = workStorage();
  t.after(() => db.close());
  let clock = 1000;
  const repo = createPracticeStore(storage, { now: () => clock });
  return { db, storage, repo, setClock: value => { clock = value; } };
}
function seed(repo, id = 'source', extras = {}) {
  repo.ingest({ id, source: 'user', text: '桌宠ASR代码已写好，真实转写未验证，10096端口未监听。先检查容器状态。', capturedAt: 1000, ...extras });
}
function app(t, generate, overrides = {}) {
  const h = database(t);
  const bus = new MessageBus({ logger: quiet });
  const config = { plugins: [{ name: 'memory', enabled: true,
    longTerm: { enabled: false }, work: { enabled: false },
    practice: { enabled: true, extractEveryNObservations: 3, flushAfterMs: 120000 }, ...overrides }] };
  let clock = 1000, model = generate, provide;
  const plugin = createMemoryPlugin({ bus, config: { get: () => config }, logger: quiet,
    model: { get generateText() { return model; } },
    services: { get: name => name === 'storage-sqlite.database' ? h.storage : undefined },
    decisionContext: { register: fn => { provide = fn; return () => {}; } },
  }, { now: () => clock });
  t.after(() => plugin.dispose());
  const observe = (id, text, source = 'audio-output') => bus.notify(EVENTS.PERCEPTION_OBSERVATION_QUEUED, {
    observation: { id, source, role: source === 'manual-input' ? 'user' : 'context', capturedAt: clock,
      content: [{ type: 'text', text }] },
  });
  return { ...h, bus, config, plugin, observe, context: query => provide({ observations: [{ content: [{ type: 'text', text: query }] }] }),
    advance(ms) { clock += ms; h.setClock(clock); }, setModel: fn => { model = fn; } };
}

test('projects, lessons, original sources and history survive store reconstruction; updates preserve IDs and evidence ancestry', t => {
  const h = database(t);
  seed(h.repo);
  const plan = empty(); plan.projects.add.push(project('source')); plan.lessons.add.push(lesson('source'));
  h.repo.apply(plan, h.repo.snapshot(), h.repo.sources());
  const initial = h.repo.snapshot();
  assert.equal(h.repo.sources().length, 0);
  assert.equal(h.repo.sources(false).length, 1);
  seed(h.repo, 'verified', { text: '启动容器后，中文样例转写测试通过。', capturedAt: 2000 });
  h.setClock(2100);
  const next = empty();
  next.projects.update.push(project('verified', { id: initial.projects[0].id, status: 'completed',
    completed: ['中文转写测试通过'], pending: [], blockers: [], nextSteps: [] }));
  next.lessons.update.push(lesson('verified', { id: initial.lessons[0].id, status: 'verified',
    outcome: '启动容器后转写测试通过', verification: { sourceId: 'verified', quote: '中文样例转写测试通过' } }));
  h.repo.apply(next, initial, h.repo.sources());
  const reopened = createPracticeStore(h.storage);
  assert.equal(reopened.snapshot().projects[0].id, initial.projects[0].id);
  assert.deepEqual(reopened.snapshot().lessons[0].sourceIds, ['source', 'verified']);
  assert.equal(reopened.history().length, 4);
  assert.equal(reopened.history()[0].before.status, 'attempted');
  reopened.clear();
  assert.deepEqual(reopened.snapshot(), { projects: [], lessons: [] });
  assert.equal(reopened.history().length, 0);
  assert.equal(reopened.sources(false).length, 0);
});

test('verification requires verbatim outcome evidence and excludes pet replies; project scope and source IDs are protected', () => {
  const before = { projects: [], lessons: [] };
  const sources = [{ id: 'user', source: 'user', text: '只是建议检查服务，尚未运行。' },
    { id: 'pet', source: 'assistant', text: '测试通过' }];
  for (const l of [lesson('missing'), lesson('pet'), lesson('user', { status: 'verified' }),
    lesson('user', { status: 'verified', verification: { sourceId: 'user', quote: '测试通过' } })]) {
    const plan = empty(); plan.lessons.add.push(l);
    assert.throws(() => validatePracticePlan(plan, before, sources));
  }
  const old = project('user', { id: 'project' });
  const plan = empty(); plan.projects.update.push({ ...old, scope: '另一项目' });
  assert.throws(() => validatePracticePlan(plan, { ...before, projects: [old] }, sources), /范围/);
});

test('stale snapshots, backdated sources and conflicting identities roll back both memory kinds and queue processing', t => {
  const h = database(t); seed(h.repo);
  const add = empty(); add.projects.add.push(project('source'));
  const old = h.repo.snapshot(); h.repo.apply(add, old, h.repo.sources());
  seed(h.repo, 'old', { capturedAt: 100 });
  const snapshot = h.repo.snapshot();
  const update = empty(); update.projects.update.push(project('old', { id: snapshot.projects[0].id }));
  update.lessons.add.push(lesson('old'));
  assert.throws(() => h.repo.apply(update, snapshot, h.repo.sources()), /旧来源/);
  assert.deepEqual(h.repo.snapshot(), snapshot);
  assert.equal(h.repo.sources().length, 1);
  assert.throws(() => h.repo.apply(empty(), old, h.repo.sources()), /已变化/);
  const duplicate = empty(); duplicate.projects.add.push(project('old'));
  assert.throws(() => h.repo.apply(duplicate, snapshot, h.repo.sources()), /原ID/);
});

test('retrieval scopes project progress and labels unverified lessons and stale states', t => {
  const h = database(t); seed(h.repo);
  const plan = empty(); plan.projects.add.push(project('source')); plan.lessons.add.push(lesson('source'));
  h.repo.apply(plan, h.repo.snapshot(), h.repo.sources());
  h.setClock(2000000);
  const config = { maxInject: 3, staleAfterMs: 10000 };
  const blocks = h.repo.context('ASR ECONNREFUSED', config);
  assert.equal(blocks.length, 2);
  assert.match(blocks[0].text, /久未更新/);
  assert.match(blocks[1].text, /未验证/);
  assert.deepEqual(h.repo.context('咖啡拿铁', config), []);
});

test('three silent audio observations update project state and experience without reaching the dialogue threshold', async t => {
  let calls = 0;
  const h = app(t, async messages => {
    calls++;
    const input = JSON.parse(messages[1].content);
    assert.equal(input.sources.length, 3);
    assert.ok(!JSON.stringify(input).includes('宠物说测试通过'));
    const plan = empty(); plan.projects.add.push(project(input.sources[0].id)); plan.lessons.add.push(lesson(input.sources[1].id));
    return JSON.stringify(plan);
  });
  for (let i = 1; i <= 3; i++) { await h.observe(`audio${i}`, '桌宠ASR遇到连接拒绝，检查容器状态'); await h.plugin.whenIdle(); }
  assert.equal(calls, 1);
  assert.equal(h.plugin.getSnapshot().practice.projects.length, 1);
  assert.equal(h.plugin.getSnapshot().practice.lessons[0].status, 'attempted');
  assert.equal(h.plugin.getSnapshot().practice.pending, 0);
  assert.equal(h.plugin.getState().totalTurns, 0);
  assert.ok(h.context('ASR连接拒绝').some(b => b.id === 'project-state'));
  assert.ok(h.context('ASR连接拒绝').some(b => b.id === 'experience-memory'));
});

test('aged sources flush on restart and malformed output preserves pending originals for retry', async t => {
  let calls = 0;
  const h = app(t, async () => { calls++; return 'broken'; });
  await h.observe('audio', '桌宠ASR接入进行中'); await h.plugin.whenIdle();
  assert.equal(calls, 0);
  h.advance(120001); h.plugin.start(); await h.plugin.whenIdle();
  assert.equal(calls, 1);
  assert.equal(h.plugin.getSnapshot().practice.pending, 1);
  h.setModel(async () => JSON.stringify(empty()));
  h.plugin.start(); await h.plugin.whenIdle();
  assert.equal(h.plugin.getSnapshot().practice.pending, 0);
});

test('manual organize submits current projects, lessons and all pending sources in one request and commits atomically with long-term facts', async t => {
  let calls = 0;
  const h = app(t, async messages => {
    calls++;
    const input = JSON.parse(messages[1].content);
    assert.equal(input.practice.sources.length, 1);
    assert.equal(input.entries.length, 0);
    const practice = empty(); practice.projects.add.push(project(input.practice.sources[0].id));
    return JSON.stringify({ merge: [], archive: [], practice });
  }, { longTerm: { enabled: true } });
  await h.observe('user', '桌宠ASR尚未完成转写验证', 'manual-input'); await h.plugin.whenIdle();
  await h.plugin.organize();
  assert.equal(calls, 1);
  assert.equal(h.plugin.getSnapshot().practice.projects.length, 1);
  assert.equal(h.plugin.getSnapshot().practice.pending, 0);
});

test('stop and clear prevent a late model result from repopulating project state or sources', async t => {
  let finish;
  const h = app(t, () => new Promise(resolve => { finish = resolve; }), { practice: { enabled: true, extractEveryNObservations: 1 } });
  await h.observe('user', '桌宠ASR接入进行中', 'manual-input');
  await new Promise(resolve => setImmediate(resolve));
  const stopping = h.plugin.stop();
  const plan = empty(); plan.projects.add.push(project('user'));
  finish(JSON.stringify(plan)); await stopping;
  assert.equal(h.plugin.getSnapshot().practice.projects.length, 0);
  assert.equal(h.plugin.getSnapshot().practice.pending, 1);
  h.setModel(async () => JSON.stringify(empty()));
  h.plugin.start(); await h.plugin.whenIdle();
  await h.plugin.clear();
  assert.equal(h.plugin.getSnapshot().practice.sources.length, 0);
});

test('sources arriving during extraction stay pending and cannot be consumed by an older request', async t => {
  let finish;
  const h = app(t, () => new Promise(resolve => { finish = resolve; }), {
    practice: { enabled: true, extractEveryNObservations: 1 },
  });
  await h.observe('first', '桌宠ASR遇到连接拒绝');
  await new Promise(resolve => setImmediate(resolve));
  await h.observe('second', '容器刚开始下载');
  const plan = empty(); plan.projects.add.push(project('first'));
  // Disable before a second extraction starts, leaving the later source queued.
  h.config.plugins[0].practice.extractEveryNObservations = 10;
  finish(JSON.stringify(plan));
  await h.plugin.whenIdle();
  assert.equal(h.plugin.getSnapshot().practice.projects.length, 1);
  assert.deepEqual(createPracticeStore(h.storage).sources().map(s=>s.id), ['second']);
});

test('manual transaction rolls back fact consolidation when project snapshot changes during the request', async t => {
  const { createLongTermStore } = require('../electron/plugins/memory/longTerm');
  let h;
  h = app(t, async messages => {
    const input = JSON.parse(messages[1].content);
    const concurrent = empty(); concurrent.projects.add.push(project('user'));
    h.repo.apply(concurrent, h.repo.snapshot(), h.repo.sources());
    return JSON.stringify({ merge: [{ sourceIds: ['f1', 'f2'], type: 'fact', text: '用户喜欢美式和拿铁咖啡',
      tags: ['咖啡'], importance: 4, reason: '合并饮品偏好' }], archive: [], practice: empty() });
  }, { longTerm: { enabled: true } });
  const facts = createLongTermStore(h.storage);
  facts.appendBatch([{ id: 'f1', text: '用户喜欢美式咖啡' }, { id: 'f2', text: '用户喜欢拿铁咖啡' }]);
  await h.observe('user', '桌宠ASR仍然在开发', 'manual-input'); await h.plugin.whenIdle();
  const before = facts.list();
  await assert.rejects(h.plugin.organize(), /已变化/);
  assert.deepEqual(facts.list(), before);
  assert.equal(facts.history().length, 0);
  assert.equal(h.repo.snapshot().projects.length, 1);
});

test('pet reply text and screen summaries without actual screenshots are never ingested as verification evidence', async t => {
  const h = app(t, async () => JSON.stringify(empty()));
  await h.bus.notify(EVENTS.DECISION_COMPLETED, { id: 'decision', observations: [],
    result: { reply: '宠物说测试通过', summaries: { screen: '测试成功' } } });
  await h.plugin.whenIdle();
  assert.equal(h.plugin.getSnapshot().practice.sources.length, 0);
});
