const { normalizeUsage, responseUsage, sumUsage } = require("../../rawLog/usage");
const usageSql = `CASE WHEN json_type(response_json) = 'text' AND json_valid(json_extract(response_json, '$'))
  THEN json_extract(json_extract(response_json, '$'), '$.usage')
  ELSE json_extract(response_json, '$.usage') END`;
const groupSql = `CASE WHEN conversation_id IS NULL THEN 'request:' || id ELSE 'conversation:' || conversation_id END`;

function groupFilter(id) {
  if (typeof id !== "string" || id.length > 210) throw new Error("无效的对话会话 ID");
  if (id.startsWith("conversation:") && id.length > 13) return { where: "conversation_id = ?", value: id.slice(13) };
  if (id.startsWith("request:") && id.length > 8) return { where: "id = ? AND conversation_id IS NULL", value: id.slice(8) };
  throw new Error("无效的对话会话 ID");
}

function createRawLogRepository(storage) {
  storage.migrate("raw-log", [(db) => db.exec(`
    CREATE TABLE ai_requests (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL, created_at INTEGER NOT NULL,
      label TEXT NOT NULL, model TEXT NOT NULL, request_json TEXT NOT NULL,
      finished_at INTEGER, status INTEGER, response_json TEXT, error TEXT NOT NULL DEFAULT ''
    );
  `), db => db.exec(`
    ALTER TABLE ai_requests ADD COLUMN conversation_id TEXT;
    ALTER TABLE ai_requests ADD COLUMN conversation_json TEXT;
    CREATE INDEX ai_requests_conversation ON ai_requests(conversation_id, sequence);
  `)]);
  // An unfinished request from a previous process cannot resume.
  storage.prepare("UPDATE ai_requests SET finished_at = created_at, error = '应用退出，请求结果未记录' WHERE finished_at IS NULL").run();
  const insert = storage.prepare(`INSERT INTO ai_requests
    (id, session_id, created_at, label, model, request_json, conversation_id, conversation_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const finish = storage.prepare(`UPDATE ai_requests SET finished_at = ?, status = ?, response_json = ?, error = ? WHERE id = ?`);

  return {
    clear() { return storage.prepare("DELETE FROM ai_requests").run().changes; },
    // Bounded batches and per-row transactions keep migration restartable and atomic with blob writes.
    rewriteRequests(transform) {
      let cursor = 0;
      const update = storage.prepare("UPDATE ai_requests SET request_json = ? WHERE sequence = ?");
      while (true) {
        const rows = storage.prepare(`SELECT sequence, request_json FROM ai_requests
          WHERE sequence > ? AND instr(request_json, 'data:image/') > 0 ORDER BY sequence LIMIT 25`).all(cursor);
        if (!rows.length) break;
        for (const row of rows) {
          storage.transaction(() => update.run(JSON.stringify(transform(JSON.parse(row.request_json))), row.sequence));
          cursor = row.sequence;
        }
      }
    },
    append(entry) {
      const conversation = entry.conversation;
      if (conversation && (typeof conversation.id !== "string" || !conversation.id || conversation.id.length > 100 ||
        !["turn", "summary"].includes(conversation.kind))) throw new Error("无效的请求会话信息");
      insert.run(entry.id, entry.sessionId, entry.t, entry.label,
        String(entry.request.model || ""), JSON.stringify(entry.request),
        conversation?.id ?? null, conversation ? JSON.stringify(conversation) : null);
    },
    finish(entry) {
      finish.run(entry.finishedAt, entry.status ?? null, JSON.stringify(entry.response ?? null), entry.error || "", entry.id);
    },
    listGroups({ before = null, limit = 50 } = {}) {
      if (before !== null && (!Number.isSafeInteger(before) || before <= 0)) throw new Error("无效的分页游标");
      const size = Math.max(1, Math.min(100, Math.floor(Number(limit) || 50)));
      const rows = storage.prepare(`SELECT ${groupSql} AS id, MIN(sequence) AS sequence,
        MAX(sequence) AS revision, MIN(created_at) AS t, MAX(COALESCE(finished_at, created_at)) AS updatedAt,
        MAX(session_id) AS sessionId, MAX(model) AS model,
        CASE WHEN conversation_id IS NULL THEN MAX(label) ELSE 'ai:vision' END AS label,
        COUNT(*) AS requestCount, COUNT(DISTINCT json_extract(conversation_json, '$.turnId')) AS turnCount,
        SUM(CASE WHEN json_extract(conversation_json, '$.kind') = 'summary' THEN 1 ELSE 0 END) AS summaryCount,
        SUM(CASE WHEN finished_at IS NULL THEN 1 ELSE 0 END) AS pendingCount,
        SUM(CASE WHEN error != '' THEN 1 ELSE 0 END) AS errorCount
        FROM ai_requests GROUP BY ${groupSql} ${before === null ? "" : "HAVING MIN(sequence) < ?"}
        ORDER BY sequence DESC LIMIT ?`).all(...(before === null ? [] : [before]), size + 1);
      const entries = rows.slice(0, size).map(row => {
        const { where, value } = groupFilter(row.id);
        const usages = storage.prepare(`SELECT ${usageSql} AS usageJson FROM ai_requests WHERE ${where}`).all(value)
          .map(item => normalizeUsage(item.usageJson));
        return { ...row, usage: sumUsage(usages), usageComplete: usages.every(Boolean),
          finishedAt: row.pendingCount ? null : row.updatedAt };
      });
      return { entries, nextCursor: rows.length > size ? rows[size - 1].sequence : null };
    },
    getGroup(id) {
      const { where, value } = groupFilter(id);
      const rows = storage.prepare(`SELECT sequence, id, created_at AS t, label, model,
        finished_at AS finishedAt, status, error, conversation_json, request_json, response_json
        FROM ai_requests WHERE ${where} ORDER BY sequence`).all(value);
      if (!rows.length) throw new Error("对话会话不存在");
      return rows.map(({ conversation_json, request_json, response_json, ...row }) => {
        const response = response_json === null ? null : JSON.parse(response_json);
        return { ...row, conversation: conversation_json ? JSON.parse(conversation_json) : null,
          request: JSON.parse(request_json), response, usage: responseUsage(response) };
      });
    },
    list({ before = null, limit = 50 } = {}) {
      if (before !== null && (!Number.isSafeInteger(before) || before <= 0)) throw new Error("无效的分页游标");
      const size = Math.max(1, Math.min(100, Math.floor(Number(limit) || 50)));
      const rows = storage.prepare(`SELECT sequence, id, session_id AS sessionId, created_at AS t,
        label, model, finished_at AS finishedAt, status, error,
        ${usageSql} AS usageJson FROM ai_requests
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
