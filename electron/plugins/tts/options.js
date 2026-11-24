const { readPluginOptions, isPluginEnabled } = require("../registry");
const { dictionary } = require("../../architecture/configValidation");

function normalizeService(service = {}) {
  service ||= {};
  const type = service.type || "external";
  if (!["external", "docker"].includes(type)) throw new Error("tts.service.type 必须是 external 或 docker");
  const result = { type };
  if (type === "docker") {
    result.preset = service.preset || "cosyvoice";
    if (result.preset !== "cosyvoice") throw new Error("tts.service.preset 目前只支持 cosyvoice");
    result.image = service.image || "neosun/cosyvoice:v3.4.0";
    if (typeof result.image !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(result.image)) throw new Error("tts.service.image 无效");
    result.port = service.port ?? 8188;
    if (!Number.isInteger(result.port) || result.port < 1024 || result.port > 65535) throw new Error("tts.service.port 必须是 1024～65535 的整数");
    result.gpu = service.gpu ?? true;
    if (typeof result.gpu !== "boolean") throw new Error("tts.service.gpu 必须是布尔值");
    result.startupTimeoutMs = service.startupTimeoutMs ?? 1200000;
    result.pullTimeoutMs = service.pullTimeoutMs ?? 1800000;
    for (const key of ["startupTimeoutMs", "pullTimeoutMs"]) {
      if (!Number.isInteger(result[key]) || result[key] < 1000 || result[key] > 7200000) throw new Error(`tts.service.${key} 必须是 1000～7200000 的整数`);
    }
  }
  return result;
}

function normalizeOptions(plugin = {}) {
  plugin ||= {};
  dictionary(plugin.service, "tts.service");
  const service = normalizeService(plugin.service);
  const compatible = plugin.provider === "openai-compatible";
  for (const key of ["apiBase", "apiKey", "model", "voice", "refAudio", "promptText", "instruct"]) {
    if (compatible && plugin[key] != null && typeof plugin[key] !== "string") throw new Error(`tts.${key} 必须是字符串`);
  }
  const apiBase = service.type === "docker" ? `http://127.0.0.1:${service.port}/v1`
    : plugin.apiBase || (compatible ? "" : "http://127.0.0.1:9880");
  if (compatible) {
    if (apiBase) {
      let url;
      try { url = new URL(apiBase); } catch { throw new Error("tts.apiBase 必须是有效的 HTTP(S) 地址"); }
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("tts.apiBase 必须是不含凭据和查询参数的 HTTP(S) 地址");
    }
    if (plugin.responseFormat != null && plugin.responseFormat !== "wav") throw new Error("tts.responseFormat 目前只支持 wav");
    if (plugin.speed != null && (typeof plugin.speed !== "number" || !Number.isFinite(plugin.speed) || plugin.speed < 0.25 || plugin.speed > 4)) throw new Error("tts.speed 必须在 0.25～4 之间");
    if (plugin.timeoutMs != null && (!Number.isInteger(plugin.timeoutMs) || plugin.timeoutMs < 1000 || plugin.timeoutMs > 7200000)) throw new Error("tts.timeoutMs 必须是 1000～7200000 的整数");
    if (plugin.enabled !== false) {
      if (!apiBase || (service.type === "external" && !plugin.model?.trim())) throw new Error("云端 TTS 需要配置 apiBase 和 model");
      if (!plugin.voice?.trim() && !(service.type === "docker" && plugin.refAudio?.trim())) throw new Error("TTS 需要配置 voice；本地 CosyVoice 也可配置 refAudio 自动克隆音色");
    }
  } else if (service.type === "docker") throw new Error("tts.service.type=docker 需要 provider=openai-compatible");
  return {
    provider: plugin.provider || "system",
    rate: plugin.rate ?? 0,
    interruptOnNewChat: plugin.interruptOnNewChat ?? true,
    // gpt-sovits
    apiBase,
    apiKey: plugin.apiKey || "",
    model: plugin.model || (service.type === "docker" ? "cosyvoice-v3" : ""),
    voice: plugin.voice || "",
    responseFormat: "wav",
    speed: plugin.speed ?? 1,
    timeoutMs: plugin.timeoutMs ?? 120000,
    instruct: plugin.instruct || "",
    service,
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

function getTtsOptions(config = {}) {
  return readPluginOptions(config, "tts", normalizeOptions);
}

module.exports = { normalizeOptions, isTtsPluginActive: (config = {}) => isPluginEnabled(config, "tts"), getTtsOptions };
