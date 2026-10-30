const { getPlugin } = require("../registry");
module.exports = {
  name: "storage-sqlite",
  provides: ["storage-sqlite.database"],
  shouldLoad: (config) => getPlugin(config, "storage-sqlite")?.enabled !== false,
  load: () => require("./index"),
};
