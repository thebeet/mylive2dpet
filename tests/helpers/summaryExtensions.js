const { createPromptExtensions } = require("../../electron/architecture/promptExtensions");
const screen = require("../../electron/plugins/screenPerception/prompt").promptExtension;
const audio = require("../../electron/plugins/audioOutputPerception/prompt").promptExtension;

function summaryExtensions({ includeAudio = false } = {}) {
  const extensions = createPromptExtensions();
  extensions.register("screen-perception", screen);
  if (includeAudio) extensions.register("audio-output-perception", audio);
  return extensions;
}

module.exports = { summaryExtensions };
