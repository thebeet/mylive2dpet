const { randomUUID } = require("node:crypto");

/** Native binary persistence; lists return metadata without loading image bytes. */
function createBlobStore(database, namespace) {
  database.migrate("storage-blobs", [db => db.exec(`CREATE TABLE storage_blobs (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    namespace TEXT NOT NULL, id TEXT NOT NULL, data BLOB NOT NULL,
    size INTEGER NOT NULL, metadata_json TEXT NOT NULL, created_at INTEGER NOT NULL,
    UNIQUE(namespace, id)
  ); CREATE INDEX storage_blobs_namespace ON storage_blobs(namespace, sequence)`)]);
  const checkId = id => { if (typeof id !== "string" || !id || id.length > 200) throw new TypeError("Invalid Storage blob id"); };
  const decode = row => ({ id: row.id, size: row.size, createdAt: row.created_at, metadata: JSON.parse(row.metadata_json) });
  return {
    put(data, metadata = {}) {
      if (!(data instanceof Uint8Array) || !data.byteLength) throw new TypeError("Storage blobs require non-empty binary data");
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new TypeError("Storage blob metadata must be an object");
      const id = randomUUID(), createdAt = Date.now();
      const json = JSON.stringify(metadata);
      database.prepare("INSERT INTO storage_blobs(namespace,id,data,size,metadata_json,created_at) VALUES (?,?,?,?,?,?)")
        .run(namespace, id, Buffer.from(data), data.byteLength, json, createdAt);
      return { id, size: data.byteLength, createdAt, metadata: JSON.parse(json) };
    },
    get(id) {
      checkId(id);
      const row = database.prepare("SELECT id,data,size,metadata_json,created_at FROM storage_blobs WHERE namespace=? AND id=?").get(namespace, id);
      return row ? { ...decode(row), data: Buffer.from(row.data) } : undefined;
    },
    getMetadata(id) {
      checkId(id);
      const row = database.prepare("SELECT id,size,metadata_json,created_at FROM storage_blobs WHERE namespace=? AND id=?").get(namespace, id);
      return row ? decode(row) : undefined;
    },
    updateMetadata(id, patch) {
      checkId(id);
      if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new TypeError("Storage blob metadata patch must be an object");
      return database.transaction(() => {
        const row = database.prepare("SELECT metadata_json FROM storage_blobs WHERE namespace=? AND id=?").get(namespace, id);
        if (!row) return false;
        const metadata = { ...JSON.parse(row.metadata_json), ...patch };
        database.prepare("UPDATE storage_blobs SET metadata_json=? WHERE namespace=? AND id=?").run(JSON.stringify(metadata), namespace, id);
        return true;
      });
    },
    list({ before = null, limit = 50 } = {}) {
      if (before !== null && (!Number.isSafeInteger(before) || before <= 0)) throw new TypeError("Invalid Storage blob cursor");
      const size = Math.max(1, Math.min(100, Math.floor(Number(limit) || 50)));
      const rows = database.prepare(`SELECT sequence,id,size,metadata_json,created_at FROM storage_blobs WHERE namespace=?
        ${before === null ? "" : "AND sequence < ?"} ORDER BY sequence DESC LIMIT ?`)
        .all(namespace, ...(before === null ? [] : [before]), size + 1);
      return { entries: rows.slice(0, size).map(decode), nextCursor: rows.length > size ? rows[size - 1].sequence : null };
    },
    delete(id) { checkId(id); return database.prepare("DELETE FROM storage_blobs WHERE namespace=? AND id=?").run(namespace, id).changes > 0; },
    clear() { return database.prepare("DELETE FROM storage_blobs WHERE namespace=?").run(namespace).changes; },
  };
}
module.exports = { createBlobStore };
