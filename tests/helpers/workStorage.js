const { DatabaseSync } = require("node:sqlite");
const { EventEmitter } = require("node:events");

function workStorage() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON; CREATE TABLE test_migrations(namespace TEXT PRIMARY KEY, version INTEGER NOT NULL)");
  let next = 0;
  const storage = {
    prepare: (sql) => db.prepare(sql), exec: (sql) => db.exec(sql),
    transaction(work) {
      const name = `test_${++next}`;
      db.exec(`SAVEPOINT ${name}`);
      try { const result = work(); db.exec(`RELEASE ${name}`); return result; }
      catch (error) { db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
    },
    migrate(namespace, migrations) {
      storage.transaction(() => {
        const version = db.prepare("SELECT version FROM test_migrations WHERE namespace = ?").get(namespace)?.version || 0;
        for (let i = version; i < migrations.length; i++) migrations[i](storage);
        db.prepare("INSERT INTO test_migrations(namespace, version) VALUES (?, ?) ON CONFLICT(namespace) DO UPDATE SET version = excluded.version")
          .run(namespace, migrations.length);
      });
    },
  };
  return { db, storage };
}

function mockWindows() {
  const windows = [];
  return { windows, create(options) {
    const win = new EventEmitter();
    Object.assign(win, { options, webContents: {}, destroyed: false, shows: 0, focuses: 0,
      isDestroyed() { return this.destroyed; }, isMinimized: () => false, restore() {},
      setPosition(x, y) { this.position = { x, y }; },
      show() { this.shows++; }, showInactive() { this.shows++; this.inactive = true; },
      focus() { this.focuses++; }, loadFile: async () => {},
      destroy() { if (this.destroyed) return; this.destroyed = true; this.emit("closed"); },
    });
    windows.push(win); return win;
  } };
}

module.exports = { workStorage, mockWindows };
