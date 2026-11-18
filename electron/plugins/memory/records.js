const { createHash } = require("node:crypto");

// Only reliability metadata has a vocabulary. Topics, tags and relationships are model-owned.
const BASES = new Set(["user", "observation", "inference"]);
const normalize = value => String(value || "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
const fingerprint = text => createHash("sha256").update(normalize(text)).digest("hex");
const indexText = entry => [entry.title, entry.text, ...(entry.topics || []), ...(entry.tags || []), ...(entry.aliases || [])].join("\n");
const contentHash = entry => fingerprint(indexText(entry));
function timestamp(value, fallback) {
  const result = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(result) && result >= 0 && result <= 8640000000000000 ? result : fallback;
}
function text(value, max, label, empty = false) {
  if (typeof value !== "string" || (!empty && !value.trim()) || value.length > max) throw new Error(`记忆${label}无效`);
  return value.trim();
}
function strings(value, max, length, label) {
  if (!Array.isArray(value) || value.length > max) throw new Error(`记忆${label}无效`);
  return [...new Set(value.map(v => text(v, length, label)))];
}
function evidence(input, sources) {
  if (!Array.isArray(input) || !input.length || input.length > 32) throw new Error("记忆必须引用有效来源");
  return input.map(ref => {
    const source = sources.get(ref?.sourceId);
    const quote = text(ref?.quote, 2000, "来源摘录");
    if (!source || source.forgotten || !source.text.includes(quote)) throw new Error("记忆来源摘录必须逐字来自原文");
    return { sourceId: source.id, quote };
  });
}

function validatePlan(input, snapshot, { organize = false } = {}) {
  if (!input || !Array.isArray(input.upsert) || !Array.isArray(input.archive) || !Array.isArray(input.forget) ||
      Object.keys(input).some(k => !["upsert", "archive", "forget", "discard", "questions"].includes(k)) ||
      input.upsert.length + input.archive.length + input.forget.length > 128) throw new Error("记忆维护返回结构无效");
  const known = new Map(snapshot.entries.map(e => [e.id, e]));
  const sources = new Map(snapshot.sources.map(s => [s.id, s]));
  const pending = new Set(snapshot.pending.map(s => s.id));
  const used = new Set();
  function target(id) {
    if (typeof id !== "string" || !known.has(id) || used.has(id)) throw new Error("记忆维护引用未知或重复记录");
    used.add(id);
    return known.get(id);
  }
  function refs(value, requireNew = !organize) {
    const result = evidence(value, sources);
    if (requireNew && !result.some(r => pending.has(r.sourceId))) throw new Error("自动维护必须引用本批新来源");
    return result;
  }
  const upsert = input.upsert.map(item => {
    if (!item || Object.keys(item).some(k => !["id", "title", "text", "topics", "tags", "aliases", "links", "basis", "confidence", "importance", "pinned", "expiresAt", "evidence"].includes(k))) throw new Error("记忆字段无效");
    const old = item.id == null ? null : target(item.id);
    const cited = refs(item.evidence);
    const direct = cited.filter(r => sources.get(r.sourceId).role === "user" || sources.get(r.sourceId).metadata?.importedBasis === "user");
    const newDirect = direct.some(r => pending.has(r.sourceId));
    if (!BASES.has(item.basis) || !Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1 ||
        !Number.isFinite(item.importance) || item.importance < 1 || item.importance > 5 || typeof item.pinned !== "boolean") throw new Error("记忆可信度或常驻设置无效");
    if (item.basis === "user" && !direct.length) throw new Error("观察和助手推断不能升级为用户确认");
    if (old?.protected && !newDirect && normalize(item.text) !== normalize(old.text)) throw new Error("自动整理不能改写用户手动修正的内容");
    if (old?.basis === "user" && !newDirect && (item.basis !== "user" || normalize(item.text) !== normalize(old.text))) throw new Error("观察或整理不能覆盖用户确认的事实");
    const expiresAt = item.expiresAt;
    if (expiresAt !== null && (!Number.isSafeInteger(expiresAt) || expiresAt < 0 || expiresAt > 8640000000000000)) throw new Error("记忆有效期无效");
    if (old?.protected && !newDirect && (expiresAt !== old.expiresAt || item.pinned !== old.pinned)) throw new Error("自动整理不能改变手动修正的有效期或常驻设置");
    if (!Array.isArray(item.links) || item.links.length > 16) throw new Error("记忆关联无效");
    const links = item.links.map(link => {
      if (!known.has(link?.id) || link.id === old?.id) throw new Error("记忆关联引用未知记录");
      return { id: link.id, relation: text(link.relation, 100, "关联名称") };
    });
    const observedAt = Math.max(...cited.map(r => sources.get(r.sourceId).capturedAt));
    if (old && !organize && observedAt < old.observedAt) throw new Error("旧来源不能覆盖较新的记忆");
    return { id: old?.id || null, title: text(item.title, 120, "标题"), text: text(item.text, 4000, "正文"),
      topics: strings(item.topics, 8, 100, "主题"), tags: strings(item.tags, 16, 80, "标签"),
      aliases: strings(item.aliases, 16, 120, "检索表达"), links, basis: item.basis,
      confidence: item.confidence, importance: item.importance, pinned: item.pinned, expiresAt, evidence: cited,
      observedAt, protected: Boolean(old?.protected), reason: organize ? "模型整理" : "增量记忆更新" };
  });
  const archive = input.archive.map(item => {
    const old = target(item?.id), cited = refs(item.evidence);
    const newDirect = cited.some(r => pending.has(r.sourceId) && sources.get(r.sourceId).role === "user");
    if ((old.protected || old.basis === "user") && !newDirect) throw new Error("没有用户新来源时不能归档已确认记忆");
    return { id: old.id, reason: text(item.reason, 500, "归档原因"), evidence: cited };
  });
  const forget = input.forget.map(item => {
    const old = target(item?.id), cited = refs(item.evidence, true);
    if (!cited.some(r => pending.has(r.sourceId) && sources.get(r.sourceId).role === "user")) throw new Error("忘记操作必须有本批用户请求来源");
    return { id: old.id, reason: text(item.reason, 500, "删除原因"), evidence: cited };
  });
  const questions = input.questions || [];
  if (!Array.isArray(questions) || questions.length > 3) throw new Error("记忆提问无效");
  const discard = input.discard || [];
  if (!Array.isArray(discard) || discard.length > 32) throw new Error("丢弃来源操作无效");
  const discarded = discard.map(item => {
    if (!sources.has(item?.sourceId)) throw new Error("丢弃来源引用未知记录");
    const cited = refs(item.evidence, true);
    if (!cited.some(r => pending.has(r.sourceId) && sources.get(r.sourceId).role === "user")) throw new Error("丢弃来源必须有本批用户请求");
    return { sourceId: item.sourceId, reason: text(item.reason, 500, "丢弃原因"), evidence: cited };
  });
  return { upsert, archive, forget, discard: discarded, questions: questions.map(q => ({
    prompt: text(q.prompt, 400, "提问"), reason: text(q.reason, 400, "提问原因"),
    topic: text(q.topic, 100, "提问主题"), evidence: refs(q.evidence),
    options: (Array.isArray(q.options) && q.options.length >= 2 && q.options.length <= 4 ? q.options : (() => { throw new Error("提问选项无效"); })())
      .map(o => ({ label: text(o.label, 100, "选项"), value: text(o.value, 300, "选项值") })),
  })) };
}
module.exports = { normalize, fingerprint, indexText, contentHash, timestamp, validatePlan };
