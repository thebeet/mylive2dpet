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
    shouldLoad: (config) => isPluginEnabled(config, "ai-conversation"),
    load: () => require("./aiConversation"),
  },
  {
    name: "raw-log",
    requires: ["storage-sqlite.database"],
    shouldLoad: (config) => getPlugin(config, "raw-log")?.enabled !== false,
    load: () => require("./rawLog"),
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
    shouldLoad: (config) => Boolean(getPlugin(config, "audio-output-perception")),
    load: () => require("./audioOutputPerception"),
  },
  {
    name: "tts",
    shouldLoad: (config) => isPluginEnabled(config, "tts"),
    load: () => require("./tts"),
  },
  {
    name: "memory",
    provides: ["memory.clear", "memory.work"],
    requires: (config) => {
      const options = require("./memory/options").getOptions(config);
      return options.longTerm.enabled || options.work.enabled ? [options.storageService] : [];
    },
    optional: (config) => [require("./memory/options").getOptions(config).textService],
    shouldLoad: (config) => require("./memory/options").getOptions(config).enabled,
    load: () => require("./memory"),
  },
  {
    name: "questions",
    requires: ["memory.work"],
    shouldLoad: (config) => require("./questions/options").getOptions(config).enabled && require("./memory/options").getOptions(config).work.enabled,
    load: () => require("./questions"),
  },
];
