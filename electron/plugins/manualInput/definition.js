const { getPlugin } = require("../registry");
module.exports = {
  name: "manual-input",
  shouldLoad: (config) => getPlugin(config, "manual-input")?.enabled !== false,
  load: () => require("./index"),
};
