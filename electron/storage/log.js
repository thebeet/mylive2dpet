const { randomUUID } = require("node:crypto");
const { getLogGeneration } = require("./logLifecycle");

/** Core diagnostic records use the same Storage abstraction as plugins. */
function createStorageLog(storage, { maxBytes = 5 * 1024 * 1024 } = {}) {
  return (entry, generation) => {
    if (!storage?.isAvailable()) return;
    if (generation != null && generation !== getLogGeneration(storage)) return;
    const records = storage.collection("core.ai-log");
    storage.transaction(() => {
      records.set(`${Date.now().toString().padStart(16, "0")}:${randomUUID()}`, entry);
      const entries = records.list();
      let bytes = entries.reduce((sum, item) => sum + Buffer.byteLength(JSON.stringify(item.value)), 0);
      for (const item of entries) {
        if (bytes <= maxBytes) break;
        records.delete(item.key);
        bytes -= Buffer.byteLength(JSON.stringify(item.value));
      }
    });
  };
}
module.exports = { createStorageLog };
