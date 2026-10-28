const { randomUUID } = require("crypto");

/** Originals awaiting a dialogue update are independent of the visible recent buffer. */
function createUpdateBuffer(storage = null) {
  const turns = new Map(), sources = new Map();
  if (storage) storage.migrate("memory-updates", [(db) => db.exec(`
    CREATE TABLE memory_update_turns (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, data_json TEXT NOT NULL
    );
    CREATE TABLE memory_update_sources (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, data_json TEXT NOT NULL
    );
  `)]);
  const list = (table, fallback) => storage
    ? storage.prepare(`SELECT data_json FROM ${table} ORDER BY sequence`).all().map((r) => JSON.parse(r.data_json))
    : structuredClone([...fallback.values()]);
  function put(table, fallback, item) {
    if (storage) storage.prepare(`INSERT OR IGNORE INTO ${table}(id, data_json) VALUES (?, ?)`).run(item.id, JSON.stringify(item));
    else if (!fallback.has(item.id)) fallback.set(item.id, item);
    return item;
  }
  function consume(snapshotTurns, snapshotSources) {
    const work = () => {
      for (const [table, fallback, items] of [["memory_update_turns", turns, snapshotTurns], ["memory_update_sources", sources, snapshotSources]]) {
        for (const item of items) {
          if (storage) storage.prepare(`DELETE FROM ${table} WHERE id = ?`).run(item.id);
          else fallback.delete(item.id);
        }
      }
    };
    if (storage) storage.transaction(work); else work();
  }
  return {
    durable: Boolean(storage),
    append: (turn) => put("memory_update_turns", turns, { ...turn, id: turn.updateId || randomUUID() }),
    restoreTurn: (turn) => put("memory_update_turns", turns, turn),
    list: () => list("memory_update_turns", turns),
    evidence: () => list("memory_update_sources", sources),
    stageEvidence: (items) => { for (const item of items) put("memory_update_sources", sources, { ...item, id: item.id || randomUUID() }); },
    consume,
    clear: () => consume(list("memory_update_turns", turns), list("memory_update_sources", sources)),
  };
}

module.exports = { createUpdateBuffer };
