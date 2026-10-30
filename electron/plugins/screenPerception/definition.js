const { normalizeOptions } = require("./options");
const { validateOptions } = require("../../architecture/configValidation");
module.exports = {
  name: "screen-perception",
  defaultConfig: true,
  normalizeOptions(plugin) {
    validateOptions(plugin, { objects: ["changeDetect"], toggles: ["changeDetect"], capture: true });
    return normalizeOptions(plugin);
  },
  // Load manual capture even when automatic capture is disabled.
  shouldLoad: () => true,
  load: () => require("./index"),
};
