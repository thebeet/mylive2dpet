/**
 * Long-term memory plugin — JSONL store + keyword/tag retrieval (no embedding).
 *
 * Enable via config.plugins:
 *   { "name": "memory", "enabled": true, "path": "logs/memory.jsonl", ... }
 *
 * Short-term buffer / session summary stay in electron/memory (core).
 */

const { getPlugin, isPluginEnabled } = require("../registry");
const longTerm = require("./longTerm");
const extractor = require("./extractor");

function getDefaults() {
  return {
    ...longTerm.getDefaults(),
    extractEveryNTurns:
      extractor.getDefaults().extractEveryNTurns,
    maxTokens: extractor.getDefaults().maxTokens,
  };
}

/**
 * Resolve plugin options. Prefers plugins[{name:memory}], falls back to
 * legacy config.memory.longTerm for older configs.
 * @param {object} [config]
 */
function getOptions(config = {}) {
  const plugin = getPlugin(config, "memory");
  const legacy = config.memory?.longTerm || {};
  if (plugin) {
    return { ...getDefaults(), ...legacy, ...plugin };
  }
  return { ...getDefaults(), ...legacy };
}

/**
 * @param {object} [config]
 */
function isEnabled(config = {}) {
  if (getPlugin(config, "memory")) {
    return isPluginEnabled(config, "memory");
  }
  // legacy: config.memory.longTerm.enabled
  const legacy = config.memory?.longTerm;
  if (legacy && typeof legacy.enabled === "boolean") {
    return legacy.enabled;
  }
  return false;
}

module.exports = {
  getDefaults,
  getOptions,
  isEnabled,
  longTerm,
  extractor,
};
