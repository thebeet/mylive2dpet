/** Built-in catalog; options, loading rules, and dependencies belong to each plugin. */
module.exports = [
  require("./avatarLive2d/definition"),
  require("./avatar3d/definition"),
  require("./manualInput/definition"),
  require("./schedule/definition"),
  require("./webSearch/definition"),
  require("./rss/definition"),
  require("./gitlab/definition"),
  require("./storageSqlite/definition"),
  require("./dialogueHistory/definition"),
  require("./rawLog/definition"),
  require("./screenPerception/definition"),
  require("./audioOutputPerception/definition"),
  require("./tts/definition"),
  require("./memory/definition"),
  require("./questions/definition"),
];
