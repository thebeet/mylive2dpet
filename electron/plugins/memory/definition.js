const { getOptions, normalizeOptions } = require("./options");
const { getDefaults: longTermDefaults } = require("./longTerm");
const { validateOptions } = require("../../architecture/configValidation");
module.exports = {
  name: "memory",
  provides: ["memory.clear", "memory.work", "memory.organize", "memory.search", "memory.read"],
  normalizeOptions(plugin) {
    const sections = ["shortTerm", "longTerm", "work", "practice", "store", "maintenance", "retrieval", "embedding", "questions"];
    validateOptions(plugin, { objects: sections, toggles: sections });
    for (const key of Object.keys(plugin)) {
      if (!["name", "enabled", "storageService", ...sections].includes(key) && !key.startsWith("_")) {
        throw new Error(`不支持的记忆配置字段: ${key}，长期记忆参数请放入 longTerm`);
      }
    }
    const longTermKeys = new Set(Object.keys(longTermDefaults()));
    for (const key of Object.keys(plugin.longTerm || {})) {
      if (!longTermKeys.has(key) && !key.startsWith("_")) {
        throw new Error(`不支持的长期记忆配置字段: ${key}`);
      }
    }
    const defaults = normalizeOptions({ enabled: true });
    for (const section of ["store", "maintenance", "retrieval", "embedding", "questions"]) {
      for (const key of Object.keys(plugin[section] || {})) {
        if (!Object.hasOwn(defaults[section], key) && !key.startsWith("_")) throw new Error(`不支持的记忆配置字段: ${section}.${key}`);
      }
    }
    if (plugin.embedding?.enabled && (!plugin.embedding.endpoint || !plugin.embedding.model)) throw new Error("启用记忆 embedding 需要配置 endpoint 和 model");
    return normalizeOptions(plugin);
  },
  requires(config) {
    const options = getOptions(config);
    return options.store.enabled ? [options.storageService] : [];
  },
  shouldLoad: (config) => getOptions(config).enabled,
  load: () => require("./index"),
};
