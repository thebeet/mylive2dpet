/**
 * Config-driven plugin lookup.
 * Plugins live under electron/plugins/* and are toggled via config.plugins[].
 *
 * Note: these are Electron main-process plugins (Node fs/net/child_process).
 * They are NOT renderer modules under src/ — the Vite app only handles Live2D UI.
 */

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

module.exports = { getPlugin, isPluginEnabled };
