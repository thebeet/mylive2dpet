const { getLogGeneration } = require("../../storage/logLifecycle");
const MAX_RECORDS = 200;

/** Delivery history stays readable independently of the observer's lifecycle. */
function createCodexHistory(storage, { now = Date.now, logger } = {}) {
  const records = () => storage.collection("codex-observer.history");
  return {
    record(entry, logGeneration) {
      try {
        if (logGeneration !== getLogGeneration(storage)) return;
        storage.transaction(() => {
          records().set(entry.id, { ...entry, t: now(), logGeneration });
          const all = records().list().sort((a, b) => b.value.t - a.value.t || b.key.localeCompare(a.key));
          for (const item of all.slice(MAX_RECORDS)) records().delete(item.key);
        });
      } catch (error) { logger?.warn(`Codex 入队日志保存失败：${error.message}`); }
    },
    list({ before = null, limit = 50 } = {}) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Codex 日志分页数量无效");
      if (before != null && (typeof before !== "object" || !Number.isFinite(before.t) || typeof before.id !== "string")) {
        throw new Error("Codex 日志分页游标无效");
      }
      const all = records().list().map(item => item.value)
        .filter(item => !before || item.t < before.t || item.t === before.t && item.id < before.id)
        .sort((a, b) => b.t - a.t || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
      const page = all.slice(0, limit), last = page.at(-1);
      return { entries: page.map(({ prompt, observation, ...entry }) => ({ ...entry, preview: prompt.slice(0, 160) })),
        nextCursor: all.length > limit ? { t: last.t, id: last.id } : null };
    },
    get(id) {
      if (typeof id !== "string" || !id || id.length > 200) throw new Error("Codex 日志 ID 无效");
      const record = records().get(id);
      if (!record) throw new Error("Codex 入队记录不存在或已清理");
      return record;
    },
  };
}

module.exports = { createCodexHistory, MAX_RECORDS };
