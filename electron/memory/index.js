/**
 * Core memory: short-term buffer + rolling session summary.
 * Long-term persistence is the optional "memory" plugin under electron/plugins/memory.
 */

const shortTerm = require("./shortTerm");
const summarizer = require("./summarizer");
const memoryPlugin = require("../plugins/memory");

/**
 * @param {object} [config]
 */
function getMemoryConfig(config = {}) {
  const m = config.memory || {};
  return {
    shortTerm: { ...shortTerm.getDefaults(), ...(m.shortTerm || {}) },
    summary: { ...summarizer.getDefaults(), ...(m.summary || {}) },
    longTerm: memoryPlugin.getOptions(config),
    longTermEnabled: memoryPlugin.isEnabled(config),
  };
}

/**
 * Build prompt sections from current memory state.
 * @param {object} [config] full app config
 */
function buildPromptSections(config = {}) {
  const mem = getMemoryConfig(config);

  let recentDialogue = "";
  if (mem.shortTerm.enabled !== false) {
    const items = shortTerm.list(mem.shortTerm);
    recentDialogue = shortTerm.formatForPrompt(items);
  }

  let sessionSummary = "";
  if (mem.summary.enabled !== false) {
    sessionSummary = summarizer.get();
  }

  let longTermMemory = "";
  if (mem.longTermEnabled) {
    const query = [sessionSummary, recentDialogue].filter(Boolean).join("\n");
    const hits = memoryPlugin.longTerm.retrieve(query, mem.longTerm);
    longTermMemory = memoryPlugin.longTerm.formatForPrompt(hits);
  }

  return { recentDialogue, sessionSummary, longTermMemory };
}

/**
 * Synchronously record a turn into the short-term buffer (next chat sees it).
 * @param {{ reply: string, expression?: string, trigger?: string }} turn
 * @param {object} [config]
 */
function recordTurn(turn, config = {}) {
  const mem = getMemoryConfig(config);
  const reply = String(turn.reply || "").trim();
  if (!reply) return;

  if (mem.shortTerm.enabled !== false) {
    shortTerm.append(
      {
        petSaid: reply,
        expression: turn.expression || "neutral",
        trigger: turn.trigger || "",
      },
      mem.shortTerm,
    );
  }

  if (mem.summary.enabled !== false) summarizer.bumpTurnCount();
  if (mem.longTermEnabled) memoryPlugin.extractor.bumpTurnCount();
}

/**
 * Async maintain: rolling summary + long-term fact extraction.
 * Best-effort; must not fail the main chat.
 *
 * @param {{
 *   config: object,
 *   callChat: (messages: object[], opts?: object) => Promise<string>,
 * }} deps
 */
async function maintain(deps) {
  const { config, callChat } = deps;
  if (typeof callChat !== "function") return;

  const mem = getMemoryConfig(config);
  const turns = shortTerm.list(mem.shortTerm);
  const turnsText = shortTerm.formatForPrompt(turns);
  if (!turnsText) return;

  if (
    mem.summary.enabled !== false &&
    summarizer.shouldSummarize(mem.summary, turns.length)
  ) {
    try {
      const next = await summarizer.summarizeWithLlm({
        previousSummary: summarizer.get(),
        turnsText,
        callChat,
        maxTokens: mem.summary.maxTokens,
      });
      if (next) {
        summarizer.set(next);
        summarizer.resetTurnCount();
        shortTerm.retainNewest(
          mem.summary.keepTurnsAfterSummary ?? 3,
          mem.shortTerm,
        );
        console.log(
          "[memory] session summary updated:",
          next.slice(0, 120) + (next.length > 120 ? "…" : ""),
        );
      }
    } catch (err) {
      console.warn(
        "[memory] summarize failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (
    mem.longTermEnabled &&
    memoryPlugin.extractor.shouldExtract(mem.longTerm)
  ) {
    try {
      const freshTurns = shortTerm.list(mem.shortTerm);
      const extractText =
        shortTerm.formatForPrompt(freshTurns) || turnsText;
      const facts = await memoryPlugin.extractor.extractWithLlm({
        turnsText: extractText,
        callChat,
        maxTokens: mem.longTerm.maxTokens,
      });
      let added = 0;
      for (const fact of facts) {
        if (memoryPlugin.longTerm.isDuplicate(fact.text, mem.longTerm)) {
          continue;
        }
        memoryPlugin.longTerm.append(fact, mem.longTerm);
        added += 1;
      }
      memoryPlugin.extractor.resetTurnCount();
      if (added > 0) {
        console.log(`[memory:plugin] long-term +${added} fact(s)`);
      }
    } catch (err) {
      console.warn(
        "[memory:plugin] extract failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }
}

/**
 * @param {{ reply: string, expression?: string, trigger?: string }} turn
 * @param {{ config: object, callChat: Function }} deps
 */
async function afterReply(turn, deps) {
  recordTurn(turn, deps.config);
  await maintain(deps);
}

function clearAll() {
  shortTerm.clear();
  summarizer.clear();
  memoryPlugin.extractor.resetTurnCount();
}

module.exports = {
  getMemoryConfig,
  buildPromptSections,
  recordTurn,
  maintain,
  afterReply,
  clearAll,
  shortTerm,
  summarizer,
};
