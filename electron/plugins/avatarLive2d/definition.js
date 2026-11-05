const { isPluginEnabled } = require("../registry");
const { normalizeOptions } = require("./options");
module.exports = {
  name: "avatar-live2d",
  kind: "avatar",
  defaultConfig: true,
  normalizeOptions: (plugin, config) => normalizeOptions(plugin || {
    enabled: !config.plugins?.some(({ name }) => name === "avatar-3d"),
  }),
  shouldLoad: config => isPluginEnabled(config, "avatar-live2d"),
  load: () => require("./index"),
};
