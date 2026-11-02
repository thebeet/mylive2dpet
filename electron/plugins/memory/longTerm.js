
function getDefaults() {
  return { enabled: true, maxInject: 5,
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

/** Inspect existing memory without initializing a repository. */
function listEntries(storage) {
  return storage.hasRepository("memory") ? storage.repository("memory").list() : [];
}
function createLongTermStore(storage) { return storage.repository("memory"); }
module.exports = { getDefaults, tokenize, scoreItem, formatForPrompt, listEntries, createLongTermStore };
