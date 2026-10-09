const { loadConfig } = require("../../config");
const { getPlugin, isPluginEnabled } = require("../registry");
const systemTts = require("./systemTts");
const gptSovitsTts = require("./gptSovitsTts");
const playWav = require("./playWav");

function isTtsEnabled(config = loadConfig()) {
  if (getPlugin(config, "tts")) return isPluginEnabled(config, "tts");
  // legacy top-level config.tts
  return config.tts?.enabled === true;
}

function getTtsOptions(config = loadConfig()) {
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
  playWav.stop();
}

/**
 * 若 TTS 开启则合成音频文件，ready 后返回；未开启返回 null。
 * 失败抛错（由调用方决定是否仍展示气泡）。
 *
 * @param {string} text
 * @returns {Promise<{ path: string, deleteAfter: boolean, provider: string } | null>}
 */
async function prepareReplyAudio(text) {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.warn("[tts] load config failed:", err);
    return null;
  }

  if (!isTtsEnabled(config)) {
    console.log("[tts] skipped (disabled)");
    return null;
  }

  const opts = getTtsOptions(config);
  if (opts.interruptOnNewChat) {
    stopTts();
  }

  console.log(
    `[tts] provider=${opts.provider} prepare:`,
    String(text || "").slice(0, 60),
  );

  let prepared;
  if (opts.provider === "system") {
    prepared = await systemTts.synthesizeToFile(text, { rate: opts.rate });
  } else if (
    opts.provider === "gpt-sovits" ||
    opts.provider === "gpt_sovits"
  ) {
    prepared = await gptSovitsTts.synthesizeToFile(text, opts);
  } else {
    console.warn(`[tts] provider "${opts.provider}" not implemented, skip`);
    return null;
  }

  if (!prepared?.path) return null;
  return { ...prepared, provider: opts.provider };
}

/**
 * 播放已合成好的音频。
 * @param {{ path: string, deleteAfter?: boolean } | null} prepared
 * @param {{ onState?: (state: 'start'|'end'|'error', detail?: string) => void }} [hooks]
 */
async function playPreparedAudio(prepared, hooks = {}) {
  const onState = typeof hooks.onState === "function" ? hooks.onState : () => {};
  if (!prepared?.path) {
    onState("end");
    return;
  }

  try {
    onState("start");
    await playWav.play(prepared.path, {
      deleteAfter: prepared.deleteAfter !== false,
    });
    onState("end");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[tts] play failed:", msg);
    onState("error", msg);
  }
}

/**
 * 合成并播放（兼容旧调用）。
 * @param {string} text
 * @param {{ onState?: (state: 'start'|'end'|'error', detail?: string) => void }} [hooks]
 */
async function speakReply(text, hooks = {}) {
  const onState = typeof hooks.onState === "function" ? hooks.onState : () => {};
  try {
    const prepared = await prepareReplyAudio(text);
    if (!prepared) {
      onState("end");
      return;
    }
    await playPreparedAudio(prepared, hooks);
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
  prepareReplyAudio,
  playPreparedAudio,
  speakReply,
};
