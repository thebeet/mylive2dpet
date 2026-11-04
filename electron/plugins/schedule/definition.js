const { getPlugin } = require("../registry");
const { number } = require("../../architecture/configValidation");

function normalizeOptions(plugin = {}) {
  for (const key of Object.keys(plugin)) {
    if (!["name", "enabled", "observationTtlMs", "maxRetries", "retryDelayMs"].includes(key) && !key.startsWith("_")) {
      throw new Error(`不支持的定时通知配置字段: ${key}`);
    }
  }
  return {
    ...plugin,
    observationTtlMs: number(plugin.observationTtlMs, 0, 0, 86400000, "schedule.observationTtlMs"),
    maxRetries: number(plugin.maxRetries, 2, 0, 10, "schedule.maxRetries"),
    retryDelayMs: number(plugin.retryDelayMs, 30000, 1000, 86400000, "schedule.retryDelayMs"),
  };
}

module.exports = {
  name: "schedule",
  provides: ["schedule.tasks"],
  requires: ["storage"],
  normalizeOptions,
  shouldLoad: (config) => getPlugin(config, "schedule")?.enabled !== false,
  load: () => require("./index"),
};
