const { randomUUID } = require("crypto");
const fs = require("fs");
const path = require("path");
const { validatePlan } = require("./organizer");
const { validateUpdatePlan } = require("./updater");

function getDefaults() {
  return { enabled: true, legacyPath: "logs/memory.jsonl", maxInject: 5,
    extractEveryNTurns: 20, maxTokens: 16384, maxEntries: 500 };
}

function tokenize(text) {
  const s = String(text || "").toLowerCase();
  /** @type {string[]} */
  const parts = [];
  for (const t of s.split(/[^\p{L}\p{N}]+/u)) {
    if (t.length >= 2) parts.push(t);
  }
  const cjkRuns = s.match(/[\u4e00-\u9fff]+/g) || [];
  for (const run of cjkRuns) {
    if (run.length === 1) {
      parts.push(run);
      continue;
    }
    for (let i = 0; i < run.length - 1; i++) {
      parts.push(run.slice(i, i + 2));
    }
    if (run.length >= 3 && run.length <= 8) parts.push(run);
  }
  return [...new Set(parts)];
}

function scoreItem(item, queryTokens) {
  const text = String(item.text || "").toLowerCase();
  const tags = Array.isArray(item.tags)
    ? item.tags.map((t) => String(t).toLowerCase())
    : [];
  let score = 0;
  for (const tok of queryTokens) {
    if (!tok) continue;
    if (tags.some((t) => t.includes(tok) || tok.includes(t))) score += 3;
    if (text.includes(tok)) score += 2;
  }
  score += (Number(item.importance) || 2) * 0.4;
  const ageDays = (Date.now() - (item.createdAt || 0)) / 86_400_000;
  score += 1 / (1 + Math.max(0, ageDays));
  return score;
}

function formatForPrompt(items) {
  if (!items.length) return "";
  return items.map((e) => `- (${e.type || "fact"}) ${e.text}`).join("\n");
}

function decodeEntry(row) {
  return { id: row.id, type: row.type, text: row.text, tags: JSON.parse(row.tags_json),
    importance: row.importance, createdAt: row.created_at, metadata: JSON.parse(row.metadata_json) };
}

