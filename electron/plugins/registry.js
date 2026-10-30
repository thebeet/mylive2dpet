/**
 * Config-driven plugin lookup.
 * Plugins live under electron/plugins/* and are toggled via config.plugins[].
 *
 * Note: these are Electron main-process plugins (Node fs/net/child_process).
 * They are NOT renderer modules under src/ — the Vite app only handles Live2D UI.
 */
const { freeze } = require("../architecture/configValidation");

/**
 * @param {object} [config]
 * @param {string} name
 * @returns {object|null}
 */
function getPlugin(config, name) {
  const list = Array.isArray(config?.plugins) ? config.plugins : [];
  return list.find((p) => p && p.name === name) || null;
}

/**
 * @param {object} [config]
 * @param {string} name
 * @returns {boolean}
 */
function isPluginEnabled(config, name) {
  const plugin = getPlugin(config, name);
  return !!(plugin && plugin.enabled !== false);
}

// Validated snapshots are immutable. Normalize their runtime view once per plugin;
// mutable raw configurations remain supported by standalone modules and tests.
const optionViews = new WeakMap();
function readPluginOptions(config, name, normalize) {
  const plugin = getPlugin(config, name);
  if (!plugin || !Object.isFrozen(plugin)) return normalize(plugin);
  let views = optionViews.get(plugin);
  if (!views) { views = new Map(); optionViews.set(plugin, views); }
  if (!views.has(normalize)) {
    views.set(normalize, freeze(normalize(plugin)));
  }
  return views.get(normalize);
}

module.exports = { getPlugin, isPluginEnabled, readPluginOptions };
