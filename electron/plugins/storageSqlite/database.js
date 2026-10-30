const fs = require("fs");
const path = require("path");

/** A shared synchronous connection; business schemas belong to consuming plugins. */
function createDatabase(filePath, { Database = require("better-sqlite3"), busyTimeoutMs = 5000 } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new Database(filePath, { timeout: busyTimeoutMs });
  let closed = false;
  try {
    db.pragma("foreign_keys = ON");
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        namespace TEXT PRIMARY KEY, version INTEGER NOT NULL
      );
    `);
  } catch (error) {
    db.close();
    throw error;
  }

  function assertOpen() {
    if (closed) throw new Error("SQLite storage has been closed");
  }

  function transaction(work) {
    assertOpen();
    return db.transaction(() => {
      const result = work();
      if (result && typeof result.then === "function") {
        throw new TypeError("SQLite transaction callbacks must be synchronous");
      }
      return result;
    }).immediate();
  }

  const api = {
    prepare(sql) { assertOpen(); return db.prepare(sql); },
    exec(sql) { assertOpen(); return db.exec(sql); },
    transaction,
    migrate(namespace, migrations) {
      return transaction(() => {
        const version = db.prepare("SELECT version FROM schema_migrations WHERE namespace = ?")
          .get(namespace)?.version || 0;
        if (version > migrations.length) throw new Error(`Unsupported schema version: ${namespace} ${version}`);
        for (let index = version; index < migrations.length; index += 1) migrations[index](api);
        db.prepare("INSERT INTO schema_migrations(namespace, version) VALUES (?, ?) ON CONFLICT(namespace) DO UPDATE SET version = excluded.version")
          .run(namespace, migrations.length);
      });
    },

  };

  return {
    api,
    close() {
      if (closed) return;
      try { db.pragma("wal_checkpoint(TRUNCATE)"); }
      finally { db.close(); closed = true; }
    },
  };
}

module.exports = { createDatabase };
