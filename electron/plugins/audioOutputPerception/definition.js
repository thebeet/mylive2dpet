const { getPlugin } = require("../registry");
const { normalizeOptions } = require("./options");
const { validateOptions } = require("../../architecture/configValidation");
module.exports = {
  name: "audio-output-perception",
  normalizeOptions(plugin) {
    validateOptions(plugin, { objects: ["asr"], capture: true });
    return normalizeOptions(plugin);
  },
  // A loaded source can be enabled from the menu for the current run.
  shouldLoad: (config) => Boolean(getPlugin(config, "audio-output-perception")),
  load: () => require("./index"),
};
