const { getPlugin } = require("../registry");
module.exports = {
  name: "raw-log",
  requires: ["storage"],
  optional: ["web-search.history"],
  shouldLoad: (config) => getPlugin(config, "raw-log")?.enabled !== false,
  load: () => require("./index"),
};
