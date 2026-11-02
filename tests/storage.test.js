const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { createStorage, storageService } = require("../electron/storage");
const { createStorageLog } = require("../electron/storage/log");
const { createSqliteBackend } = require("../electron/plugins/storageSqlite/backend");
const { createDatabase } = require("../electron/plugins/storageSqlite/database");
const { createPluginHost } = require("../electron/pluginHost");
const { createServiceRegistry } = require("../electron/architecture/serviceRegistry");
const { MessageBus } = require("../electron/architecture/messageBus");
const { normalizeConfig } = require("../electron/config");
const { workStorage } = require("./helpers/workStorage");
const quiet = { info() {}, warn() {}, error() {} };

// A backend with no SQL/SQLite dependency proves consumers use the core contract.
function mapBackend() {
  let values = new Map();
  return {
    blobs: namespace => ({
      put: (data, metadata) => { const id = `blob-${values.size}`; values.set(`${namespace}:${id}`, { data, metadata }); return { id, size: data.length, metadata }; },
      get: id => values.get(`${namespace}:${id}`),
      getMetadata: id => values.get(`${namespace}:${id}`),
      updateMetadata(id, patch) { const value = values.get(`${namespace}:${id}`); if (!value) return false; value.metadata = { ...value.metadata, ...patch }; return true; },
      list: () => ({ entries: [], nextCursor: null }),
      delete: id => values.delete(`${namespace}:${id}`),
      clear() {},
    }),
    hasRepository: () => false,
    repository: () => ({ append() {}, finish() {}, rewriteRequests() {}, listGroups() {}, getGroup() {}, clear() {}, list: () => ({ entries: [], nextCursor: null }), get: () => ({ request: {} }) }),
    transaction(work) {
      const before = structuredClone(values);
      try { return work(); } catch (error) { values = before; throw error; }
    },
    collection(namespace) {
      const keyFor = key => `${namespace}:${key}`;
      return {
        get: key => structuredClone(values.get(keyFor(key))),
        set: (key, value) => values.set(keyFor(key), structuredClone(value)),
        delete: key => values.delete(keyFor(key)),
        list: () => [...values].filter(([key]) => key.startsWith(`${namespace}:`)).map(([key, value]) => ({ key: key.slice(namespace.length + 1), value: structuredClone(value) })),
        clear() { for (const key of values.keys()) if (key.startsWith(`${namespace}:`)) values.delete(key); },
      };
    },
  };
}

test("core Storage validates providers, isolates namespaces and invalidates stale handles", () => {
  const services = createServiceRegistry();
  const core = createStorage({ services });
  assert.throws(() => core.api.collection("test"), /unavailable/);
  assert.throws(() => core.registerBackend({}), /does not implement/);
  const remove = core.registerBackend(mapBackend());
  assert.equal(services.get("storage"), core.api);
  assert.equal(Object.hasOwn(core.api, "prepare"), false);
  assert.throws(() => core.registerBackend(mapBackend()), /already registered/);
  const first = core.api.collection("first"), second = core.api.collection("second");
  first.set("same", { value: 1 }); second.set("same", { value: 2 });
  assert.deepEqual(first.get("same"), { value: 1 });
  assert.deepEqual(second.get("same"), { value: 2 });
  assert.throws(() => core.api.transaction(() => { first.set("same", 3); throw new Error("rollback"); }), /rollback/);
  assert.deepEqual(first.get("same"), { value: 1 });
  assert.throws(() => core.api.transaction(() => Promise.resolve()), /synchronous/);
  assert.throws(() => core.api.repository("unknown"), /Unknown/);
  const repository = core.api.repository("raw-log");
  remove(); remove();
  assert.equal(services.get("storage"), undefined);
  core.registerBackend(mapBackend());
  assert.throws(() => first.get("same"), /replaced or unloaded/);
  assert.throws(() => repository.list(), /replaced or unloaded/);
  assert.equal(core.api.collection("first").get("same"), undefined);
  const shared = mapBackend(), other = createStorage();
  const release = other.registerBackend(shared);
  const stale = other.api.collection("same-backend");
  release(); other.registerBackend(shared);
  release();
  assert.equal(other.api.isAvailable(), true);
  assert.throws(() => stale.list(), /replaced or unloaded/);
});

