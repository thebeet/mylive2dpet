const { getPlugin } = require("../registry");

function getOptions(config = {}) {
  const plugin = getPlugin(config, "ai-conversation") || {};
  return {
    ai: { ...plugin.ai },
    character: { ...plugin.character },
  };
}

module.exports = { getOptions };
