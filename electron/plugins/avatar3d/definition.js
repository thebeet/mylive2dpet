const { isPluginEnabled } = require("../registry");
const { normalizeOptions } = require("./options");
module.exports = {
  name: "avatar-3d",
  kind: "avatar",
  normalizeOptions,
  shouldLoad: config => isPluginEnabled(config, "avatar-3d"),
  load: () => require("./index"),
};
