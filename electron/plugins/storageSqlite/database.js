const fs = require("fs");
const path = require("path");
const { createHash } = require("crypto");

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
      CREATE TABLE IF NOT EXISTS legacy_imports (
        namespace TEXT NOT NULL, source_path TEXT NOT NULL,
        imported_at INTEGER NOT NULL, imported_count INTEGER NOT NULL,
        skipped_count INTEGER NOT NULL, PRIMARY KEY (namespace, source_path)
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
    importJsonl(namespace, sourcePath, insert) {
      assertOpen();
      const source = path.resolve(sourcePath);
      const previous = db.prepare("SELECT imported_count AS imported, skipped_count AS skipped FROM legacy_imports WHERE namespace = ? AND source_path = ?")
        .get(namespace, source);
      if (previous) return { ...previous, alreadyImported: true };
      if (!fs.existsSync(source)) return { imported: 0, skipped: 0, missing: true };
      const lines = fs.readFileSync(source, "utf8").split(/\r?\n/);
      return transaction(() => {
        const concurrent = db.prepare("SELECT imported_count AS imported, skipped_count AS skipped FROM legacy_imports WHERE namespace = ? AND source_path = ?")
          .get(namespace, source);
        if (concurrent) return { ...concurrent, alreadyImported: true };
        let imported = 0;
        let skipped = 0;
        lines.forEach((line, index) => {
          if (!line.trim()) return;
          let entry;
          try { entry = JSON.parse(line); }
          catch { skipped += 1; return; }
          const digest = createHash("sha256").update(`${index}\0${line}`).digest("hex");
          const id = `${namespace}:legacy:${digest}`;
          // Invalid entries return false; storage errors abort the entire import.
          if (insert(entry, id)) imported += 1;
          else skipped += 1;
        });
        db.prepare("INSERT INTO legacy_imports(namespace, source_path, imported_at, imported_count, skipped_count) VALUES (?, ?, ?, ?, ?)")
          .run(namespace, source, Date.now(), imported, skipped);
        return { imported, skipped, alreadyImported: false };
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
