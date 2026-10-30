/** Built-in catalog; options, loading rules, and dependencies belong to each plugin. */
module.exports = [
  require("./manualInput/definition"),
  require("./storageSqlite/definition"),
  require("./dialogueHistory/definition"),
  require("./rawLog/definition"),
  require("./screenPerception/definition"),
  require("./audioOutputPerception/definition"),
  require("./tts/definition"),
  require("./memory/definition"),
  require("./questions/definition"),
];