test("SQLite implements JSON CRUD and atomic cross-namespace transactions", t => {
  const { db, storage } = workStorage(); t.after(() => db.close());
  const first = storage.collection("plugin-a"), second = storage.collection("plugin-b");
  first.set("value", { nested: [1, "中文", null] });
  assert.deepEqual(first.get("value"), { nested: [1, "中文", null] });
  assert.equal(second.get("value"), undefined);
  assert.throws(() => storage.transaction(() => {
    first.set("value", "changed"); second.set("new", true); throw new Error("failed");
  }), /failed/);
  assert.deepEqual(first.get("value"), { nested: [1, "中文", null] });
  assert.equal(second.get("new"), undefined);
  assert.throws(() => first.set("missing", undefined), /JSON/);
  assert.throws(() => first.get(""), /Invalid/);
  assert.equal(first.delete("value"), true);
  assert.equal(first.delete("value"), false);
  assert.deepEqual(first.list(), []);
  assert.equal(first.clear(), 0);
});

// Driver injection exercises production connection/migration code with Node's SQLite in tests.
class SqliteDriver {
  constructor(file) { this.db = new DatabaseSync(file); this.sequence = 0; }
  pragma(value) { return this.db.prepare(`PRAGMA ${value}`).all(); }
  get inTransaction() { return this.db.isTransaction; }
  exec(sql) { return this.db.exec(sql); }
  prepare(sql) { return this.db.prepare(sql); }
  close() { this.db.close(); }
  transaction(work) {
    const run = () => {
      const name = `save_${++this.sequence}`;
      this.db.exec(`SAVEPOINT ${name}`);
      try { const value = work(); this.db.exec(`RELEASE ${name}`); return value; }
      catch (error) { this.db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
    };
    return { immediate: run };
  }
}

test("SQLite Storage reopens existing domain tables and JSON records without changing schemas", t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pet-storage-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "pet.sqlite3");
  let connection = createDatabase(file, { Database: SqliteDriver });
  // Existing repository schema is populated before it is accessed through the new abstraction.
  require("../electron/plugins/storageSqlite/repositories/longTerm").createLongTermStore(connection.api)
    .appendBatch([{ text: "已有长期事实", importance: 4 }]);
  let core = createStorage();
  let remove = core.registerBackend(createSqliteBackend(connection.api));
  assert.equal(core.api.repository("memory").list()[0].text, "已有长期事实");
  core.api.collection("settings").set("theme", "dark");
  const image = core.api.blobs("screenshots").put(Buffer.from([0xff, 0xd8, 0x00, 0xff, 0xd9]), { capturedAt: "2026-11-02T01:00:00Z", mimeType: "image/jpeg" });
  remove(); connection.close();
  connection = createDatabase(file, { Database: SqliteDriver });
  core = createStorage(); remove = core.registerBackend(createSqliteBackend(connection.api));
  try {
    assert.equal(core.api.repository("memory").list()[0].text, "已有长期事实");
    assert.equal(core.api.collection("settings").get("theme"), "dark");
    assert.deepEqual(core.api.blobs("screenshots").get(image.id).data, Buffer.from([0xff, 0xd8, 0x00, 0xff, 0xd9]));
    assert.equal(core.api.blobs("screenshots").getMetadata(image.id).metadata.capturedAt, "2026-11-02T01:00:00Z");
  } finally { remove(); connection.close(); }
});

test("log cleanup compacts the SQLite file and WAL while preserving memory and new writes", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pet-compact-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "pet.sqlite3");
  const connection = createDatabase(file, { Database: SqliteDriver });
  t.after(() => connection.close());
  const core = createStorage();
  core.registerBackend(createSqliteBackend(connection.api));
  const storage = core.api;
  const repository = require("../electron/plugins/rawLog/repository").createRawLogRepository(storage);
  const memory = storage.repository("memory");
  memory.appendBatch([{ text: "保留的记忆", importance: 4 }]);
  storage.blobs("screenshots").put(Buffer.alloc(4 * 1024 * 1024, 42));
  storage.compact();
  const before = fs.statSync(file).size;
  assert.throws(() => storage.transaction(() => storage.compact()), /outside a transaction/);
  const result = await require("../electron/plugins/rawLog/clear").clearRawLog({ bus: new MessageBus() }, repository, storage);
  assert.equal(result.compacted, true);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.screenshots, 1);
  assert.ok(fs.statSync(file).size < before / 2);
  assert.equal(fs.statSync(`${file}-wal`).size, 0);
  assert.equal(memory.list()[0].text, "保留的记忆");
  const fresh = storage.blobs("screenshots").put(Buffer.from("new"));
  assert.deepEqual(storage.blobs("screenshots").get(fresh.id).data, Buffer.from("new"));
});

