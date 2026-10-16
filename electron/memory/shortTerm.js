/**
 * In-process short-term dialogue buffer (text only, no images).
 */

/** @typedef {{ t: number, trigger?: string, petSaid: string, expression?: string, screenSummary?: string }} ShortTermTurn */

/** @type {ShortTermTurn[]} */
let turns = [];

function getDefaults() {
  return { enabled: true, maxTurns: 8, ttlMs: 1_800_000 };
}

/**
 * @param {object} [cfg]
 */
function prune(cfg = {}) {
  const { maxTurns, ttlMs } = { ...getDefaults(), ...cfg };
  const now = Date.now();
  turns = turns.filter((e) => now - e.t < ttlMs);
  if (turns.length > maxTurns) {
    turns = turns.slice(-maxTurns);
  }
}

/**
 * @param {Omit<ShortTermTurn, 't'> & { t?: number }} entry
 * @param {object} [cfg]
 */
function append(entry, cfg = {}) {
  const merged = { ...getDefaults(), ...cfg };
  if (merged.enabled === false) return;
  const screenSummary = String(entry.screenSummary || "").trim();
  turns.push({
    t: entry.t || Date.now(),
    trigger: entry.trigger || "",
    petSaid: String(entry.petSaid || "").trim(),
    expression: entry.expression || "neutral",
    ...(screenSummary ? { screenSummary } : {}),
  });
  prune(merged);
}

/**
 * @param {object} [cfg]
 * @returns {ShortTermTurn[]}
 */
function list(cfg = {}) {
  prune(cfg);
  return turns.slice();
}

function clear() {
  turns = [];
}

/**
 * Drop oldest turns that were folded into a summary; keep the newest ones.
 * @param {number} keep
 * @param {object} [cfg]
 */
function retainNewest(keep, cfg = {}) {
  prune(cfg);
  const n = Math.max(0, Number(keep) || 0);
  turns = n > 0 ? turns.slice(-n) : [];
}

/**
 * @param {ShortTermTurn[]} items
 */
function formatForPrompt(items) {
  if (!items.length) return "";
  return items
    .map((e) => {
      const d = new Date(e.t);
      const hh = String(d.getHours()).padStart(2, "0");
      const mm = String(d.getMinutes()).padStart(2, "0");
      const expr = e.expression ? ` (${e.expression})` : "";
      const line = `[${hh}:${mm}]${expr} ${e.petSaid}`;
      const summary = String(e.screenSummary || "").trim();
      return summary ? `${line}\n  画面：${summary}` : line;
    })
    .join("\n");
}

module.exports = {
  getDefaults,
  append,
  list,
  clear,
  prune,
  retainNewest,
  formatForPrompt,
};