/** Inspect stored facts without initializing storage or applying retrieval limits. */
function listEntries(storage) {
  if (!storage.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memory_entries'").get()) return [];
  return storage.prepare("SELECT * FROM memory_entries ORDER BY sequence DESC").all().map(decodeEntry);
}

function createLongTermStore(storage) {
  storage.migrate("memory", [(db) => db.exec(`
    CREATE TABLE memory_entries (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL, text TEXT NOT NULL, normalized_text TEXT NOT NULL UNIQUE,
      tags_json TEXT NOT NULL, importance REAL NOT NULL CHECK(importance BETWEEN 1 AND 5),
      created_at INTEGER NOT NULL, metadata_json TEXT NOT NULL
    );
    CREATE INDEX memory_entries_time ON memory_entries(created_at DESC, sequence DESC);
  `), (db) => db.exec(`
    CREATE TABLE memory_organization_history (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, organized_at INTEGER NOT NULL,
      reason TEXT NOT NULL, originals_json TEXT NOT NULL, replacement_id TEXT
    );
  `)]);
  const insert = storage.prepare(`INSERT OR IGNORE INTO memory_entries
    (id, type, text, normalized_text, tags_json, importance, created_at, metadata_json)
    VALUES (@id, @type, @text, @normalizedText, @tags, @importance, @createdAt, @metadata)`);
  const exactDuplicate = storage.prepare("SELECT 1 FROM memory_entries WHERE normalized_text = ? LIMIT 1");
  const nearDuplicate = storage.prepare(`SELECT 1 FROM memory_entries
    WHERE length(normalized_text) >= 8 AND
    (instr(normalized_text, @text) > 0 OR instr(@text, normalized_text) > 0) LIMIT 1`);

  function normalize(entry, fallbackId) {
    if (!entry || typeof entry.text !== "string" || !entry.text.trim()) return null;
    const text = entry.text.trim();
    const importance = Number(entry.importance);
    const stamp = Number(entry.createdAt);
    return { id: String(entry.id || fallbackId || randomUUID()),
      type: String(entry.type || "fact"), text, normalizedText: text.toLowerCase(),
      tags: JSON.stringify(Array.isArray(entry.tags) ? entry.tags.map((tag) => String(tag).toLowerCase()).filter(Boolean) : []),
      importance: Number.isFinite(importance) ? Math.min(5, Math.max(1, importance)) : 2,
      createdAt: Number.isFinite(stamp) && stamp > 0 ? Math.trunc(stamp) : Date.now(),
      metadata: JSON.stringify(entry.metadata || {}) };
  }

  function isDuplicate(text) {
    const needle = String(text || "").trim().toLowerCase();
    if (!needle) return true;
    return Boolean(exactDuplicate.get(needle) || (needle.length >= 8 && nearDuplicate.get({ text: needle })));
  }

  function compact(config = {}) {
    const max = Math.max(1, Math.floor(Number(config.maxEntries) || 500));
    storage.prepare(`DELETE FROM memory_entries WHERE sequence NOT IN
      (SELECT sequence FROM memory_entries ORDER BY sequence DESC LIMIT ?)`).run(max);
  }

  function appendBatch(facts, config = {}, metadata = {}) {
    if (config.enabled === false) return 0;
    return storage.transaction(() => {
      let added = 0;
      for (const fact of facts) {
        const record = normalize({ ...fact, metadata: { ...fact.metadata, ...metadata } });
        if (!record || isDuplicate(record.text)) continue;
        added += insert.run(record).changes;
      }
      compact(config);
      return added;
    });
  }

  function retrieve(queryText, config = {}) {
    if (config.enabled === false) return [];
    const items = storage.prepare("SELECT * FROM memory_entries ORDER BY sequence DESC LIMIT ?")
      .all(Math.max(1, Math.floor(Number(config.maxEntries) || 500)))
      .map(decodeEntry);
    const tokens = tokenize(queryText);
    const maxInject = Math.max(1, Math.floor(Number(config.maxInject) || 5));
    if (!tokens.length) {
      return items.sort((left, right) => right.importance - left.importance || right.createdAt - left.createdAt).slice(0, maxInject);
    }
    return items.filter((item) => tokens.some((tok) => String(item.text).toLowerCase().includes(tok) ||
      item.tags.some((tag) => tag.includes(tok) || tok.includes(tag))))
      .map((item) => ({ item, score: scoreItem(item, tokens) }))
      .filter(({ score }) => score > 0.5).sort((left, right) => right.score - left.score)
      .slice(0, maxInject).map(({ item }) => item);
  }

  function importLegacy(sourcePath, config, logger) {
    const result = storage.importJsonl("memory", sourcePath, (entry, id) => {
      const record = normalize(entry, id);
      return record ? insert.run(record).changes > 0 : false;
    });
    if (!result.missing) compact(config);
    if (!result.missing && !result.alreadyImported) logger.info(`legacy memory imported=${result.imported} skipped=${result.skipped}`);
    return result;
  }

  function organize(input, snapshot) {
    const plan = validatePlan({ merge: input?.merge, archive: input?.archive }, snapshot);
    return storage.transaction(() => {
      const before = listEntries(storage);
      // Reject stale snapshots rather than replacing changed or newly imported facts.
      if (JSON.stringify(before) !== JSON.stringify(snapshot)) throw new Error("长期记忆已变化，请重新整理");
      const byId = new Map(snapshot.map((entry) => [entry.id, entry]));
      const stamp = Date.now();
      const replacements = plan.merge.map((item) => {
        const originals = item.sourceIds.map((id) => byId.get(id));
        const metadata = { organizedAt: stamp, sourceMemoryIds: item.sourceIds };
        for (const key of ["sourceMemoryIds", "sourceDecisionIds", "sourceSessionIds", "sourceEvidenceIds", "sourceProfileIds"]) {
          metadata[key] = [...new Set([...(metadata[key] || []),
            ...originals.flatMap((entry) => Array.isArray(entry.metadata?.[key]) ? entry.metadata[key] : [])])];
        }
        return { item, originals, record: normalize({ ...item,
          createdAt: Math.max(...originals.map((entry) => entry.createdAt)), metadata }) };
      });
      const remove = storage.prepare("DELETE FROM memory_entries WHERE id = ?");
      for (const item of plan.merge) for (const id of item.sourceIds) remove.run(id);
      for (const item of plan.archive) remove.run(item.id);
      const archive = storage.prepare(`INSERT INTO memory_organization_history
        (organized_at, reason, originals_json, replacement_id) VALUES (?, ?, ?, ?)`);
      for (const { item, originals, record } of replacements) {
        if (insert.run(record).changes !== 1) throw new Error("合并后的记忆与其他记录重复，原始记忆已保留");
        archive.run(stamp, item.reason, JSON.stringify(originals), record.id);
      }
      for (const item of plan.archive) archive.run(stamp, item.reason, JSON.stringify([byId.get(item.id)]), null);
      return { before: before.length, after: before.length - plan.merge.reduce((sum, item) => sum + item.sourceIds.length - 1, 0) - plan.archive.length,
        merged: plan.merge.length, archived: plan.archive.length };
    });
  }

  function history() {
    return storage.prepare("SELECT * FROM memory_organization_history ORDER BY sequence DESC").all()
      .map((row) => ({ organizedAt: row.organized_at, reason: row.reason,
        originals: JSON.parse(row.originals_json), replacementId: row.replacement_id }));
  }
  function updateFromDialogue(input, snapshot, turns, evidence = [], config = {}) {
    const plan = validateUpdatePlan(input, snapshot, turns, evidence);
    return storage.transaction(() => {
      if (JSON.stringify(listEntries(storage)) !== JSON.stringify(snapshot)) throw new Error("长期记忆已变化，请重新更新");
      const stamp = Date.now(), known = new Map(snapshot.map((e) => [e.id, e]));
      function record(item, old) {
        const sourceTurns = turns.filter((t) => item.sourceTurnIds.includes(t.id));
        const sourceEvidence = evidence.filter((e) => item.sourceEvidenceIds.includes(e.id));
        const metadata = { ...old?.metadata, updatedAt: stamp,
          updateSources: { turns: sourceTurns, evidence: sourceEvidence } };
        const refs = { sourceTurnIds: item.sourceTurnIds, sourceEvidenceIds: item.sourceEvidenceIds,
          sourceDecisionIds: sourceTurns.map((t) => t.decisionId).filter(Boolean),
          sourceSessionIds: sourceTurns.map((t) => t.sessionId).filter(Boolean) };
        for (const [key, values] of Object.entries(refs)) metadata[key] = [...new Set([...(Array.isArray(metadata[key]) ? metadata[key] : []), ...values])];
        return normalize({ ...item, id: old?.id, createdAt: old?.createdAt || stamp, metadata });
      }
      // Delete/reinsert updated slots inside the transaction so valid text swaps don't hit UNIQUE.
      const records = plan.update.map((item) => ({ original: known.get(item.id), replacement: record(item, known.get(item.id)) }));
      for (const { original } of records) storage.prepare("DELETE FROM memory_entries WHERE id = ?").run(original.id);
      const archive = storage.prepare(`INSERT INTO memory_organization_history
        (organized_at, reason, originals_json, replacement_id) VALUES (?, ?, ?, ?)`);
      for (const { original, replacement } of records) {
        if (insert.run(replacement).changes !== 1) throw new Error("更新后的记忆与其他条目重复，原始记忆已保留");
        archive.run(stamp, "基于对话更新已有记忆", JSON.stringify([original]), original.id);
      }
      const capacity = Math.max(1, Number(config.maxEntries) || getDefaults().maxEntries);
      if (plan.add.length && snapshot.length + plan.add.length > capacity) throw new Error("长期记忆容量不足，不能通过新增淘汰已有记忆");
      for (const item of plan.add) {
        if (insert.run(record(item)).changes !== 1) throw new Error("新增长期记忆与现有条目重复，原始记忆已保留");
      }
      return { updated: records.length, added: plan.add.length, before: snapshot.length, after: snapshot.length + plan.add.length };
    });
  }
  function importProfiles(profiles) {
    return storage.transaction(() => {
      for (const p of profiles) {
        const text = `${p.subject.name}${p.scope ? `【${p.scope}】` : ""}：${p.value}`;
        const metadata = { sourceProfileIds: [p.id], sourceEvidenceIds: p.evidenceIds, basis: p.basis, confidence: p.confidence };
        const old = storage.prepare("SELECT * FROM memory_entries WHERE normalized_text = ?").get(text.toLowerCase());
        if (old) {
          const previous = JSON.parse(old.metadata_json);
          for (const key of ["sourceProfileIds", "sourceEvidenceIds"]) previous[key] = [...new Set([...(previous[key] || []), ...metadata[key]])];
          previous.profileSources = [...(previous.profileSources || []), { id: p.id, basis: p.basis, confidence: p.confidence }];
          storage.prepare("UPDATE memory_entries SET metadata_json = ? WHERE id = ?").run(JSON.stringify(previous), old.id);
        } else {
          insert.run(normalize({ type: "event", text, tags: [p.subject.name, p.scope].filter(Boolean),
            importance: p.basis === "user_answer" ? 4 : 2, createdAt: p.updatedAt, metadata }));
        }
      }
      // Migration retains all facts; it must not prune unrelated older memory.
      return { moved: profiles.length };
    });
  }

  function clear(legacyPath) {
    const source = path.resolve(legacyPath);
    if (fs.existsSync(source)) fs.truncateSync(source, 0);
    return storage.transaction(() => {
      const deleted = storage.prepare("DELETE FROM memory_entries").run().changes;
      storage.exec("DELETE FROM memory_organization_history");
      // Preserve and add import markers so older files cannot restore cleared facts.
      storage.prepare(`INSERT INTO legacy_imports
        (namespace, source_path, imported_at, imported_count, skipped_count)
        VALUES ('memory', ?, ?, 0, 0) ON CONFLICT(namespace, source_path)
        DO UPDATE SET imported_at = excluded.imported_at, imported_count = 0, skipped_count = 0`)
        .run(source, Date.now());
      return deleted;
    });
  }

  return { appendBatch, retrieve, list: () => listEntries(storage), organize, history, importProfiles, updateFromDialogue,
    isDuplicate, formatForPrompt, importLegacy, clear };
}

module.exports = { getDefaults, tokenize, formatForPrompt, listEntries, createLongTermStore };