test("Storage compaction is optional for backends", () => {
  const core = createStorage();
  assert.throws(() => core.api.compact(), /unavailable/);
  core.registerBackend(mapBackend());
  assert.deepEqual(core.api.compact(), { supported: false });
});

test("binary Storage isolates namespaces, paginates without bytes and rolls back metadata and image writes", t => {
  const { db, storage } = workStorage(); t.after(() => db.close());
  const images = storage.blobs("screenshots"), other = storage.blobs("other");
  const records = Array.from({ length: 3 }, (_, i) => images.put(Buffer.from([i + 1, 0, 255]), { filename: `${i}.jpg` }));
  assert.equal(other.get(records[0].id), undefined);
  const first = images.list({ limit: 2 });
  assert.deepEqual(first.entries.map(item => item.id), [records[2].id, records[1].id]);
  assert.equal(Object.hasOwn(first.entries[0], "data"), false);
  assert.equal(Object.hasOwn(images.getMetadata(records[0].id), "data"), false);
  assert.deepEqual(images.list({ before: first.nextCursor }).entries.map(item => item.id), [records[0].id]);
  assert.throws(() => storage.transaction(() => {
    images.put(Buffer.from("new"));
    images.updateMetadata(records[0].id, { summary: "should roll back" });
    throw new Error("rollback");
  }), /rollback/);
  assert.equal(images.list().entries.length, 3);
  assert.deepEqual(images.getMetadata(records[0].id).metadata, { filename: "0.jpg" });
  assert.equal(images.updateMetadata(records[0].id, { summary: "saved" }), true);
  assert.equal(images.getMetadata(records[0].id).metadata.filename, "0.jpg");
  assert.equal(images.updateMetadata("missing", {}), false);
  assert.throws(() => images.put("not binary"), /binary/);
  assert.throws(() => images.put(Buffer.alloc(0)), /binary/);
  assert.throws(() => images.list({ before: "invalid" }), /cursor/);
  assert.equal(images.delete(records[0].id), true);
  assert.equal(images.delete(records[0].id), false);
  assert.equal(images.clear(), 2);
});

test("provider reload replaces dependent plugins and unregisters the backend after their cleanup", async t => {
  const services = createServiceRegistry(), storage = createStorage({ services });
  let initial = { plugins: [{ name: "provider", enabled: true, version: 1 }, { name: "consumer", enabled: true }] };
  const consumers = [], events = [];
  const host = createPluginHost({ services, storage, getConfig: () => initial, bus: new MessageBus(), logger: quiet,
    definitions: [
      { name: "consumer", requires: ["storage"], shouldLoad: () => true, load: () => ({ activate(context) {
        const handle = context.storage.collection("consumer"); consumers.push(handle);
        return { dispose() { handle.set("cleanup", true); events.push("consumer disposed"); } };
      } }) },
      { name: "provider", provides: ["storage"], shouldLoad: config => config.plugins.find(p => p.name === "provider").enabled,
        load: () => ({ activate(context) {
          const remove = context.storage.registerBackend(mapBackend());
          return { dispose() { events.push("provider disposed"); remove(); } };
        } }) },
    ],
  });
  t.after(() => host.dispose());
  await host.activate(); await host.start();
  await host.reload({ plugins: [{ ...initial.plugins[0], version: 2 }, initial.plugins[1]] });
  assert.deepEqual(events, ["consumer disposed", "provider disposed"]);
  assert.equal(consumers.length, 2);
  assert.throws(() => consumers[0].get("cleanup"), /已卸载|replaced or unloaded/);
  await host.reload({ plugins: [{ ...initial.plugins[0], enabled: false }, initial.plugins[1]] });
  assert.equal(storage.api.isAvailable(), false);
  assert.equal(host.getState().consumer.status, "blocked");
});

test("legacy service configuration resolves to core Storage and core diagnostic logs use Storage", t => {
  assert.equal(storageService("storage-sqlite.database"), "storage");
  const config = normalizeConfig({ plugins: [{ name: "memory", storageService: "storage-sqlite.database" }, { name: "dialogue-history", storageService: "storage-sqlite.database" }] });
  assert.ok(config.plugins.filter(p => ["memory", "dialogue-history"].includes(p.name)).every(p => p.storageService === "storage"));
  const { db, storage } = workStorage(); t.after(() => db.close());
  const log = createStorageLog(storage, { maxBytes: 100 });
  for (let i = 0; i < 5; i++) log({ content: "x".repeat(30), i });
  const entries = storage.collection("core.ai-log").list();
  assert.ok(entries.length > 0 && entries.length < 5);
  assert.ok(entries.reduce((sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry.value)), 0) <= 100);
});
