const { getPlugin } = require("../registry");
module.exports = {
  name: "web-search", provides: ["web-search.client", "web-search.history"], optional: ["storage"],
  normalizeOptions: require("./options").normalizeOptions,
  shouldLoad: (config) => getPlugin(config, "web-search")?.enabled === true,
  load: () => require("./index"),
};
