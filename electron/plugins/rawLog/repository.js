const { normalizeUsage, responseUsage } = require("./usage");

function createRawLogRepository(storage) {
  storage.migrate("raw-log", [(db) => db.exec(`
    CREATE TABLE ai_requests (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL, created_at INTEGER NOT NULL,
      label TEXT NOT NULL, model TEXT NOT NULL, request_json TEXT NOT NULL,
      finished_at INTEGER, status INTEGER, response_json TEXT, error TEXT NOT NULL DEFAULT ''
    );
  `)]);
  // An unfinished request from a previous process cannot resume.
  storage.prepare("UPDATE ai_requests SET finished_at = created_at, error = '应用退出，请求结果未记录' WHERE finished_at IS NULL").run();
  const insert = storage.prepare(`INSERT INTO ai_requests
    (id, session_id, created_at, label, model, request_json) VALUES (?, ?, ?, ?, ?, ?)`);
  const finish = storage.prepare(`UPDATE ai_requests SET finished_at = ?, status = ?, response_json = ?, error = ? WHERE id = ?`);

  return {
    append(entry) {
      insert.run(entry.id, entry.sessionId, entry.t, entry.label,
        String(entry.request.model || ""), JSON.stringify(entry.request));
    },
    finish(entry) {
      finish.run(entry.finishedAt, entry.status ?? null, JSON.stringify(entry.response ?? null), entry.error || "", entry.id);
    },
    list({ before = null, limit = 50 } = {}) {
      if (before !== null && (!Number.isSafeInteger(before) || before <= 0)) throw new Error("无效的分页游标");
      const size = Math.max(1, Math.min(100, Math.floor(Number(limit) || 50)));
      const rows = storage.prepare(`SELECT sequence, id, session_id AS sessionId, created_at AS t,
        label, model, finished_at AS finishedAt, status, error,
        CASE WHEN json_type(response_json) = 'text' AND json_valid(json_extract(response_json, '$'))
          THEN json_extract(json_extract(response_json, '$'), '$.usage')
          ELSE json_extract(response_json, '$.usage') END AS usageJson FROM ai_requests
        ${before === null ? "" : "WHERE sequence < ?"} ORDER BY sequence DESC LIMIT ?`)
        .all(...(before === null ? [] : [before]), size + 1);
      return { entries: rows.slice(0, size).map(({ usageJson, ...row }) => ({ ...row,
        usage: normalizeUsage(usageJson) })),
        nextCursor: rows.length > size ? rows[size - 1].sequence : null };
    },
    get(id) {
      if (typeof id !== "string" || id.length > 100) throw new Error("无效的请求 ID");
      const row = storage.prepare("SELECT request_json, response_json FROM ai_requests WHERE id = ?").get(id);
      if (!row) throw new Error("请求日志不存在");
      const response = row.response_json === null ? null : JSON.parse(row.response_json);
      return { request: JSON.parse(row.request_json), response, usage: responseUsage(response) };
    },
  };
}

module.exports = { createRawLogRepository };
