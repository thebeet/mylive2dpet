const { readPluginOptions } = require("../registry");
function normalizeOptions(plugin) {
  const defaults = { auto: true, dailyLimit: 0, cooldownMs: 0, deferMs: 1800000,
    minIdleSeconds: 8, maxIdleSeconds: 300, maxSkips: 3, pollMs: 15000, timeoutMs: 90000 };
  const result = { ...defaults, ...plugin, enabled: Boolean(plugin && plugin.enabled !== false) };
  result.auto = result.auto !== false;
  for (const [key, fallback] of Object.entries(defaults)) {
    if (typeof fallback !== "number") continue;
    const value = Number(result[key]);
    result[key] = Number.isFinite(value) ? Math.max(["minIdleSeconds", "dailyLimit", "cooldownMs"].includes(key) ? 0 : 1, Math.floor(value)) : fallback;
  }
  result.pollMs = Math.max(1000, result.pollMs);
  result.maxIdleSeconds = Math.max(result.minIdleSeconds, result.maxIdleSeconds);
  return result;
}
function getOptions(config = {}) {
  return readPluginOptions(config, "questions", normalizeOptions);
}

module.exports = { getOptions, normalizeOptions };
