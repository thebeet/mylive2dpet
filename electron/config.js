const fs = require("fs");
const path = require("path");
const { getOptions: memoryOptions } = require("./plugins/memory/options");
const { getOptions: aiOptions } = require("./plugins/aiConversation/options");
const { getOptions: screenOptions } = require("./plugins/screenPerception/options");
const { getAudioOutputOptions } = require("./plugins/audioOutputPerception/options");
const { getTtsOptions, isTtsPluginActive } = require("./plugins/tts/options");
const { getOptions: questionOptions } = require("./plugins/questions/options");

const CONFIG_PATH = path.join(__dirname, "../config.json");
const object = (value) => value && typeof value === "object" && !Array.isArray(value);
function dictionary(value, name) {
  if (value != null && !object(value)) throw new Error(`${name} 必须是对象`);
}
function number(value, fallback, min, max, name) {
  const result = value == null ? fallback : Number(value);
  if (!Number.isFinite(result) || result < min || result > max) throw new Error(`${name} 超出允许范围`);
  return Math.floor(result);
}
function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

/** Validate current configuration and fill plugin defaults. */
function normalizeConfig(input) {
  if (!object(input)) throw new Error("配置根节点必须是对象");
  for (const key of Object.keys(input)) {
    if (!["ui", "decision", "observations", "plugins"].includes(key) && !key.startsWith("_")) {
      throw new Error(`不支持的配置根字段: ${key}，功能配置请放入 plugins`);
    }
  }
  for (const key of ["ui", "decision", "observations"]) dictionary(input[key], key);
  if (input.plugins != null && !Array.isArray(input.plugins)) throw new Error("plugins 必须是数组");
  const plugins = new Map();
  for (const plugin of input.plugins || []) {
    if (!object(plugin) || typeof plugin.name !== "string" || !plugin.name.trim()) throw new Error("插件必须有非空名称");
    if (plugins.has(plugin.name)) throw new Error(`插件名称重复: ${plugin.name}`);
    if (plugin.enabled != null && typeof plugin.enabled !== "boolean") throw new Error(`plugins.${plugin.name}.enabled 必须是布尔值`);
    for (const key of ["ai", "character", "shortTerm", "summary", "longTerm", "work", "practice", "changeDetect", "asr"]) dictionary(plugin[key], `plugins.${plugin.name}.${key}`);
    for (const key of ["shortTerm", "summary", "longTerm", "work", "practice", "changeDetect"]) {
      if (plugin[key]?.enabled != null && typeof plugin[key].enabled !== "boolean") throw new Error(`plugins.${plugin.name}.${key}.enabled 必须是布尔值`);
    }
    if (plugin.interval_ms != null) number(plugin.interval_ms, 5000, -86400000, 86400000, "plugin.interval_ms");
    if (plugin.observationTtlMs != null) number(plugin.observationTtlMs, 60000, 1000, 86400000, "plugin.observationTtlMs");
    if (plugin.name === "memory") {
      for (const key of Object.keys(plugin)) {
        if (!["name", "enabled", "textService", "storageService", "shortTerm", "summary", "longTerm", "work", "practice"].includes(key) && !key.startsWith("_")) {
          throw new Error(`不支持的记忆配置字段: ${key}，长期记忆参数请放入 longTerm`);
        }
      }
      if (plugin.longTerm?.path != null) throw new Error("memory.longTerm 请使用 legacyPath 指定 JSONL 导入来源");
    }
    const current = { ...plugin };
    if (plugin.name === "memory") delete current.summary; // Accept and discard obsolete configuration.
    plugins.set(plugin.name, current);
  }
  if (input.decision?.enabled != null && typeof input.decision.enabled !== "boolean") throw new Error("decision.enabled 必须是布尔值");
  function put(name, options) { plugins.set(name, { ...plugins.get(name), ...options, name }); }
  if (plugins.has("ai-conversation")) {
    const options = aiOptions(input);
    for (const key of ["endpoint", "apiKey", "model", "proxy"]) {
      if (options.ai[key] != null && typeof options.ai[key] !== "string") throw new Error(`ai.${key} 必须是字符串`);
    }
    options.ai.timeoutMs = number(options.ai.timeoutMs, 120000, 1000, 600000, "ai.timeoutMs");
    options.ai.retryBudgetMs = number(options.ai.retryBudgetMs, 360000, 1000, 1200000, "ai.retryBudgetMs");
    put("ai-conversation", { enabled: plugins.get("ai-conversation")?.enabled !== false, ...options });
  }
  const { intervalMs, ...screen } = screenOptions(input);
  put("screen-perception", { ...screen, interval_ms: intervalMs });
  if (plugins.has("audio-output-perception")) put("audio-output-perception", getAudioOutputOptions(input));
  if (plugins.has("tts")) put("tts", { ...getTtsOptions(input), enabled: isTtsPluginActive(input) });
  if (plugins.has("memory")) put("memory", memoryOptions(input));
  if (plugins.has("questions")) put("questions", questionOptions(input));
  const decision = { ...input.decision };
  if (decision.provider != null && (typeof decision.provider !== "string" || !decision.provider.trim())) throw new Error("decision.provider 必须是非空字符串");
  decision.provider ||= "ai-conversation";
  decision.enabled = decision.enabled !== false;
  decision.interval_ms = number(decision.interval_ms, 10000, -86400000, 86400000, "decision.interval_ms");
  const rawQueue = input.observations || {};
  dictionary(rawQueue.perSource, "observations.perSource");
  const observations = {
    maxPending: number(rawQueue.maxPending, 128, 1, 1024, "observations.maxPending"),
    maxBatch: number(rawQueue.maxBatch, 16, 1, 128, "observations.maxBatch"),
    maxRetries: number(rawQueue.maxRetries, 2, 0, 10, "observations.maxRetries"),
    perSource: { screen: 6, "audio-output": 20, "manual-input": 100 },
  };
  observations.maxBatch = Math.min(observations.maxBatch, observations.maxPending);
  for (const [source, limit] of Object.entries(rawQueue.perSource || {})) {
    observations.perSource[source] = number(limit, 32, 1, 1024, "observations.perSource");
  }
  return freeze({ ...input, plugins: [...plugins.values()], decision, observations });
}

function createConfigStore(filePath, { logger = console, checkIntervalMs = 1000 } = {}) {
  let cached = null;
  let stamp = null;
  let checkedAt = 0;
  let lastError = null;
  function load({ force = false } = {}) {
    const now = Date.now();
    if (cached && !force && now - checkedAt < checkIntervalMs) return cached;
    checkedAt = now;
    try {
      const stat = fs.statSync(filePath);
      const nextStamp = `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
      if (cached && !force && nextStamp === stamp) return cached;
      stamp = nextStamp;
      let parsed;
      try { parsed = JSON.parse(fs.readFileSync(filePath, "utf8")); }
      catch { throw new Error("配置文件无法读取或 JSON 格式无效"); }
      cached = normalizeConfig(parsed);
      lastError = null;
    } catch (error) {
      const message = error.code ? "配置文件无法读取" : error.message;
      if (!cached) throw new Error(message);
      if (lastError !== message) logger.warn(`[config] ${message}，继续使用上次有效配置`);
      lastError = message;
    }
    return cached;
  }
  return { load, getStatus: () => ({ loaded: Boolean(cached), error: lastError }) };
}
const store = createConfigStore(CONFIG_PATH);
module.exports = { CONFIG_PATH, loadConfig: store.load, normalizeConfig, createConfigStore };
