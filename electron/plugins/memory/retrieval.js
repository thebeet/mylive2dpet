const { normalize, indexText } = require("./records");
const STOP = new Set(["用户", "什么", "怎么", "如何", "这个", "那个", "一下", "可以", "我们", "你们", "记得", "之前", "现在", "最近", "今天", "正在", "已经", "是不是", "有没有"]);
const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
function tokenize(input) {
  const result = new Set();
  const value = normalize(input);
  for (const s of segmenter.segment(value)) if (s.isWordLike && !STOP.has(s.segment) && s.segment.length > 1) result.add(s.segment);
  for (const run of value.match(/[\u4e00-\u9fff]+/g) || []) {
    for (let i = 0; i < run.length - 1; i++) {
      const token = run.slice(i, i + 2);
      if (!STOP.has(token)) result.add(token);
    }
  }
  return [...result].slice(0, 256);
}
function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return 0;
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; aa += a[i] ** 2; bb += b[i] ** 2; }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}
function retrieve(entries, query, { now = Date.now(), limit = 8, vector, vectors = new Map(), minSimilarity = 0.45,
  includeArchived = false } = {}) {
  const tokens = tokenize(query);
  if (!tokens.length && !vector) return [];
  const eligible = entries.filter(e => (e.status === "active" || includeArchived) && (includeArchived || e.expiresAt == null || e.expiresAt > now));
  const docs = eligible.map(e => ({ e, tokens: new Set(tokenize(indexText(e))), head: new Set(tokenize([e.title, ...e.topics, ...e.tags, ...e.aliases].join(" "))) }));
  const lexical = docs.map(d => {
    let score = 0;
    for (const token of tokens) {
      if (!d.tokens.has(token)) continue;
      const df = docs.reduce((n, x) => n + Number(x.tokens.has(token)), 0);
      const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
      score += idf * (d.head.has(token) ? 2 : 1) / (0.6 + 0.4 * Math.sqrt(d.tokens.size / 40));
    }
    return { entry: d.e, score };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score);
  const semantic = vector ? eligible.map(entry => ({ entry, score: cosine(vector, vectors.get(entry.id)) }))
    .filter(x => x.score >= minSimilarity).sort((a, b) => b.score - a.score) : [];
  const fused = new Map();
  for (const list of [lexical, semantic]) list.forEach((x, i) => {
    const existing = fused.get(x.entry.id) || { entry: x.entry, score: 0, lexical: 0, semantic: 0 };
    existing.score += 1 / (30 + i);
    existing[list === lexical ? "lexical" : "semantic"] = x.score;
    fused.set(x.entry.id, existing);
  });
  return [...fused.values()].sort((a, b) => b.score - a.score || b.entry.confidence - a.entry.confidence ||
    b.entry.observedAt - a.entry.observedAt).slice(0, limit);
}
function formatEntry(e, now = Date.now()) {
  const basis = { user: "用户陈述", observation: "观察记录", inference: "推断，需确认" }[e.basis];
  return `[${e.id}] ${e.title}${e.topics.length ? ` · ${e.topics.join(" / ")}` : ""}\n` +
    `${basis}；来源时间 ${new Date(e.observedAt).toISOString()}${e.expiresAt != null ? `；有效至 ${new Date(e.expiresAt).toISOString()}` : ""}${e.status !== "active" || e.expiresAt != null && e.expiresAt <= now ? "；历史记录，不代表当前状态" : ""}\n${e.text}`;
}
function budgetEntries(entries, maxChars, now) {
  const selected = [], blocks = [];
  let used = 0;
  for (const e of entries) {
    const formatted = formatEntry(e, now);
    if (used + formatted.length + 2 > maxChars) continue;
    selected.push(e); blocks.push(formatted); used += formatted.length + 2;
  }
  return { entries: selected, text: blocks.join("\n\n") };
}
module.exports = { tokenize, cosine, retrieve, formatEntry, budgetEntries };
