const { getPlugin } = require("../registry");
module.exports = {
  name: "storage-sqlite",
  provides: ["storage"],
  shouldLoad: (config) => getPlugin(config, "storage-sqlite")?.enabled !== false,
  load: () => require("./index"),
};
