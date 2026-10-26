const { getPlugin } = require("../registry");

function isTtsPluginActive(config = {}) {
  const plugin = getPlugin(config, "tts");
  if (plugin) return plugin.enabled !== false;
  // legacy top-level config.tts
  return config.tts?.enabled === true;
}

function getTtsOptions(config = {}) {
  const plugin = getPlugin(config, "tts") || {};
  const legacy = config.tts || {};
  return {
    provider: plugin.provider || legacy.provider || "system",
    rate: plugin.rate ?? legacy.rate ?? 0,
    interruptOnNewChat:
      plugin.interruptOnNewChat ?? legacy.interruptOnNewChat ?? true,
    // gpt-sovits
    apiBase: plugin.apiBase || legacy.apiBase || "http://127.0.0.1:9880",
    apiVersion: plugin.apiVersion || legacy.apiVersion || "v2",
    gptWeights: plugin.gptWeights || legacy.gptWeights || "",
    sovitsWeights: plugin.sovitsWeights || legacy.sovitsWeights || "",
    weightsPreloaded:
      plugin.weightsPreloaded ?? legacy.weightsPreloaded ?? false,
    refAudio: plugin.refAudio || legacy.refAudio || "",
    refAudioApiPath:
      plugin.refAudioApiPath || legacy.refAudioApiPath || "",
    promptText: plugin.promptText || legacy.promptText || "",
    textLang: plugin.textLang || legacy.textLang || "zh",
    promptLang: plugin.promptLang || legacy.promptLang || "",
    topK: plugin.topK ?? legacy.topK,
    topP: plugin.topP ?? legacy.topP,
    temperature: plugin.temperature ?? legacy.temperature,
    speedFactor: plugin.speedFactor ?? legacy.speedFactor,
    textSplitMethod: plugin.textSplitMethod || legacy.textSplitMethod,
    batchSize: plugin.batchSize ?? legacy.batchSize,
  };
}

module.exports = { isTtsPluginActive, getTtsOptions };
