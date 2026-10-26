const { randomUUID } = require("crypto");

function createHistoryRepository(storage) {
  storage.migrate("dialogue-history", [(db) => db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, ended_at INTEGER
    );
    CREATE TABLE dialogue_turns (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL REFERENCES sessions(id), created_at INTEGER NOT NULL,
      user_text TEXT NOT NULL, reply TEXT NOT NULL, expression TEXT NOT NULL,
      summaries_json TEXT NOT NULL, trigger TEXT NOT NULL, metadata_json TEXT NOT NULL
    );
    CREATE INDEX dialogue_turns_time ON dialogue_turns(created_at DESC, sequence DESC);
    CREATE INDEX dialogue_turns_session ON dialogue_turns(session_id, sequence DESC);
  `)]);
  const insertSession = storage.prepare("INSERT INTO sessions(id, started_at) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET ended_at = NULL");
  const insertTurn = storage.prepare(`INSERT OR IGNORE INTO dialogue_turns
    (id, session_id, created_at, user_text, reply, expression, summaries_json, trigger, metadata_json)
    VALUES (@id, @sessionId, @t, @userSaid, @petSaid, @expression, @summaries, @trigger, @metadata)`);
  const sessionIds = new Set();
  const fallbackSession = randomUUID();

  function append(entry) {
    const reply = typeof entry?.petSaid === "string" ? entry.petSaid.trim() : "";
    if (!reply) return false;
    const sessionId = String(entry.sessionId || fallbackSession);
    const stamp = Number(entry.t);
    const t = Number.isFinite(stamp) && stamp > 0 ? Math.trunc(stamp) : Date.now();
    const startedAt = Number(entry.sessionStartedAt);
    const summaries = entry.summaries && typeof entry.summaries === "object" && !Array.isArray(entry.summaries)
      ? Object.fromEntries(Object.entries(entry.summaries).filter(([, value]) => typeof value === "string"))
      : { screen: String(entry.screenSummary || ""), audio: String(entry.audioSummary || "") };
    return storage.transaction(() => {
      insertSession.run(sessionId, Number.isFinite(startedAt) && startedAt > 0 ? Math.trunc(startedAt) : t);
      const result = insertTurn.run({
        id: String(entry.id || randomUUID()), sessionId, t,
        userSaid: String(entry.userSaid || "").trim(), petSaid: reply,
        expression: String(entry.expression || "neutral"), trigger: String(entry.trigger || ""),
        summaries: JSON.stringify(summaries),
        metadata: JSON.stringify(entry.metadata || {}),
      });
      if (result.changes) sessionIds.add(sessionId);
      return result.changes > 0;
    });
  }

  function list({ limit = 100, before = null, search = "" } = {}) {
    const boundedLimit = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
    if (before != null && (!Number.isSafeInteger(before.sequence) || before.sequence <= 0 ||
        !Number.isSafeInteger(before.t) || before.t < 0)) throw new Error("无效的历史分页游标");
    const query = String(search || "").trim().slice(0, 200);
    const predicates = [];
    const parameters = [];
    if (before != null) {
      predicates.push("(created_at < ? OR (created_at = ? AND sequence < ?))");
      parameters.push(before.t, before.t, before.sequence);
    }
    if (query) {
      predicates.push("(instr(user_text, ?) > 0 OR instr(reply, ?) > 0)");
      parameters.push(query, query);
    }
    const rows = storage.prepare(`SELECT * FROM dialogue_turns ${predicates.length ? `WHERE ${predicates.join(" AND ")}` : ""}
      ORDER BY created_at DESC, sequence DESC LIMIT ?`).all(...parameters, boundedLimit + 1);
    const hasMore = rows.length > boundedLimit;
    const entries = rows.slice(0, boundedLimit).map((row) => {
      const summaries = JSON.parse(row.summaries_json);
      return { id: row.id, sequence: row.sequence, sessionId: row.session_id, t: row.created_at,
        userSaid: row.user_text, petSaid: row.reply, expression: row.expression,
        trigger: row.trigger, summaries, metadata: JSON.parse(row.metadata_json) };
    });
    const last = entries.at(-1);
    return { entries, nextCursor: hasMore ? { t: last.t, sequence: last.sequence } : null };
  }

  function importLegacy(sourcePath, logger) {
    const imported = storage.importJsonl("dialogue-history", sourcePath, (entry, id) => {
      if (!entry || typeof entry !== "object") return false;
      return append({ ...entry, id, sessionId: "legacy-jsonl", metadata: { legacyImport: true } });
    });
    // Imported sessions represent past data, not the running application session.
    if (!imported.missing) {
      storage.prepare("UPDATE sessions SET ended_at = (SELECT MAX(created_at) FROM dialogue_turns WHERE session_id = sessions.id) WHERE id = 'legacy-jsonl'").run();
      sessionIds.delete("legacy-jsonl");
    }
    if (!imported.missing && !imported.alreadyImported) logger.info(`legacy history imported=${imported.imported} skipped=${imported.skipped}`);
    return imported;
  }

  function endSessions() {
    storage.transaction(() => {
      const finish = storage.prepare("UPDATE sessions SET ended_at = ? WHERE id = ?");
      for (const id of sessionIds) finish.run(Date.now(), id);
    });
  }

  return { append, list, importLegacy, endSessions };
}

module.exports = { createHistoryRepository };
