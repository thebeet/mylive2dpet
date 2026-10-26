const { getPlugin } = require("../registry");

function getOptions(config = {}) {
  const plugin = getPlugin(config, "ai-conversation") || {};
  return {
    ai: { ...config.ai, ...plugin.ai },
    character: { ...config.character, ...plugin.character },
  };
}

module.exports = { getOptions };
