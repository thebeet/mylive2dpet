const { getPlugin } = require("../registry");
const shortTerm = require("./shortTerm");
const summarizer = require("./summarizer");
const longTerm = require("./longTerm");

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const integer = (value, fallback, minimum = 1) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(minimum, Math.floor(number)) : fallback;
};
const FLAT_LONG_TERM_KEYS = ["path", "maxInject", "extractEveryNTurns", "maxTokens", "maxEntries"];

/** Preserve legacy enabled=false as a long-term-only switch. */
function getOptions(config = {}) {
  const plugin = getPlugin(config, "memory");
  const legacy = config.memory || {};
  const nested = plugin && ["shortTerm", "summary", "longTerm"].some((key) => own(plugin, key));
  const flat = plugin && FLAT_LONG_TERM_KEYS.some((key) => own(plugin, key));
  const unified = plugin && (nested || (!config.memory && !flat));
  const legacyPresent = !unified && Boolean(plugin || config.memory || config.ai || config.chat || config.perception);

  const short = { ...shortTerm.getDefaults(), ...legacy.shortTerm, ...plugin?.shortTerm };
  const summary = { ...summarizer.getDefaults(), ...legacy.summary, ...plugin?.summary };
  const long = {
    ...longTerm.getDefaults(),
    ...legacy.longTerm,
    ...(!unified && plugin ? Object.fromEntries(FLAT_LONG_TERM_KEYS
      .filter((key) => own(plugin, key)).map((key) => [key, plugin[key]])) : {}),
    ...plugin?.longTerm,
  };
  if (!unified) long.enabled = plugin ? plugin.enabled !== false : legacy.longTerm?.enabled === true;

  short.enabled = short.enabled !== false;
  short.maxTurns = integer(short.maxTurns, 8);
  short.ttlMs = integer(short.ttlMs, 1_800_000);
  summary.enabled = summary.enabled !== false;
  summary.everyNTurns = integer(summary.everyNTurns, 6, 2);
  summary.keepTurnsAfterSummary = integer(summary.keepTurnsAfterSummary, 3, 0);
  summary.maxTokens = integer(summary.maxTokens, 256);
  long.enabled = long.enabled !== false;
  long.legacyPath = String(plugin?.longTerm?.legacyPath ?? plugin?.longTerm?.path ??
    (!unified ? plugin?.legacyPath ?? plugin?.path : undefined) ??
    legacy.longTerm?.legacyPath ?? legacy.longTerm?.path ?? long.legacyPath).trim() || longTerm.getDefaults().legacyPath;
  long.maxInject = integer(long.maxInject, 5);
  long.extractEveryNTurns = integer(long.extractEveryNTurns, 3);
  long.maxTokens = integer(long.maxTokens, 256);
  long.maxEntries = integer(long.maxEntries, 500);

  return {
    enabled: unified ? plugin.enabled !== false
      : legacyPresent && (short.enabled || summary.enabled || long.enabled),
    textService: String(plugin?.textService || "ai-conversation.text"),
    storageService: String(plugin?.storageService || "storage-sqlite.database"),
    shortTerm: short,
    summary,
    longTerm: long,
  };
}

module.exports = { getOptions };
