const { getPlugin } = require("../registry");
module.exports = {
  name: "raw-log",
  requires: ["storage-sqlite.database"],
  shouldLoad: (config) => getPlugin(config, "raw-log")?.enabled !== false,
  load: () => require("./index"),
};
