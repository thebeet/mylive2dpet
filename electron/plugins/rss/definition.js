const { isPluginEnabled } = require("../registry");
const { number } = require("../../architecture/configValidation");

function feedUrl(value) {
  if (typeof value !== "string") throw new Error("RSS 订阅地址必须是字符串");
  let url;
  try { url = new URL(value); } catch { throw new Error("RSS 订阅地址无效"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("RSS 订阅地址必须是无账号密码的 HTTP(S) 地址");
  }
  url.hash = "";
  return url.href;
}

function normalizeOptions(plugin = {}) {
  const allowed = ["name", "enabled", "feeds", "interval_ms", "timeoutMs", "observationTtlMs",
    "emitOnFirstFetch", "maxContentChars", "maxResponseBytes"];
  for (const key of Object.keys(plugin)) {
    if (!allowed.includes(key) && !key.startsWith("_")) throw new Error(`不支持的 RSS 配置字段: ${key}`);
  }
  if (plugin.emitOnFirstFetch != null && typeof plugin.emitOnFirstFetch !== "boolean") {
    throw new Error("rss.emitOnFirstFetch 必须是布尔值");
  }
  if (plugin.feeds != null && !Array.isArray(plugin.feeds)) throw new Error("rss.feeds 必须是数组");
  const urls = new Set();
  const feeds = (plugin.feeds || []).map((input) => {
    if (typeof input !== "string" && (!input || typeof input !== "object" || Array.isArray(input))) {
      throw new Error("RSS 订阅源必须是地址或 {url, name, proxy, interval_ms} 对象");
    }
    if (typeof input === "object" && Object.keys(input).some(key => !["url", "name", "proxy", "interval_ms"].includes(key))) {
      throw new Error("RSS 订阅源仅支持 url、name、proxy 和 interval_ms 字段");
    }
    if (typeof input === "object" && input.name != null && typeof input.name !== "string") {
      throw new Error("RSS 订阅源名称必须是字符串");
    }
    const url = feedUrl(typeof input === "string" ? input : input.url);
    if (urls.has(url)) throw new Error("RSS 订阅地址重复");
    urls.add(url);
    if (typeof input === "object" && input.proxy != null && typeof input.proxy !== "string") {
      throw new Error("rss.feeds[].proxy 必须是字符串");
    }
    const proxy = typeof input === "object" ? input.proxy?.trim() || "" : "";
    if (proxy) feedUrl(proxy);
    return { url, name: typeof input === "object" ? (input.name || "").trim() : "", proxy,
      ...(typeof input === "object" && input.interval_ms != null ? {
        interval_ms: number(input.interval_ms, 300000, 1000, 86400000, "rss.feeds[].interval_ms"),
      } : {}),
    };
  });
  return { ...plugin, feeds,
    interval_ms: number(plugin.interval_ms, 300000, 1000, 86400000, "rss.interval_ms"),
    timeoutMs: number(plugin.timeoutMs, 20000, 1000, 300000, "rss.timeoutMs"),
    observationTtlMs: number(plugin.observationTtlMs, 0, 0, 86400000, "rss.observationTtlMs"),
    emitOnFirstFetch: plugin.emitOnFirstFetch === true,
    maxContentChars: number(plugin.maxContentChars, 12000, 100, 100000, "rss.maxContentChars"),
    maxResponseBytes: number(plugin.maxResponseBytes, 2097152, 1024, 20971520, "rss.maxResponseBytes"),
  };
}

module.exports = { name: "rss", requires: ["storage"], normalizeOptions,
  shouldLoad: config => isPluginEnabled(config, "rss"), load: () => require("./index") };
