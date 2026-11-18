const { getOptions, normalizeOptions } = require("./options");
const { getOptions: memoryOptions } = require("../memory/options");
module.exports = {
  name: "questions",
  requires: ["memory.work"],
  normalizeOptions,
  shouldLoad: (config) => getOptions(config).enabled && memoryOptions(config).store.enabled && memoryOptions(config).questions.enabled,
  load: () => require("./index"),
};
