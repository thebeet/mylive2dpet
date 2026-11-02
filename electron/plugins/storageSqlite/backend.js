const factories = {
  "dialogue-history": (...args) => require("./repositories/dialogueHistory").createHistoryRepository(...args),
  "raw-log": (...args) => require("./repositories/rawLog").createRawLogRepository(...args),
  memory: (...args) => require("./repositories/longTerm").createLongTermStore(...args),
  "work-memory": (...args) => require("./repositories/work").createWorkStore(...args),
  "memory-practice": (...args) => require("./repositories/practice").createPracticeStore(...args),
  "memory-updates": (...args) => require("./repositories/updates").createUpdateBuffer(...args),
};
const tables = {
  "dialogue-history": "dialogue_turns", "raw-log": "ai_requests", memory: "memory_entries",
  "work-memory": "work_evidence", "memory-practice": "memory_practice_entries", "memory-updates": "memory_update_turns",
};

/** SQLite implements the core contract, including existing domain schemas without data migration. */
function createSqliteBackend(database) {
  let collectionsReady = false;
  return {
    blobs: namespace => require("./blobs").createBlobStore(database, namespace),
    transaction: work => database.transaction(work),
    compact: () => database.compact(),
    hasRepository: name => Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tables[name])),
    repository(name, options) {
      if (!factories[name]) throw new Error(`Unsupported SQLite repository: ${name}`);
      return factories[name](database, options);
    },
    collection(namespace) {
      if (!collectionsReady) {
        database.migrate("storage-json", [db => db.exec(`CREATE TABLE storage_json (
          namespace TEXT NOT NULL, key TEXT NOT NULL, value_json TEXT NOT NULL,
          PRIMARY KEY(namespace, key)
        )`)]);
        collectionsReady = true;
      }
      const checkKey = key => { if (typeof key !== "string" || !key || key.length > 500) throw new TypeError("Invalid Storage key"); };
      return {
        get(key) {
          checkKey(key);
          const row = database.prepare("SELECT value_json FROM storage_json WHERE namespace = ? AND key = ?").get(namespace, key);
          return row ? JSON.parse(row.value_json) : undefined;
        },
        set(key, value) {
          checkKey(key);
          const json = JSON.stringify(value);
          if (json === undefined) throw new TypeError("Storage values must be JSON serializable");
          database.prepare(`INSERT INTO storage_json(namespace, key, value_json) VALUES (?, ?, ?)
            ON CONFLICT(namespace, key) DO UPDATE SET value_json = excluded.value_json`).run(namespace, key, json);
        },
        delete(key) { checkKey(key); return database.prepare("DELETE FROM storage_json WHERE namespace = ? AND key = ?").run(namespace, key).changes > 0; },
        list() { return database.prepare("SELECT key, value_json FROM storage_json WHERE namespace = ? ORDER BY key").all(namespace).map(row => ({ key: row.key, value: JSON.parse(row.value_json) })); },
        clear() { return database.prepare("DELETE FROM storage_json WHERE namespace = ?").run(namespace).changes; },
      };
    },
  };
}
module.exports = { createSqliteBackend };
