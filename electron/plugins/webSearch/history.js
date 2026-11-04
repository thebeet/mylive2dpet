const { createSanitizer } = require("./diagnostics");
const NAMESPACE = "web-search.history";
const MAX_RECORDS = 500;

function createWebHistory({ getStorage, options, logger }) {
  const memory = new Map();
  const clean = createSanitizer(options, { maxString: 100000, maxItems: 50 });
  const store = () => {
    const storage = getStorage?.();
    return storage?.isAvailable() ? storage.collection(NAMESPACE) : {
      get: id => memory.get(id), set: (id, value) => memory.set(id, value),
      list: () => [...memory].map(([key, value]) => ({ key, value })), clear: () => memory.clear(),
      delete: id => memory.delete(id),
    };
  };
  function write(work) {
    try { work(store()); } catch (error) { logger?.warn("web history write failed:", error.message); }
  }
  // Requests left pending by a previous process will never resume automatically.
  write(records => {
    for (const { key, value } of records.list()) {
      if (["queued", "running"].includes(value.state)) records.set(key, { ...value,
        state: "cancelled", finishedAt: Date.now(), error: "应用重启，请求未恢复" });
    }
  });
  return {
    begin(entry) {
      write(records => {
        records.set(entry.id, clean({ ...entry, t: Date.now(), updatedAt: Date.now() }));
        const all = records.list().sort((a, b) => a.value.t - b.value.t || a.key.localeCompare(b.key));
        for (const item of all.slice(0, Math.max(0, all.length - MAX_RECORDS))) records.delete(item.key);
      });
    },
    update(id, patch) {
      write(records => {
        const record = records.get(id);
        // A clear or retention eviction must not be undone by a late response.
        if (record) records.set(id, clean({ ...record, ...patch, updatedAt: Date.now() }));
      });
    },
    http(event, fields) {
      write(records => {
        const record = fields.requestId && records.get(fields.requestId);
        if (!record) return;
        const events = [...(record.http || []), { event, t: Date.now(), ...fields }].slice(-30);
        records.set(record.id, clean({ ...record, http: events, updatedAt: Date.now() }));
      });
    },
    list({ before = null, limit = 50 } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("历史分页数量无效");
      if (before && (!Number.isFinite(before.t) || typeof before.id !== "string")) throw new Error("历史分页游标无效");
      const all = store().list().map(item => item.value)
        .filter(item => !before || item.t < before.t || item.t === before.t && item.id < before.id)
        .sort((a, b) => b.t - a.t || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
      const records = all.slice(0, limit);
      const last = records.at(-1);
      return { entries: records.map(({ result, http, ...entry }) => ({ ...entry,
        resultCount: result?.results?.length, title: result?.title })),
        nextCursor: all.length > limit ? { t: last.t, id: last.id } : null };
    },
    get(id) {
      if (typeof id !== "string") throw new Error("历史请求 ID 无效");
      const record = store().get(id);
      if (!record) throw new Error("请求记录不存在或已清理");
      return record;
    },
    clearMemory() { memory.clear(); },
  };
}

module.exports = { createWebHistory, NAMESPACE };
