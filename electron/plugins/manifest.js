const { getPlugin, isPluginEnabled } = require("./registry");

/** Static built-in plugin catalog; plugin-specific loading rules stay here. */
module.exports = [
  {
    name: "manual-input",
    shouldLoad: (config) => getPlugin(config, "manual-input")?.enabled !== false,
    load: () => require("./manualInput"),
  },
  {
    name: "storage-sqlite",
    provides: ["storage-sqlite.database"],
    shouldLoad: (config) => getPlugin(config, "storage-sqlite")?.enabled !== false,
    load: () => require("./storageSqlite"),
  },
  {
    name: "dialogue-history",
    requires: (config) => [getPlugin(config, "dialogue-history")?.storageService || "storage-sqlite.database"],
    shouldLoad: (config) => getPlugin(config, "dialogue-history")?.enabled !== false,
    load: () => require("./dialogueHistory"),
  },
  {
    name: "ai-conversation",
    provides: ["ai-conversation.text"],
    shouldLoad: (config) => {
      if (getPlugin(config, "ai-conversation")) return isPluginEnabled(config, "ai-conversation");
      return Boolean(config.ai);
    },
    load: () => require("./aiConversation"),
  },
  {
    name: "screen-perception",
    // enabled controls automatic capture; explicit capture remains available.
    shouldLoad: () => true,
    load: () => require("./screenPerception"),
  },
  {
    name: "audio-output-perception",
    // The source menu can enable capture for the current run.
    shouldLoad: (config) => Boolean(
      getPlugin(config, "audio-output-perception") || config.perception?.audioOutput,
    ),
    load: () => require("./audioOutputPerception"),
  },
  {
    name: "tts",
    shouldLoad: (config) => {
      if (getPlugin(config, "tts")) return isPluginEnabled(config, "tts");
      return config.tts?.enabled === true;
    },
    load: () => require("./tts"),
  },
  {
    name: "memory",
    provides: ["memory.clear"],
    requires: (config) => {
      const options = require("./memory/options").getOptions(config);
      return options.longTerm.enabled ? [options.storageService] : [];
    },
    optional: (config) => [require("./memory/options").getOptions(config).textService],
    shouldLoad: (config) => require("./memory/options").getOptions(config).enabled,
    load: () => require("./memory"),
  },
];
