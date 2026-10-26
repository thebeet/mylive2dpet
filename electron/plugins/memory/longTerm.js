const { randomUUID } = require("crypto");
const fs = require("fs");
const path = require("path");

function getDefaults() {
  return { enabled: true, legacyPath: "logs/memory.jsonl", maxInject: 5,
    extractEveryNTurns: 3, maxTokens: 256, maxEntries: 500 };
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

function createLongTermStore(storage) {
  storage.migrate("memory", [(db) => db.exec(`
    CREATE TABLE memory_entries (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL, text TEXT NOT NULL, normalized_text TEXT NOT NULL UNIQUE,
      tags_json TEXT NOT NULL, importance REAL NOT NULL CHECK(importance BETWEEN 1 AND 5),
      created_at INTEGER NOT NULL, metadata_json TEXT NOT NULL
    );
    CREATE INDEX memory_entries_time ON memory_entries(created_at DESC, sequence DESC);
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
      .map((row) => ({ id: row.id, type: row.type, text: row.text, tags: JSON.parse(row.tags_json),
        importance: row.importance, createdAt: row.created_at, metadata: JSON.parse(row.metadata_json) }));
    const tokens = tokenize(queryText);
    const maxInject = Math.max(1, Math.floor(Number(config.maxInject) || 5));
    if (!tokens.length) {
      return items.sort((left, right) => right.importance - left.importance || right.createdAt - left.createdAt).slice(0, maxInject);
    }
    return items.map((item) => ({ item, score: scoreItem(item, tokens) }))
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

  function clear(legacyPath) {
    const source = path.resolve(legacyPath);
    if (fs.existsSync(source)) fs.truncateSync(source, 0);
    return storage.transaction(() => {
      const deleted = storage.prepare("DELETE FROM memory_entries").run().changes;
      // Preserve and add import markers so older files cannot restore cleared facts.
      storage.prepare(`INSERT INTO legacy_imports
        (namespace, source_path, imported_at, imported_count, skipped_count)
        VALUES ('memory', ?, ?, 0, 0) ON CONFLICT(namespace, source_path)
        DO UPDATE SET imported_at = excluded.imported_at, imported_count = 0, skipped_count = 0`)
        .run(source, Date.now());
      return deleted;
    });
  }

  return { appendBatch, retrieve, isDuplicate, formatForPrompt, importLegacy, clear };
}

module.exports = { getDefaults, tokenize, formatForPrompt, createLongTermStore };
