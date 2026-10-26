const { getPlugin } = require("../registry");

function getOptions(config = {}) {
  const plugin = getPlugin(config, "screen-perception") || {};
  const legacy = config.perception || {};
  const interval = Number(plugin.interval_ms ?? legacy.interval_ms);
  return {
    enabled: plugin.enabled ?? legacy.enabled ??
      (config.decision?.enabled ?? config.chat?.enabled) !== false,
    intervalMs: Number.isFinite(interval) ? interval : 5000,
    observationTtlMs: Math.max(1000, Number(plugin.observationTtlMs) || 60000),
    changeDetect: { ...config.chat?.changeDetect, ...plugin.changeDetect },
  };
}

module.exports = { getOptions };
