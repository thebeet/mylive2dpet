const { getPlugin } = require("../registry");

function getOptions(config = {}) {
  const plugin = getPlugin(config, "screen-perception") || {};
  const interval = Number(plugin.interval_ms);
  return {
    enabled: plugin.enabled !== false,
    intervalMs: Number.isFinite(interval) ? interval : 5000,
    observationTtlMs: Math.max(1000, Number(plugin.observationTtlMs) || 60000),
    changeDetect: { ...plugin.changeDetect },
  };
}

module.exports = { getOptions };
