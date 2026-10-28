const { getPlugin, isPluginEnabled } = require("../registry");

function getTtsOptions(config = {}) {
  const plugin = getPlugin(config, "tts") || {};
  return {
    provider: plugin.provider || "system",
    rate: plugin.rate ?? 0,
    interruptOnNewChat: plugin.interruptOnNewChat ?? true,
    // gpt-sovits
    apiBase: plugin.apiBase || "http://127.0.0.1:9880",
    apiVersion: plugin.apiVersion || "v2",
    gptWeights: plugin.gptWeights || "",
    sovitsWeights: plugin.sovitsWeights || "",
    weightsPreloaded: plugin.weightsPreloaded ?? false,
    refAudio: plugin.refAudio || "",
    refAudioApiPath: plugin.refAudioApiPath || "",
    promptText: plugin.promptText || "",
    textLang: plugin.textLang || "zh",
    promptLang: plugin.promptLang || "",
    topK: plugin.topK,
    topP: plugin.topP,
    temperature: plugin.temperature,
    speedFactor: plugin.speedFactor,
    textSplitMethod: plugin.textSplitMethod,
    batchSize: plugin.batchSize,
  };
}

module.exports = { isTtsPluginActive: (config = {}) => isPluginEnabled(config, "tts"), getTtsOptions };
