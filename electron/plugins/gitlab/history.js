const { getLogGeneration } = require("../../storage/logLifecycle");
const NAMESPACE = "gitlab.history";
const MAX_RECORDS = 200;

/** Project query history is independent of polling checkpoints and readable after plugin unload. */
function createGitlabHistory(storage, { now = Date.now, redact = value => value, logger } = {}) {
  const records = () => storage.collection(NAMESPACE);
  function clean(value) {
    if (typeof value === "string") return redact(value);
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
      .filter(([, part]) => part !== undefined).map(([key, part]) => [key, clean(part)]));
    return value;
  }
  function write(work) {
    try { work(records()); }
    catch (error) { logger?.warn(`GitLab 查询日志保存失败：${redact(error.message)}`); }
  }
  return {
    recover() {
      write(collection => {
        for (const { key, value } of collection.list()) {
          if (value.state === "running") collection.set(key, { ...value, state: "cancelled",
            finishedAt: now(), updatedAt: now(), error: "应用重启或插件重载，请求未恢复" });
        }
      });
    },
    begin(entry) {
      write(collection => {
        collection.set(entry.id, clean({ ...entry, state: "running", logGeneration: getLogGeneration(storage),
          t: now(), updatedAt: now() }));
        const all = collection.list().sort((a, b) => b.value.t - a.value.t || b.key.localeCompare(a.key));
        for (const item of all.slice(MAX_RECORDS)) collection.delete(item.key);
      });
    },
    update(id, patch) {
      write(collection => {
        const record = collection.get(id);
        // Clearing and retention must not be undone by a late HTTP response or submission.
        if (!record || record.logGeneration !== getLogGeneration(storage)) return;
        collection.set(id, clean({ ...record, ...patch, updatedAt: now() }));
      });
    },
    list({ before = null, limit = 50 } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("GitLab 日志分页数量无效");
      if (before != null && (typeof before !== "object" || !Number.isFinite(before.t) || typeof before.id !== "string")) {
        throw new Error("GitLab 日志分页游标无效");
      }
      const all = records().list().map(item => item.value)
        .filter(item => !before || item.t < before.t || item.t === before.t && item.id < before.id)
        .sort((a, b) => b.t - a.t || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
      const page = all.slice(0, limit), last = page.at(-1);
      return { entries: page.map(({ pages, items, ...entry }) => entry),
        nextCursor: all.length > limit ? { t: last.t, id: last.id } : null };
    },
    get(id) {
      if (typeof id !== "string" || !id || id.length > 200) throw new Error("GitLab 日志 ID 无效");
      const record = records().get(id);
      if (!record) throw new Error("GitLab 查询记录不存在或已清理");
      return record;
    },
  };
}

module.exports = { createGitlabHistory, NAMESPACE, MAX_RECORDS };
