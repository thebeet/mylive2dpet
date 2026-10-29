const { getPlugin } = require("../registry");
const shortTerm = require("./shortTerm");
const longTerm = require("./longTerm");

const integer = (value, fallback, minimum = 1) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(minimum, Math.floor(number)) : fallback;
};

function getOptions(config = {}) {
  const plugin = getPlugin(config, "memory");
  const short = { ...shortTerm.getDefaults(), ...plugin?.shortTerm };
  const long = { ...longTerm.getDefaults(), ...plugin?.longTerm };
  const work = { enabled: false, extractEveryNObservations: 3, flushAfterMs: 120000,
    batchSize: 16, maxTokens: 1800, maxEvidence: 2000, maxQuestions: 30,
    maxClaims: 20, maxContextChars: 8000, ...plugin?.work };
  work.enabled = work.enabled === true;
  for (const [key, fallback] of Object.entries({ extractEveryNObservations: 3, flushAfterMs: 120000,
    batchSize: 16, maxTokens: 1800, maxEvidence: 2000, maxQuestions: 30, maxClaims: 20, maxContextChars: 8000 })) {
    work[key] = integer(work[key], fallback);
  }
  work.batchSize = Math.min(32, work.batchSize);

  short.enabled = short.enabled !== false;
  short.maxTurns = integer(short.maxTurns, 8);
  short.ttlMs = integer(short.ttlMs, 1_800_000);
  long.enabled = long.enabled !== false;
  long.legacyPath = String(long.legacyPath).trim() || longTerm.getDefaults().legacyPath;
  long.maxInject = integer(long.maxInject, 5);
  long.extractEveryNTurns = integer(long.extractEveryNTurns, longTerm.getDefaults().extractEveryNTurns);
  long.maxTokens = integer(long.maxTokens, longTerm.getDefaults().maxTokens);
  long.maxEntries = integer(long.maxEntries, 500);

  const practice = { enabled: false, extractEveryNObservations: 3, flushAfterMs: 120000,
    maxTokens: 8192, maxInject: 3, staleAfterMs: 604800000, ...plugin?.practice };
  practice.enabled = practice.enabled === true;
  for (const [key, fallback] of Object.entries({ extractEveryNObservations: 3, flushAfterMs: 120000,
    maxTokens: 8192, maxInject: 3, staleAfterMs: 604800000 })) practice[key] = integer(practice[key], fallback);

  return {
    enabled: Boolean(plugin && plugin.enabled !== false),
    textService: String(plugin?.textService || "ai-conversation.text"),
    storageService: String(plugin?.storageService || "storage-sqlite.database"),
    shortTerm: short,
    longTerm: long,
    work, practice,
  };
}

module.exports = { getOptions };
