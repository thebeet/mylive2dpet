const { getOptions, normalizeOptions } = require("./options");
const { getDefaults: longTermDefaults } = require("./longTerm");
const { validateOptions } = require("../../architecture/configValidation");
module.exports = {
  name: "memory",
  provides: ["memory.clear", "memory.work", "memory.organize"],
  normalizeOptions(plugin) {
    const sections = ["shortTerm", "longTerm", "work", "practice"];
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
    return normalizeOptions(plugin);
  },
  requires(config) {
    const options = getOptions(config);
    return options.longTerm.enabled || options.work.enabled || options.practice.enabled ? [options.storageService] : [];
  },
  shouldLoad: (config) => getOptions(config).enabled,
  load: () => require("./index"),
};
