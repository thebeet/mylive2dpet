const { randomUUID } = require("crypto");
/** Volatile fallback; durable buffers are supplied by Storage. */
function createUpdateBuffer(storage = null) {
  if (storage) return storage.repository("memory-updates");
  const turns = new Map(), sources = new Map();
  const put = (map, item) => { if (!map.has(item.id)) map.set(item.id, structuredClone(item)); return item; };
  return {
    durable: false,
    append: turn => put(turns, { ...turn, id: turn.updateId || randomUUID() }),
    restoreTurn: turn => put(turns, turn),
    list: () => structuredClone([...turns.values()]),
    evidence: () => structuredClone([...sources.values()]),
    stageEvidence: items => { for (const item of items) put(sources, { ...item, id: item.id || randomUUID() }); },
    consume: (snapshotTurns, snapshotSources) => {
      for (const item of snapshotTurns) turns.delete(item.id);
      for (const item of snapshotSources) sources.delete(item.id);
    },
    clear: () => { turns.clear(); sources.clear(); },
  };
}
module.exports = { createUpdateBuffer };
