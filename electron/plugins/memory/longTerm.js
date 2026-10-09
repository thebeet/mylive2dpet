/**
 * Durable long-term memory: JSONL on disk + keyword/tag rule retrieval.
 * No embeddings.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function getDefaults() {
  return {
    enabled: true,
    maxInject: 5,
    path: "logs/memory.jsonl",
    extractEveryNTurns: 3,
    maxTokens: 256,
    maxEntries: 500,
  };
}

/**
 * @param {string} relOrAbs
 */
function resolveStorePath(relOrAbs) {
  const p = String(relOrAbs || getDefaults().path);
  if (path.isAbsolute(p)) return p;
  return path.join(__dirname, "../../..", p);
}

/**
 * @param {string} filePath
 */
function ensureParentDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * @param {string} text
 * @returns {string[]}
 */
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

/**
 * @param {string} filePath
 * @returns {object[]}
 */
function loadAll(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  /** @type {object[]} */
  const items = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj.text === "string" && obj.text.trim()) {
        items.push(obj);
      }
    } catch {
      // skip bad lines
    }
  }
  return items;
}

/**
 * @param {object} entry
 * @param {object} [cfg]
 */
function append(entry, cfg = {}) {
  const merged = { ...getDefaults(), ...cfg };
  if (merged.enabled === false) return null;
  const filePath = resolveStorePath(merged.path);
  ensureParentDir(filePath);

  const record = {
    id: entry.id || crypto.randomBytes(8).toString("hex"),
    type: entry.type || "fact",
    text: String(entry.text || "").trim(),
    tags: Array.isArray(entry.tags)
      ? entry.tags.map((t) => String(t).toLowerCase()).filter(Boolean)
      : [],
    importance:
      typeof entry.importance === "number"
        ? Math.min(5, Math.max(1, entry.importance))
        : 2,
    createdAt: entry.createdAt || Date.now(),
  };
  if (!record.text) return null;

  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8");
  maybeCompact(filePath, merged.maxEntries);
  return record;
}

/**
 * Keep file from growing forever: keep newest maxEntries.
 * @param {string} filePath
 * @param {number} maxEntries
 */
function maybeCompact(filePath, maxEntries) {
  const max = Number(maxEntries) > 0 ? Number(maxEntries) : 500;
  const items = loadAll(filePath);
  if (items.length <= max) return;
  const kept = items.slice(-max);
  fs.writeFileSync(
    filePath,
    kept.map((e) => JSON.stringify(e)).join("\n") + "\n",
    "utf8",
  );
}

/**
 * @param {object} item
 * @param {string[]} queryTokens
 */
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

/**
 * @param {string} queryText
 * @param {object} [cfg]
 * @returns {object[]}
 */
function retrieve(queryText, cfg = {}) {
  const merged = { ...getDefaults(), ...cfg };
  if (merged.enabled === false) return [];
  const filePath = resolveStorePath(merged.path);
  const items = loadAll(filePath);
  if (!items.length) return [];

  const tokens = tokenize(queryText);
  const maxInject = Math.max(1, Number(merged.maxInject) || 5);

  if (!tokens.length) {
    // No query signal — return most recent / important.
    return items
      .slice()
      .sort((a, b) => {
        const ia = Number(a.importance) || 0;
        const ib = Number(b.importance) || 0;
        if (ib !== ia) return ib - ia;
        return (b.createdAt || 0) - (a.createdAt || 0);
      })
      .slice(0, maxInject);
  }

  return items
    .map((item) => ({ item, score: scoreItem(item, tokens) }))
    .filter((x) => x.score > 0.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxInject)
    .map((x) => x.item);
}

/**
 * @param {object[]} items
 */
function formatForPrompt(items) {
  if (!items.length) return "";
  return items.map((e) => `- (${e.type || "fact"}) ${e.text}`).join("\n");
}

/**
 * Near-duplicate check before append.
 * @param {string} text
 * @param {object} [cfg]
 */
function isDuplicate(text, cfg = {}) {
  const merged = { ...getDefaults(), ...cfg };
  const filePath = resolveStorePath(merged.path);
  const needle = String(text || "").trim().toLowerCase();
  if (!needle) return true;
  const items = loadAll(filePath);
  return items.some((e) => {
    const t = String(e.text || "").trim().toLowerCase();
    if (!t) return false;
    if (t === needle) return true;
    if (t.includes(needle) || needle.includes(t)) {
      return Math.min(t.length, needle.length) >= 8;
    }
    return false;
  });
}

module.exports = {
  getDefaults,
  resolveStorePath,
  append,
  loadAll,
  retrieve,
  formatForPrompt,
  tokenize,
  isDuplicate,
};
