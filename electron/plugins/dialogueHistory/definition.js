const { getPlugin } = require("../registry");
module.exports = {
  name: "dialogue-history",
  normalizeOptions(plugin) {
    for (const key of Object.keys(plugin)) {
      if (!["name", "enabled", "storageService"].includes(key) && !key.startsWith("_")) {
        throw new Error(`不支持的历史对话配置字段: ${key}`);
      }
    }
    return plugin;
  },
  requires: (config) => [getPlugin(config, "dialogue-history")?.storageService || "storage-sqlite.database"],
  shouldLoad: (config) => getPlugin(config, "dialogue-history")?.enabled !== false,
  load: () => require("./index"),
};
