const { loadConfig } = require("../config");
const systemTts = require("./systemTts");
const gptSovitsTts = require("./gptSovitsTts");

function getTtsPlugin(config) {
  const list = Array.isArray(config.plugins) ? config.plugins : [];
  return list.find((p) => p && p.name === "tts") || null;
}

function isTtsEnabled(config = loadConfig()) {
  const plugin = getTtsPlugin(config);
  if (plugin) return plugin.enabled !== false;
  return config.tts?.enabled === true;
}

function getTtsOptions(config = loadConfig()) {
  const plugin = getTtsPlugin(config) || {};
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

function stopTts() {
  systemTts.stop();
  gptSovitsTts.stop();
}

/**
 * 按配置播报台词（失败只打日志，不影响聊天）。
 * @param {string} text
 * @param {{ onState?: (state: 'start'|'end'|'error', detail?: string) => void }} [hooks]
 */
async function speakReply(text, hooks = {}) {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.warn("[tts] load config failed:", err);
    return;
  }

  if (!isTtsEnabled(config)) {
    console.log("[tts] skipped (disabled)");
    return;
  }

  const opts = getTtsOptions(config);
  const onState = typeof hooks.onState === "function" ? hooks.onState : () => {};

  try {
    if (opts.interruptOnNewChat) {
      stopTts();
    }
    onState("start");
    console.log(
      `[tts] provider=${opts.provider} speak:`,
      String(text || "").slice(0, 60),
    );

    if (opts.provider === "system") {
      await systemTts.speak(text, { rate: opts.rate });
    } else if (
      opts.provider === "gpt-sovits" ||
      opts.provider === "gpt_sovits"
    ) {
      await gptSovitsTts.speak(text, opts);
    } else {
      console.warn(`[tts] provider "${opts.provider}" not implemented, skip`);
      onState("end");
      return;
    }

    onState("end");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[tts] failed:", msg);
    onState("error", msg);
  }
}

module.exports = {
  isTtsEnabled,
  getTtsOptions,
  stopTts,
  speakReply,
};
