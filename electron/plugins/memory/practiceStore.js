const { randomUUID } = require('node:crypto');
const { tokenize } = require('./longTerm');
const { validatePracticePlan } = require('./practicePlanner');

function createPracticeStore(storage, { now = Date.now } = {}) {
  storage.migrate('memory-practice', [db => db.exec(`
    CREATE TABLE memory_practice_entries (sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT UNIQUE NOT NULL, kind TEXT NOT NULL, identity TEXT NOT NULL, data_json TEXT NOT NULL,
      UNIQUE(kind, identity));
    CREATE TABLE memory_practice_sources (sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT UNIQUE NOT NULL, data_json TEXT NOT NULL, processed INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE memory_practice_history (sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      updated_at INTEGER NOT NULL, entry_id TEXT NOT NULL, before_json TEXT, after_json TEXT NOT NULL);
  `)]);
  const read = rows => rows.map(r => JSON.parse(r.data_json));
  function list(kind) { return read(storage.prepare('SELECT data_json FROM memory_practice_entries WHERE kind=? ORDER BY sequence DESC').all(kind)); }
  const snapshot = () => ({ projects: list('projects'), lessons: list('lessons') });
  function sources(pending = true) {
    return read(storage.prepare(`SELECT data_json FROM memory_practice_sources ${pending ? 'WHERE processed=0' : ''} ORDER BY sequence`).all());
  }
  function ingest(input) {
    if (!input || !['user', 'screen', 'audio-output'].includes(input.source) || typeof input.text !== 'string' || !input.text.trim()) return;
    const parsed = typeof input.capturedAt === 'number' ? input.capturedAt : Date.parse(input.capturedAt);
    const source = { ...input, id: input.id || randomUUID(), text: input.text.trim(), capturedAt: Number.isFinite(parsed) ? parsed : now() };
    storage.prepare('INSERT OR IGNORE INTO memory_practice_sources(id,data_json) VALUES (?,?)').run(source.id, JSON.stringify(source));
  }
  function apply(input, before, evidence) {
    const plan = validatePracticePlan(input, before, evidence);
    return storage.transaction(() => {
      if (JSON.stringify(snapshot()) !== JSON.stringify(before)) throw new Error('项目与经验记忆已变化，请重新整理');
      const pending = new Map(sources().map(s => [s.id, s]));
      if (evidence.some(s => JSON.stringify(pending.get(s.id)) !== JSON.stringify(s))) throw new Error('项目与经验来源已变化，请重新整理');
      let updated = 0, added = 0;
      for (const kind of ['projects', 'lessons']) {
        const known = new Map(before[kind].map(e => [e.id, e]));
        for (const item of [...plan[kind].update, ...plan[kind].add]) {
          const old = known.get(item.id);
          const observedAt = Math.max(...item.sourceIds.map(id => pending.get(id).capturedAt));
          if (old && observedAt < old.observedAt) throw new Error('旧来源不能覆盖较新的项目或经验状态');
          const entry = { ...item, id: old?.id || randomUUID(), updatedAt: now(), observedAt,
            createdAt: old?.createdAt || now(), sourceIds: [...new Set([...(old?.sourceIds || []), ...item.sourceIds])] };
          const identity = JSON.stringify([entry.name || entry.title, entry.scope]);
          storage.prepare(`INSERT INTO memory_practice_entries(id,kind,identity,data_json) VALUES (?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json`).run(entry.id, kind, identity, JSON.stringify(entry));
          storage.prepare('INSERT INTO memory_practice_history(updated_at,entry_id,before_json,after_json) VALUES (?,?,?,?)')
            .run(now(), entry.id, old ? JSON.stringify(old) : null, JSON.stringify(entry));
          if (old) updated++; else added++;
        }
      }
      for (const s of evidence) storage.prepare('UPDATE memory_practice_sources SET processed=1 WHERE id=?').run(s.id);
      return { updated, added };
    });
  }
  function context(query, config) {
    const tokens = [...new Set([...tokenize(query), ...(String(query).toLowerCase().match(/[a-z][a-z0-9_-]{1,}/g) || [])])];
    const score = entry => {
      const body = JSON.stringify([entry.name, entry.title, entry.scope, entry.goal, entry.condition,
        entry.completed, entry.pending, entry.blockers, entry.nextSteps, entry.steps, entry.outcome]).toLowerCase();
      return tokens.reduce((sum, token) => sum + (body.includes(token) ? 1 : 0), 0);
    };
    const select = entries => tokens.length ? entries.map(e => ({ e, score: score(e) })).filter(p => p.score > 0)
      .sort((a,b) => b.score-a.score || b.e.updatedAt-a.e.updatedAt).slice(0, config.maxInject).map(p=>p.e) : [];
    const projects = select(list('projects')), lessons = select(list('lessons'));
    const stale = p => now() - p.observedAt > config.staleAfterMs;
    return [
      ...(projects.length ? [{ id: 'project-state', title: '项目当前状态（以最后来源时间为准）', text: projects.map(p =>
        `${p.name}${p.scope ? `【${p.scope}】` : ''} · ${p.status} · 最后来源 ${new Date(p.observedAt).toISOString()}${stale(p) ? ' · 已久未更新，请先确认现状' : ''}\n目标：${p.goal}\n已完成：${p.completed.join('；')}\n待确认/未完成：${p.pending.join('；')}\n阻塞：${p.blockers.join('；')}\n下一步：${p.nextSteps.join('；')}`).join('\n\n') }] : []),
      ...(lessons.length ? [{ id: 'experience-memory', title: '有来源的经验（验证结果只适用于记录的条件）', text: lessons.map(l =>
        `${l.title}${l.scope ? `【${l.scope}】` : ''} · ${{attempted:'尝试过，未验证',verified:'已有验证来源',failed:'失败记录'}[l.status]}\n适用条件：${l.condition}\n方法：${l.steps.join('；')}\n结果：${l.outcome}${l.verification ? `\n验证来源 ${l.verification.sourceId}：${l.verification.quote}` : ''}`).join('\n\n') }] : []),
    ];
  }
  function clear() { storage.transaction(() => { for (const table of ['memory_practice_entries','memory_practice_history','memory_practice_sources']) storage.exec(`DELETE FROM ${table}`); }); }
  return { snapshot, sources, ingest, apply, context, clear,
    history: () => storage.prepare('SELECT * FROM memory_practice_history ORDER BY sequence DESC').all().map(r=>({
      updatedAt:r.updated_at, entryId:r.entry_id, before:r.before_json ? JSON.parse(r.before_json):null, after:JSON.parse(r.after_json) })) };
}
module.exports = { createPracticeStore };
