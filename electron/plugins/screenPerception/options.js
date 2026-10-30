const { readPluginOptions } = require("../registry");

function normalizeOptions(plugin = {}) {
  const interval = Number(plugin.interval_ms);
  return {
    enabled: plugin.enabled !== false,
    interval_ms: Number.isFinite(interval) ? interval : 5000,
    observationTtlMs: Math.max(1000, Number(plugin.observationTtlMs) || 60000),
    changeDetect: { ...plugin.changeDetect },
  };
}

function runtimeOptions(plugin) {
  const { interval_ms, ...options } = normalizeOptions(plugin || {});
  return { ...options, intervalMs: interval_ms };
}

function getOptions(config = {}) {
  return readPluginOptions(config, "screen-perception", runtimeOptions);
}

module.exports = { getOptions, normalizeOptions };
