const { randomUUID } = require("crypto");
const { tokenize } = require("./longTerm");

const KINDS = new Set(["user", "person", "project", "team"]);
const FIELDS = new Set(["identity", "organization_role", "project_role", "responsibility", "team", "collaboration", "task", "preference", "communication"]);
const clean = (value, max = 300) => typeof value === "string" ? value.trim().slice(0, max) : "";
const keyFor = ({ kind, name }) => kind === "user" ? "user:self" : `${kind}:${name.toLowerCase()}`;
function subjectOf(input) {
  if (!input || !KINDS.has(input.kind)) throw new Error("工作记忆人物或项目类型无效");
  const name = input.kind === "user" ? "用户" : clean(input.name, 80);
  if (!name) throw new Error("工作记忆名称不能为空");
  return { kind: input.kind, name };
}
function decodeQuestion(row) {
  return { id: row.id, subject: JSON.parse(row.subject_json), field: row.field, scope: row.scope,
    prompt: row.prompt, options: JSON.parse(row.options_json), reason: row.reason,
    priority: row.priority, status: row.status, skips: row.skips, nextAt: row.next_at,
    createdAt: row.created_at, lastShownAt: row.last_shown_at };
}

/** Evidence and profile revisions share the same database as ordinary memory. */
function createWorkStore(storage, { now = Date.now } = {}) {
  storage.migrate("work-memory", [(db) => db.exec(`
    CREATE TABLE work_evidence (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      source TEXT NOT NULL, captured_at INTEGER NOT NULL, text TEXT NOT NULL,
      metadata_json TEXT NOT NULL, processed INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX work_evidence_pending ON work_evidence(processed, sequence);
    CREATE TABLE work_entities (
      id TEXT PRIMARY KEY, entity_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL,
      name TEXT NOT NULL, aliases_json TEXT NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE work_claims (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      entity_id TEXT NOT NULL REFERENCES work_entities(id), field TEXT NOT NULL,
      scope TEXT NOT NULL, value TEXT NOT NULL, basis TEXT NOT NULL,
      confidence REAL NOT NULL, evidence_ids_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active', updated_at INTEGER NOT NULL
    );
    CREATE INDEX work_claims_slot ON work_claims(entity_id, field, scope, status);
    CREATE TABLE work_questions (
      id TEXT PRIMARY KEY, question_key TEXT NOT NULL UNIQUE, subject_json TEXT NOT NULL,
      field TEXT NOT NULL, scope TEXT NOT NULL, prompt TEXT NOT NULL,
      options_json TEXT NOT NULL, reason TEXT NOT NULL, priority REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', skips INTEGER NOT NULL DEFAULT 0,
      next_at INTEGER NOT NULL, created_at INTEGER NOT NULL, last_shown_at INTEGER
    );
    CREATE TABLE work_question_answers (
      id TEXT PRIMARY KEY, question_id TEXT NOT NULL, value TEXT NOT NULL,
      outcome TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE work_memory_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `)]);

  function getState(key, fallback = null) {
    const row = storage.prepare("SELECT value FROM work_memory_state WHERE key = ?").get(key);
    return row ? JSON.parse(row.value) : fallback;
  }
  function setState(key, value) {
    storage.prepare("INSERT INTO work_memory_state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, JSON.stringify(value));
  }
  function addEvidence({ id = randomUUID(), source, capturedAt = now(), text, metadata = {} }) {
    const body = clean(text, 6000);
    if (!body) return null;
    const stamp = typeof capturedAt === "string" ? Date.parse(capturedAt) : Number(capturedAt);
    const t = Number.isFinite(stamp) ? stamp : now();
    // Overlapping screenshots and repeated transcripts are one piece of evidence.
    const duplicate = storage.prepare("SELECT id FROM work_evidence WHERE source = ? AND text = ? AND captured_at >= ? ORDER BY sequence DESC LIMIT 1")
      .get(source, body, t - 300000);
    if (duplicate) return duplicate.id;
    storage.prepare("INSERT OR IGNORE INTO work_evidence(id, source, captured_at, text, metadata_json) VALUES (?, ?, ?, ?, ?)")
      .run(id, source, t, body, JSON.stringify(metadata));
    return id;
  }
  function pending(limit = 16) {
    return storage.prepare("SELECT * FROM work_evidence WHERE processed = 0 ORDER BY sequence LIMIT ?").all(limit)
      .map((r) => ({ id: r.id, source: r.source, capturedAt: r.captured_at, text: r.text, metadata: JSON.parse(r.metadata_json) }));
  }
  function upsertEntity(input) {
    const subject = subjectOf(input);
    const entityKey = keyFor(subject);
    const old = storage.prepare("SELECT * FROM work_entities WHERE entity_key = ?").get(entityKey);
    const aliases = [...new Set([...(old ? JSON.parse(old.aliases_json) : []), ...(Array.isArray(input.aliases) ? input.aliases.map((s) => clean(s, 80)).filter(Boolean) : [])])].slice(0, 12);
    const id = old?.id || randomUUID();
    storage.prepare(`INSERT INTO work_entities(id, entity_key, kind, name, aliases_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(entity_key) DO UPDATE SET aliases_json = excluded.aliases_json, updated_at = excluded.updated_at`)
      .run(id, entityKey, subject.kind, subject.name, JSON.stringify(aliases), now());
    return id;
  }
  function currentClaim(subject, field, scope) {
    return storage.prepare(`SELECT c.* FROM work_claims c JOIN work_entities e ON e.id = c.entity_id
      WHERE e.entity_key = ? AND c.field = ? AND c.scope = ? AND c.status = 'active' ORDER BY c.sequence DESC LIMIT 1`)
      .get(keyFor(subjectOf(subject)), field, scope);
  }
  function addClaim(input, { userAnswer = false, evidenceIds = [] } = {}) {
    const subject = subjectOf(input.subject);
    if (!FIELDS.has(input.field)) throw new Error("工作记忆字段无效");
    const scope = clean(input.scope, 120), value = clean(input.value, 600);
    if (!value) throw new Error("工作记忆内容不能为空");
    const basis = userAnswer ? "user_answer" : input.basis === "observation" ? "observation" : "inference";
    const confidence = userAnswer ? 1 : Math.max(0.05, Math.min(basis === "inference" ? 0.85 : 0.95, Number(input.confidence) || 0.5));
    const entityId = upsertEntity(subject);
    const old = currentClaim(subject, input.field, scope);
    // An automatic guess never overrides an explicit user answer in the same scope.
    if (old && !userAnswer && (old.basis === "user_answer" || (old.basis === "observation" && basis === "inference"))) return old.id;
    if (old?.value === value && old.basis === basis) {
      const ids = [...new Set([...JSON.parse(old.evidence_ids_json), ...evidenceIds])].slice(-40);
      storage.prepare("UPDATE work_claims SET confidence = ?, evidence_ids_json = ?, updated_at = ? WHERE id = ?")
        .run(confidence, JSON.stringify(ids), now(), old.id);
      return old.id;
    }
    storage.prepare("UPDATE work_claims SET status = 'superseded' WHERE entity_id = ? AND field = ? AND scope = ? AND status = 'active'")
      .run(entityId, input.field, scope);
    const id = randomUUID();
    storage.prepare(`INSERT INTO work_claims(id, entity_id, field, scope, value, basis, confidence, evidence_ids_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, entityId, input.field, scope, value, basis, confidence, JSON.stringify(evidenceIds), now());
    return id;
  }
  function enqueueQuestion(input, maxPending = 30) {
    const subject = subjectOf(input.subject);
    const scope = clean(input.scope, 120), prompt = clean(input.prompt, 240);
    if (!FIELDS.has(input.field) || !prompt) throw new Error("提问字段或问题无效");
    const options = Array.isArray(input.options) ? input.options.slice(0, 4).map((o) => ({ label: clean(o.label, 80), value: clean(o.value, 600) })) : [];
    if (options.length < 2 || options.some((o) => !o.label || !o.value) || new Set(options.map((o) => o.label)).size !== options.length) throw new Error("提问需要 2～4 个不同选项");
    if (currentClaim(subject, input.field, scope)?.basis === "user_answer") return null;
    const questionKey = `${keyFor(subject)}|${input.field}|${scope}`;
    const old = storage.prepare("SELECT id FROM work_questions WHERE question_key = ?").get(questionKey);
    if (old) return old.id;
    storage.prepare("UPDATE work_questions SET status = 'dismissed' WHERE status = 'pending' AND created_at < ?").run(now() - 604800000);
    if (storage.prepare("SELECT COUNT(*) AS count FROM work_questions WHERE status = 'pending'").get().count >= maxPending) return null;
    const id = randomUUID();
    storage.prepare(`INSERT INTO work_questions(id, question_key, subject_json, field, scope, prompt, options_json, reason, priority, next_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, questionKey, JSON.stringify(subject), input.field, scope, prompt, JSON.stringify(options), clean(input.reason, 200),
      Math.max(0, Math.min(10, Number(input.priority) || 5)), now(), now());
    return id;
  }
  function applyExtraction(result, evidence, config = {}) {
    const allowed = new Set(evidence.map((e) => e.id));
    return storage.transaction(() => {
      for (const entity of result.entities) upsertEntity(entity);
      for (const claim of result.claims) {
        const ids = (claim.evidenceIds || []).filter((id) => allowed.has(id));
        if (!ids.length) throw new Error("工作记忆缺少本批来源证据");
        addClaim(claim, { evidenceIds: ids });
      }
      for (const question of result.questions) enqueueQuestion(question, config.maxQuestions);
      for (const e of evidence) storage.prepare("UPDATE work_evidence SET processed = 1 WHERE id = ?").run(e.id);
      storage.prepare(`DELETE FROM work_evidence WHERE processed = 1 AND sequence NOT IN
        (SELECT sequence FROM work_evidence ORDER BY sequence DESC LIMIT ?) AND NOT EXISTS
        (SELECT 1 FROM work_claims c, json_each(c.evidence_ids_json) e WHERE e.value = work_evidence.id)`)
        .run(config.maxEvidence || 2000);
    });
  }
  function profiles({ includeHistory = false } = {}) {
    const rows = storage.prepare(`SELECT c.*, e.name, e.kind, e.aliases_json FROM work_claims c
      JOIN work_entities e ON e.id = c.entity_id ${includeHistory ? "" : "WHERE c.status = 'active'"} ORDER BY c.updated_at DESC, c.sequence DESC`).all();
    return rows.map((r) => ({ id: r.id, entityId: r.entity_id, subject: { kind: r.kind, name: r.name }, aliases: JSON.parse(r.aliases_json),
      field: r.field, scope: r.scope, value: r.value, basis: r.basis, confidence: r.confidence,
      evidenceIds: JSON.parse(r.evidence_ids_json), status: r.status, updatedAt: r.updated_at }));
  }
  function questions() { return storage.prepare("SELECT * FROM work_questions ORDER BY priority DESC, created_at").all().map(decodeQuestion); }
  function nextQuestion({ manual = false, cooldownMs = 0, dailyLimit = 0, maxAgeMs = 604800000 } = {}) {
    const t = now();
    if (!manual) {
      const since = getState("lastQuestionAt");
      if (cooldownMs > 0 && since != null && t - since < cooldownMs) return null;
      const start = new Date(t); start.setHours(0, 0, 0, 0);
      const count = getState("questionDaily", { day: start.getTime(), count: 0 });
      if (dailyLimit > 0 && count.day === start.getTime() && count.count >= dailyLimit) return null;
    }
    return questions().find((q) => q.status === "pending" && q.nextAt <= t && (manual || t - q.createdAt <= maxAgeMs)) || null;
  }
  function markShown(id) {
    const q = getQuestion(id);
    if (q.status !== "pending") throw new Error("问题已处理");
    const t = now(), start = new Date(t); start.setHours(0, 0, 0, 0);
    const previous = getState("questionDaily", { day: start.getTime(), count: 0 });
    storage.transaction(() => {
      setState("lastQuestionAt", t);
      setState("questionDaily", { day: start.getTime(), count: previous.day === start.getTime() ? previous.count + 1 : 1 });
      storage.prepare("UPDATE work_questions SET last_shown_at = ? WHERE id = ?").run(t, id);
      storage.prepare("INSERT INTO work_question_answers(id, question_id, value, outcome, created_at) VALUES (?, ?, '', 'shown', ?)")
        .run(randomUUID(), id, t);
    });
  }
  function getQuestion(id) {
    const row = storage.prepare("SELECT * FROM work_questions WHERE id = ?").get(id);
    if (!row) throw new Error("问题不存在或已清空");
    return decodeQuestion(row);
  }
  function questionHistory() {
    const grouped = new Map();
    for (const row of storage.prepare("SELECT * FROM work_question_answers ORDER BY created_at, rowid").all()) {
      const records = grouped.get(row.question_id) || [];
      records.push({ id: row.id, value: row.value, action: row.outcome, createdAt: row.created_at });
      grouped.set(row.question_id, records);
    }
    return questions().map((q) => ({ ...q, records: grouped.get(q.id) || [] }))
      .filter((q) => q.lastShownAt != null || q.records.length)
      .sort((a, b) => Math.max(b.lastShownAt || 0, b.records.at(-1)?.createdAt || 0) - Math.max(a.lastShownAt || 0, a.records.at(-1)?.createdAt || 0));
  }
  function answer(id, { action, optionIndex, text }, { deferMs = 1800000, maxSkips = 3 } = {}) {
    const q = getQuestion(id);
    if (q.status !== "pending") throw new Error("问题已经处理");
    if (!["answer", "unknown", "skip", "defer"].includes(action)) throw new Error("无效的回答操作");
    const custom = clean(text, 600);
    const selected = Number.isInteger(optionIndex) ? q.options[optionIndex] : null;
    const value = action === "answer" ? custom || selected?.value : "";
    if (action === "answer" && !value) throw new Error("请选择答案或补充内容");
    return storage.transaction(() => {
      if (action === "answer") {
        const evidenceId = addEvidence({ source: "user-answer", text: `${q.prompt}\n用户回答：${value}`, metadata: { questionId: id } });
        addClaim({ subject: q.subject, field: q.field, scope: q.scope, value }, { userAnswer: true, evidenceIds: [evidenceId] });
        storage.prepare("UPDATE work_evidence SET processed = 1 WHERE id = ?").run(evidenceId);
        storage.prepare("UPDATE work_questions SET status = 'answered' WHERE id = ?").run(id);
      } else {
        const skips = q.skips + (action === "defer" ? 0 : 1);
        storage.prepare("UPDATE work_questions SET skips = ?, status = ?, next_at = ? WHERE id = ?")
          .run(skips, skips >= maxSkips ? "dismissed" : "pending", now() + deferMs * Math.pow(2, skips), id);
      }
      storage.prepare("INSERT INTO work_question_answers(id, question_id, value, outcome, created_at) VALUES (?, ?, ?, ?, ?)")
        .run(randomUUID(), id, value || "", action, now());
      return { ok: true, question: q.prompt, value: value || "", action };
    });
  }
  function context(query, { maxClaims = 20, maxContextChars = 8000 } = {}) {
    const tokens = tokenize(query);
    const ranked = profiles().map((p) => {
      const body = `${p.subject.name} ${p.aliases.join(" ")} ${p.scope} ${p.value}`.toLowerCase();
      const matches = tokens.filter((t) => body.includes(t)).length;
      return { p, score: matches * 3 + p.confidence + (p.basis === "user_answer" ? 1 : 0), matches };
    }).filter(({ p, matches }) => p.subject.kind === "user" || !tokens.length || matches > 0)
      .sort((a, b) => b.score - a.score).slice(0, maxClaims);
    return ranked.map(({ p }) => `- ${p.subject.name}${p.scope ? `【${p.scope}】` : ""} ${p.field}：${p.value}（${p.basis === "user_answer" ? "用户回答" : p.basis === "observation" ? "观察记录" : "暂时猜测"}；${new Date(p.updatedAt).toLocaleDateString("zh-CN")}）`)
      .join("\n").slice(0, maxContextChars);
  }
  function correctProfile(id, text) {
    const value = clean(text, 600);
    if (!value || typeof text !== "string" || text.length > 600) throw new Error("修正内容需要 1～600 个字符");
    const profile = profiles().find((p) => p.id === id);
    if (!profile) throw new Error("画像已更新，请刷新后重试");
    return storage.transaction(() => {
      const evidenceId = addEvidence({ source: "user-correction", text: `${profile.subject.name}【${profile.scope}】${profile.field}：${value}`, metadata: { correctedClaimId: id } });
      addClaim({ subject: profile.subject, field: profile.field, scope: profile.scope, value }, { userAnswer: true, evidenceIds: [evidenceId] });
      storage.prepare("UPDATE work_evidence SET processed = 1 WHERE id = ?").run(evidenceId);
      storage.prepare("UPDATE work_questions SET status = 'dismissed' WHERE question_key = ? AND status = 'pending'")
        .run(`${keyFor(profile.subject)}|${profile.field}|${profile.scope}`);
      return { ok: true };
    });
  }
  function snapshot() {
    const evidenceFor = (id) => {
      const row = storage.prepare("SELECT source, captured_at, text FROM work_evidence WHERE id = ?").get(id);
      return row ? { source: row.source, capturedAt: row.captured_at, text: row.text.slice(0, 400) } : null;
    };
    return { profiles: profiles().map((p) => ({ ...p, evidence: p.evidenceIds.slice(-3).map(evidenceFor).filter(Boolean) })),
      questions: questions(), questionHistory: questionHistory(), pending: storage.prepare("SELECT COUNT(*) AS count FROM work_evidence WHERE processed = 0").get().count,
      recentEvidence: storage.prepare("SELECT * FROM work_evidence ORDER BY sequence DESC LIMIT 30").all()
        .map((r) => ({ id: r.id, source: r.source, capturedAt: r.captured_at, text: r.text, metadata: JSON.parse(r.metadata_json), processed: Boolean(r.processed) })) };
  }
  function clear() {
    storage.transaction(() => {
      for (const table of ["work_claims", "work_entities", "work_questions", "work_question_answers", "work_evidence", "work_memory_state"]) storage.exec(`DELETE FROM ${table}`);
    });
  }
  return { addEvidence, pending, applyExtraction, profiles, context, snapshot, clear,
    nextQuestion, getQuestion, markShown, answer, correctProfile, getState, setState };
}

module.exports = { createWorkStore, subjectOf, FIELDS };
