const { getPlugin } = require("../registry");
module.exports = {
  name: "camera-perception",
  requires: ["storage"],
  normalizeOptions: require("./options").normalizeOptions,
  shouldLoad: config => Boolean(getPlugin(config, "camera-perception")),
  load: () => require("./index"),
};
