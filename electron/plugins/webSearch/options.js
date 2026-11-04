const { getPlugin } = require("../registry");
const { object, number } = require("../../architecture/configValidation");

function normalizeOptions(plugin = {}) {
  const allowed = ["name", "enabled", "searchProvider", "fetchProvider", "providers", "timeoutMs", "maxRetries",
    "maxResults", "maxContentChars", "maxConcurrent", "maxPending", "maxRequestsPerChain", "observationTtlMs"];
  for (const key of Object.keys(plugin)) {
    if (!allowed.includes(key) && !key.startsWith("_")) throw new Error(`不支持的网页搜索配置字段: ${key}`);
  }
  if (plugin.providers != null && !object(plugin.providers)) throw new Error("web-search.providers 必须是对象");
  const providers = {};
  for (const [name, config] of Object.entries(plugin.providers || {})) {
    if (!["deepseek", "openai"].includes(name) || !object(config)) throw new Error(`不支持的网页 provider: ${name}`);
    for (const key of Object.keys(config)) {
      if (!["endpoint", "apiKey", "model", "proxy"].includes(key)) throw new Error(`不支持的 provider 配置字段: ${key}`);
      if (typeof config[key] !== "string") throw new Error(`web-search.providers.${name}.${key} 必须是字符串`);
    }
    const endpoint = config.endpoint || (name === "deepseek" ? "https://api.deepseek.com/v1" : "https://api.openai.com/v1");
    let url;
    try { url = new URL(endpoint); } catch { throw new Error(`网页 provider endpoint 无效: ${name}`); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error(`网页 provider endpoint 无效: ${name}`);
    }
    providers[name] = { ...config, endpoint: endpoint.replace(/\/+$/, "") };
  }
  const searchProvider = plugin.searchProvider || "deepseek";
  const fetchProvider = plugin.fetchProvider ?? (searchProvider === "deepseek" ? "deepseek" : "");
  if (!["deepseek", "openai"].includes(searchProvider) || !["", "deepseek"].includes(fetchProvider)) {
    throw new Error("web-search provider 配置无效；openai 不提供独立网页原文 Fetch");
  }
  if (plugin.enabled === true) {
    for (const name of new Set([searchProvider, fetchProvider].filter(Boolean))) {
      if (!providers[name]?.apiKey?.trim()) throw new Error(`请配置 web-search.providers.${name}.apiKey`);
      if (name === "openai" && !providers[name].model?.trim()) throw new Error("请配置 web-search.providers.openai.model（支持 web_search 的模型）");
    }
  }
  return { ...plugin, searchProvider, fetchProvider, providers,
    timeoutMs: number(plugin.timeoutMs, 60000, 1000, 300000, "web-search.timeoutMs"),
    maxRetries: number(plugin.maxRetries, 1, 0, 3, "web-search.maxRetries"),
    maxResults: number(plugin.maxResults, 5, 1, 50, "web-search.maxResults"),
    maxContentChars: number(plugin.maxContentChars, 16000, 1000, 100000, "web-search.maxContentChars"),
    maxConcurrent: number(plugin.maxConcurrent, 2, 1, 8, "web-search.maxConcurrent"),
    maxPending: number(plugin.maxPending, 16, 1, 128, "web-search.maxPending"),
    maxRequestsPerChain: number(plugin.maxRequestsPerChain, 4, 1, 20, "web-search.maxRequestsPerChain"),
    observationTtlMs: number(plugin.observationTtlMs, 300000, 1000, 86400000, "web-search.observationTtlMs"),
  };
}

module.exports = { normalizeOptions, getOptions: (config) => normalizeOptions(getPlugin(config, "web-search") || {}) };
