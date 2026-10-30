const { isPluginEnabled } = require("../registry");
const { normalizeOptions } = require("./options");
module.exports = {
  name: "tts",
  normalizeOptions: (plugin) => ({ ...normalizeOptions(plugin), enabled: plugin.enabled !== false }),
  shouldLoad: (config) => isPluginEnabled(config, "tts"),
  load: () => require("./index"),
};
