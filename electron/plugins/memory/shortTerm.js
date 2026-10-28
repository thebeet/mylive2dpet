function getDefaults() {
  return { enabled: true, maxTurns: 8, ttlMs: 1_800_000 };
}

/** Each plugin instance owns its buffer; snapshots carry stable local turn IDs. */
function createShortTermStore({ now = Date.now } = {}) {
  let turns = [];
  let nextId = 0;

  function prune(config = {}) {
    const { maxTurns, ttlMs } = { ...getDefaults(), ...config };
    const stamp = now();
    turns = turns.filter((turn) => stamp - turn.t < ttlMs).slice(-maxTurns);
  }

  function append(input, config = {}) {
    if (config.enabled === false) return null;
    const reply = String(input.reply || "").trim();
    if (!reply && !(input.speak === false && Object.values(input.summaries || {}).some((text) => typeof text === "string" && text.trim()))) return null;
    const turn = {
      id: ++nextId,
      decisionId: input.decisionId || null,
      sessionId: input.sessionId || null,
      t: input.t ?? now(),
      reply,
      ...(input.speak === false ? { speak: false } : {}),
      userMessage: String(input.userMessage || "").trim(),
      expression: input.expression || "neutral",
      trigger: input.trigger || "",
      summaries: { ...input.summaries },
    };
    turns.push(turn);
    prune(config);
    return turn;
  }

  function list(config = {}) {
    prune(config);
    return turns.map((turn) => ({ ...turn, summaries: { ...turn.summaries } }));
  }

  function foldSnapshot(snapshot, keep, config = {}) {
    const count = Math.max(0, Number(keep) || 0);
    const folded = count > 0 ? snapshot.slice(0, -count) : snapshot;
    const ids = new Set(folded.map((turn) => turn.id));
    turns = turns.filter((turn) => !ids.has(turn.id));
    prune(config);
  }

  return { append, list, foldSnapshot, clear: () => { turns = []; } };
}

module.exports = { getDefaults, createShortTermStore };
