const { randomUUID } = require("node:crypto");
const { fingerprint, contentHash, indexText, timestamp, validatePlan } = require("../../memory/records");
const { tokenize } = require("../../memory/retrieval");

function createAdaptiveMemoryStore(db, { now = Date.now } = {}) {
  db.migrate("adaptive-memory", [sql => sql.exec(`
    CREATE TABLE adaptive_memory_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
      source TEXT NOT NULL, role TEXT NOT NULL, captured_at INTEGER NOT NULL, text TEXT NOT NULL,
      metadata_json TEXT NOT NULL, processed INTEGER NOT NULL DEFAULT 0, forgotten INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX adaptive_memory_pending ON adaptive_memory_events(processed, forgotten, sequence);
    CREATE TABLE adaptive_memory_entries(sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
      data_json TEXT NOT NULL, fingerprint TEXT NOT NULL, status TEXT NOT NULL);
    CREATE INDEX adaptive_memory_fingerprint ON adaptive_memory_entries(fingerprint);
    CREATE VIRTUAL TABLE adaptive_memory_fts USING fts5(id UNINDEXED, body);
    CREATE TABLE adaptive_memory_history(sequence INTEGER PRIMARY KEY AUTOINCREMENT, entry_id TEXT NOT NULL,
      changed_at INTEGER NOT NULL, reason TEXT NOT NULL, before_json TEXT, after_json TEXT);
    CREATE TABLE adaptive_memory_vectors(entry_id TEXT PRIMARY KEY, provider TEXT NOT NULL,
      content_hash TEXT NOT NULL, vector_json TEXT NOT NULL);
    CREATE TABLE adaptive_memory_forgotten(fingerprint TEXT PRIMARY KEY);
    CREATE TABLE adaptive_memory_meta(key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
  `), sql => {
    sql.exec(`CREATE TABLE adaptive_memory_provenance(entry_id TEXT NOT NULL, source_id TEXT NOT NULL,
      quote TEXT NOT NULL, PRIMARY KEY(entry_id,source_id,quote));
      CREATE INDEX adaptive_memory_source_refs ON adaptive_memory_provenance(source_id);`);
    const insert = sql.prepare("INSERT OR IGNORE INTO adaptive_memory_provenance VALUES (?,?,?)");
    for (const row of sql.prepare("SELECT id,data_json FROM adaptive_memory_entries").all()) {
      for (const ref of JSON.parse(row.data_json).evidence) insert.run(row.id, ref.sourceId, ref.quote);
    }
    for (const row of sql.prepare("SELECT entry_id,before_json,after_json FROM adaptive_memory_history").all()) {
      for (const json of [row.before_json, row.after_json].filter(Boolean)) for (const ref of JSON.parse(json).evidence) insert.run(row.entry_id, ref.sourceId, ref.quote);
    }
  }]);
  const state = (key, fallback) => {
    const row = db.prepare("SELECT value_json FROM adaptive_memory_meta WHERE key=?").get(key);
    return row ? JSON.parse(row.value_json) : fallback;
  };
  function setState(key, value) {
    db.prepare("INSERT INTO adaptive_memory_meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json")
      .run(key, JSON.stringify(value));
  }
  const revision = () => state("revision", 0);
  const changed = () => setState("revision", revision() + 1);
  const decode = r => ({ id: r.id, source: r.source, role: r.role, capturedAt: r.captured_at, text: r.text,
    metadata: JSON.parse(r.metadata_json), processed: Boolean(r.processed), forgotten: Boolean(r.forgotten) });
  const list = ({ includeArchived = false } = {}) => db.prepare(`SELECT data_json FROM adaptive_memory_entries
    ${includeArchived ? "" : "WHERE status='active'"} ORDER BY sequence DESC`).all().map(r => JSON.parse(r.data_json));
  const get = id => {
    const row = db.prepare("SELECT data_json FROM adaptive_memory_entries WHERE id=?").get(id);
    return row ? JSON.parse(row.data_json) : null;
  };
  function events({ pending = false, limit = 100, ids } = {}) {
    if (ids) return [...new Set(ids)].map(id => db.prepare("SELECT * FROM adaptive_memory_events WHERE id=?").get(id)).filter(Boolean).map(decode);
    return db.prepare(`SELECT * FROM adaptive_memory_events ${pending ? "WHERE processed=0 AND forgotten=0" : ""}
      ORDER BY ${pending ? "CASE WHEN role='user' THEN 0 ELSE 1 END, sequence ASC" : "sequence DESC"} LIMIT ?`).all(limit).map(decode);
  }
  function ingest(input) {
    if (!input || typeof input.text !== "string" || !input.text.trim() || input.role === "assistant") return [];
    const capturedAt = timestamp(input.capturedAt, now());
    const body = input.text.trim(), id = input.id || randomUUID(), ids = [];
    return db.transaction(() => {
      // Split rather than truncate: every passage remains available for extraction and provenance.
      for (let offset = 0; offset < body.length; offset += 6000) {
        const partId = offset ? `${id}:part:${offset / 6000}` : id;
        if (input.role !== "user") {
          const duplicate = db.prepare(`SELECT id FROM adaptive_memory_events WHERE source=? AND role='context' AND text=?
            AND forgotten=0 AND captured_at>=? AND captured_at<=? ORDER BY sequence DESC LIMIT 1`)
            .get(input.source || "unknown", body.slice(offset, offset + 6000), capturedAt - 60000, capturedAt);
          if (duplicate) { ids.push(duplicate.id); continue; }
        }
        db.prepare(`INSERT OR IGNORE INTO adaptive_memory_events(id,source,role,captured_at,text,metadata_json,processed)
          VALUES (?,?,?,?,?,?,?)`).run(partId, input.source || "unknown", input.role === "user" ? "user" : "context", capturedAt,
          body.slice(offset, offset + 6000), JSON.stringify({ ...input.metadata, ...(offset ? { parentId: id } : {}) }), input.processed ? 1 : 0);
        ids.push(partId);
      }
      return ids;
    });
  }
  function write(entry, before, reason) {
    const refs = db.prepare("INSERT OR IGNORE INTO adaptive_memory_provenance VALUES (?,?,?)");
    for (const r of entry.evidence) refs.run(entry.id, r.sourceId, r.quote);
    entry.evidence = entry.evidence.slice(-16);
    db.prepare(`INSERT INTO adaptive_memory_entries(id,data_json,fingerprint,status) VALUES (?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json,fingerprint=excluded.fingerprint,status=excluded.status`)
      .run(entry.id, JSON.stringify(entry), fingerprint(entry.text), entry.status);
    db.prepare("DELETE FROM adaptive_memory_fts WHERE id=?").run(entry.id);
    db.prepare("INSERT INTO adaptive_memory_fts(id,body) VALUES (?,?)").run(entry.id, tokenize(indexText(entry)).join(" "));
    if (!before || contentHash(before) !== contentHash(entry)) db.prepare("DELETE FROM adaptive_memory_vectors WHERE entry_id=?").run(entry.id);
    db.prepare("INSERT INTO adaptive_memory_history(entry_id,changed_at,reason,before_json,after_json) VALUES (?,?,?,?,?)")
      .run(entry.id, now(), reason, before ? JSON.stringify(before) : null, JSON.stringify(entry));
  }
  function snapshot({ batchSize = 16, maxSourceChars = 24000, entries = list(), pending } = {}) {
    const selected = [];
    let size = 0;
    for (const source of pending || events({ pending: true, limit: batchSize })) {
      if (selected.length && size + source.text.length > maxSourceChars) break;
      selected.push(source); size += source.text.length;
    }
    const sourceIds = [...entries.flatMap(e => e.evidence.map(r => r.sourceId)), ...selected.map(s => s.id)];
    return { revision: revision(), entries, pending: selected, sources: events({ ids: sourceIds }) };
  }
  function erase(id) {
    db.prepare("DELETE FROM adaptive_memory_entries WHERE id=?").run(id);
    db.prepare("DELETE FROM adaptive_memory_fts WHERE id=?").run(id);
    db.prepare("DELETE FROM adaptive_memory_vectors WHERE entry_id=?").run(id);
    db.prepare("DELETE FROM adaptive_memory_history WHERE entry_id=?").run(id);
    db.prepare("DELETE FROM adaptive_memory_provenance WHERE entry_id=?").run(id);
  }
  const provenance = (id, limit = 100) => db.prepare("SELECT source_id AS sourceId,quote FROM adaptive_memory_provenance WHERE entry_id=? ORDER BY rowid DESC LIMIT ?").all(id, limit);
  function forgetSources(ids, targetId) {
    return db.transaction(() => {
      const sourceIds = new Set(ids), entryIds = new Set(targetId ? [targetId] : []);
      for (const id of sourceIds) for (const row of db.prepare("SELECT DISTINCT entry_id FROM adaptive_memory_provenance WHERE source_id=?").all(id)) entryIds.add(row.entry_id);
      const removed = [...entryIds].map(get).filter(Boolean);
      // Shared-source copies and version history must not resurrect forgotten content.
      for (const e of removed) {
        db.prepare("INSERT OR IGNORE INTO adaptive_memory_forgotten VALUES (?)").run(fingerprint(e.text));
        erase(e.id);
      }
      for (const sourceId of sourceIds) db.prepare(`UPDATE adaptive_memory_events SET text='',metadata_json='{}',processed=1,forgotten=1 WHERE id=?`).run(sourceId);
      setState("questions", state("questions", []).filter(q => !(q.evidence || []).some(r => sourceIds.has(r.sourceId))));
      // Scrub historical versions of other entries that once cited a forgotten source.
      for (const row of db.prepare("SELECT sequence,before_json,after_json FROM adaptive_memory_history").all()) {
        if ([row.before_json, row.after_json].filter(Boolean).some(json => JSON.parse(json).evidence.some(r => sourceIds.has(r.sourceId)))) {
          db.prepare("DELETE FROM adaptive_memory_history WHERE sequence=?").run(row.sequence);
        }
      }
      changed();
      return { deleted: removed.length, discarded: sourceIds.size };
    });
  }
  function forget(id) {
    const target = get(id);
    if (!target) throw new Error("记忆已更新或删除，请刷新");
    return forgetSources(provenance(id, 100000).map(r => r.sourceId), id);
  }
  function apply(input, before, config = {}, { organize = false } = {}) {
    const plan = validatePlan(input, before, { organize });
    return db.transaction(() => {
      if (revision() !== before.revision) throw new Error("记忆已变化，本次维护结果未保存");
      for (const s of before.pending) {
        const live = events({ ids: [s.id] })[0];
        if (!live || live.processed || live.forgotten || JSON.stringify(live) !== JSON.stringify(s)) throw new Error("待处理来源已变化，本次维护结果未保存");
      }
      let added = 0, updated = 0, archived = 0, deleted = 0, discarded = 0;
      for (const item of plan.upsert) {
        const old = item.id ? get(item.id) : null;
        const hash = fingerprint(item.text);
        if (db.prepare("SELECT 1 FROM adaptive_memory_forgotten WHERE fingerprint=?").get(hash)) {
          const direct = item.evidence.some(r => before.pending.some(s => s.id === r.sourceId && s.role === "user"));
          if (!direct) continue;
          // New user evidence can intentionally reintroduce content; old observations cannot.
          db.prepare("DELETE FROM adaptive_memory_forgotten WHERE fingerprint=?").run(hash);
        }
        const duplicate = db.prepare("SELECT data_json FROM adaptive_memory_entries WHERE fingerprint=? AND status='active' AND id<>? LIMIT 1")
          .get(fingerprint(item.text), old?.id || "");
        if (duplicate) {
          if (old) throw new Error("更新结果与另一条记忆重复，请由模型显式整理");
          const e = JSON.parse(duplicate.data_json);
          const entry = { ...e, evidence: [...e.evidence, ...item.evidence].filter((r, i, a) => a.findIndex(x => x.sourceId === r.sourceId && x.quote === r.quote) === i),
            topics: [...new Set([...e.topics, ...item.topics])].slice(0, 8), tags: [...new Set([...e.tags, ...item.tags])].slice(0, 16),
            aliases: [...new Set([...e.aliases, ...item.aliases])].slice(0, 16), updatedAt: now(), version: e.version + 1,
            observedAt: Math.max(e.observedAt, item.observedAt), basis: e.basis === "user" || item.basis === "user" ? "user" : e.basis,
            confidence: Math.max(e.confidence, item.confidence), importance: Math.max(e.importance, item.importance) };
          write(entry, e, "合并重复记忆的来源与检索表达"); updated++; continue;
        }
        if (!old && db.prepare("SELECT COUNT(*) AS n FROM adaptive_memory_entries WHERE status='active'").get().n >= (config.maxEntries || 5000)) throw new Error("记忆容量已满；请整理或调整 store.maxEntries，来源仍已保留");
        const entry = { ...item, id: old?.id || randomUUID(), status: "active", createdAt: old?.createdAt ?? now(),
          updatedAt: now(), observedAt: Math.max(item.observedAt, old?.observedAt || 0), version: (old?.version || 0) + 1,
          evidence: [...(old?.evidence || []), ...item.evidence].filter((r, i, a) => a.findIndex(x => x.sourceId === r.sourceId && x.quote === r.quote) === i) };
        delete entry.reason;
        write(entry, old, item.reason); if (old) updated++; else added++;
      }
      for (const item of plan.archive) {
        const old = get(item.id);
        write({ ...old, status: "archived", updatedAt: now(), version: old.version + 1 }, old, item.reason); archived++;
      }
      for (const item of plan.forget) { if (get(item.id)) deleted += forget(item.id).deleted; }
      if (plan.discard.length) { const result = forgetSources(plan.discard.map(d => d.sourceId)); deleted += result.deleted; discarded += result.discarded; }
      for (const q of plan.questions) {
        const questions = state("questions", []);
        if (questions.length >= (config.maxQuestions || 30) || questions.some(old => old.prompt === q.prompt) ||
            state("dismissedQuestions", []).includes(fingerprint(q.prompt))) continue;
        questions.push({ ...q, id: randomUUID(), status: "pending", skips: 0, nextAt: now(), createdAt: now(), lastShownAt: 0, answers: [],
          subject: { kind: "topic", name: q.topic }, field: "", scope: q.topic }); setState("questions", questions);
      }
      for (const s of before.pending) db.prepare("UPDATE adaptive_memory_events SET processed=1 WHERE id=?").run(s.id);
      changed();
      return { added, updated, archived, deleted, discarded, processed: before.pending.length, before: before.entries.length, after: list().length };
    });
  }
  function correct(id, value, { pinned, expiresAt } = {}) {
    if (typeof value !== "string" || !value.trim() || value.length > 4000 || pinned != null && typeof pinned !== "boolean" ||
        expiresAt != null && (!Number.isSafeInteger(expiresAt) || expiresAt < 0 || expiresAt > 8640000000000000)) throw new Error("修正内容或常驻设置无效");
    return db.transaction(() => {
      const old = get(id);
      if (!old) throw new Error("记忆已删除，请刷新");
      const sourceId = randomUUID();
      ingest({ id: sourceId, source: "user-correction", role: "user", text: value, processed: true });
      const entry = { ...old, text: value.trim(), basis: "user", confidence: 1, protected: true, status: "active",
        evidence: [...old.evidence, { sourceId, quote: value.trim() }], version: old.version + 1, observedAt: now(), updatedAt: now(),
        pinned: pinned ?? old.pinned, expiresAt: expiresAt === undefined ? old.expiresAt : expiresAt };
      write(entry, old, "用户手动修正"); changed(); return { ok: true };
    });
  }
  function candidates(query, limit = 100) {
    const tokens = tokenize(query);
    if (!tokens.length) return [];
    const match = tokens.map(t => `"${t.replace(/"/g, '""')}"`).join(" OR ");
    return db.prepare(`SELECT e.data_json FROM adaptive_memory_fts f JOIN adaptive_memory_entries e ON e.id=f.id
      WHERE adaptive_memory_fts MATCH ? ORDER BY bm25(adaptive_memory_fts) LIMIT ?`).all(match, limit).map(r => JSON.parse(r.data_json));
  }
  function vectors(provider) {
    const result = new Map();
    for (const r of db.prepare("SELECT * FROM adaptive_memory_vectors WHERE provider=?").all(provider)) {
      const e = get(r.entry_id);
      if (e && r.content_hash === contentHash(e)) result.set(e.id, JSON.parse(r.vector_json));
    }
    return result;
  }
  function saveVector(id, provider, hash, vector) {
    const entry = get(id);
    if (!entry || contentHash(entry) !== hash) return false;
    db.prepare("INSERT INTO adaptive_memory_vectors VALUES (?,?,?,?) ON CONFLICT(entry_id) DO UPDATE SET provider=excluded.provider,content_hash=excluded.content_hash,vector_json=excluded.vector_json")
      .run(id, provider, hash, JSON.stringify(vector)); return true;
  }
  function history(id, limit = 30) {
    return db.prepare("SELECT * FROM adaptive_memory_history WHERE entry_id=? ORDER BY sequence DESC LIMIT ?").all(id, limit)
      .map(r => ({ changedAt: r.changed_at, reason: r.reason, before: r.before_json ? JSON.parse(r.before_json) : null, after: r.after_json ? JSON.parse(r.after_json) : null }));
  }
  function pruneEvents(before, limit = 500) {
    const protectedIds = new Set(state("questions", []).flatMap(q => (q.evidence || []).map(r => r.sourceId)));
    const rows = db.prepare(`SELECT id FROM adaptive_memory_events e WHERE processed=1 AND captured_at<?
      AND NOT EXISTS(SELECT 1 FROM adaptive_memory_provenance p WHERE p.source_id=e.id) LIMIT ?`).all(before, limit);
    return db.transaction(() => {
      let removed = 0;
      for (const r of rows) if (!protectedIds.has(r.id)) removed += db.prepare("DELETE FROM adaptive_memory_events WHERE id=?").run(r.id).changes;
      return removed;
    });
  }
  function importLegacy(input) {
    if (state("legacyImported", false)) return;
    db.transaction(() => {
      for (const source of input.sources) ingest(source);
      for (const e of input.entries) {
        if (!get(e.id)) write(e, null, "导入旧版记忆，保留原确认状态");
      }
      for (const e of input.entries) if (e.historyFor && get(e.historyFor)) {
        const insert = db.prepare("INSERT OR IGNORE INTO adaptive_memory_provenance VALUES (?,?,?)");
        for (const ref of e.evidence) insert.run(e.historyFor, ref.sourceId, ref.quote);
      }
      if (input.questions?.length) setState("questions", [...state("questions", []), ...input.questions]);
      setState("legacyImported", true); changed();
    });
  }
  function clear() {
    return db.transaction(() => {
      const deleted = list({ includeArchived: true }).length;
      for (const table of ["adaptive_memory_entries", "adaptive_memory_events", "adaptive_memory_history", "adaptive_memory_fts", "adaptive_memory_vectors", "adaptive_memory_provenance", "adaptive_memory_forgotten", "adaptive_memory_meta"]) db.exec(`DELETE FROM ${table}`);
      setState("legacyImported", true); changed(); return { deleted };
    });
  }
  function stats() {
    return { revision: revision(), pending: db.prepare("SELECT COUNT(*) AS n FROM adaptive_memory_events WHERE processed=0 AND forgotten=0").get().n,
      events: db.prepare("SELECT COUNT(*) AS n FROM adaptive_memory_events WHERE forgotten=0").get().n,
      entries: db.prepare("SELECT COUNT(*) AS n FROM adaptive_memory_entries WHERE status='active'").get().n, legacyImported: state("legacyImported", false) };
  }
  return { ingest, list, get, events, snapshot, apply, correct, forget, candidates, vectors, saveVector, history, provenance, pruneEvents, importLegacy, clear, stats, state, setState };
}
module.exports = { createAdaptiveMemoryStore };
