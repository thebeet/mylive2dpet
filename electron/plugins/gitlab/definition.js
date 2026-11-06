const { isPluginEnabled } = require("../registry");
const { number, object } = require("../../architecture/configValidation");

const STATUSES = ["created", "waiting_for_resource", "preparing", "pending", "running", "success",
  "failed", "canceled", "skipped", "manual", "scheduled"];

function normalizeOptions(plugin = {}) {
  const allowed = ["name", "enabled", "baseUrl", "token", "tokenEnv", "proxy", "projects", "interval_ms",
    "timeoutMs", "observationTtlMs", "emitOnFirstFetch", "lookbackMs", "maxPages", "maxResponseBytes"];
  for (const key of Object.keys(plugin)) {
    if (!allowed.includes(key) && !key.startsWith("_")) throw new Error(`不支持的 GitLab 配置字段: ${key}`);
  }
  let url;
  try { url = new URL(plugin.baseUrl || "https://gitlab.com"); } catch { throw new Error("gitlab.baseUrl 无效"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("gitlab.baseUrl 必须是无账号密码、查询参数和片段的 HTTP(S) 实例地址");
  }
  for (const key of ["token", "tokenEnv", "proxy"]) {
    if (plugin[key] != null && typeof plugin[key] !== "string") throw new Error(`gitlab.${key} 必须是字符串`);
  }
  if (plugin.token && plugin.tokenEnv) throw new Error("gitlab.token 和 tokenEnv 只能配置一个");
  if (plugin.token && /[\r\n]/.test(plugin.token)) throw new Error("gitlab.token 无效");
  const tokenEnv = plugin.tokenEnv?.trim() || "";
  if (tokenEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv)) throw new Error("gitlab.tokenEnv 无效");
  const proxy = plugin.proxy?.trim() || "";
  if (proxy) {
    let parsed;
    try { parsed = new URL(proxy); } catch { throw new Error("gitlab.proxy 无效"); }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new Error("gitlab.proxy 必须是无账号密码的 HTTP(S) 地址");
    }
  }
  if (plugin.emitOnFirstFetch != null && typeof plugin.emitOnFirstFetch !== "boolean") {
    throw new Error("gitlab.emitOnFirstFetch 必须是布尔值");
  }
  if (plugin.projects != null && !Array.isArray(plugin.projects)) throw new Error("gitlab.projects 必须是数组");
  const seen = new Set();
  const projects = (plugin.projects || []).map(input => {
    const entry = typeof input === "string" || typeof input === "number" ? { id: input } : input;
    if (!object(entry) || Object.keys(entry).some(key => !["id", "name", "ref", "statuses"].includes(key))) {
      throw new Error("GitLab 项目仅支持 id、name、ref、statuses 字段");
    }
    if (!(typeof entry.id === "string" && entry.id.trim()) &&
        !(Number.isSafeInteger(entry.id) && entry.id > 0)) throw new Error("GitLab 项目 id 必须是正整数或项目路径");
    for (const key of ["name", "ref"]) {
      if (entry[key] != null && typeof entry[key] !== "string") throw new Error(`GitLab 项目 ${key} 必须是字符串`);
    }
    const id = String(entry.id).trim(), ref = entry.ref?.trim() || "";
    const identity = JSON.stringify([id, ref]);
    if (seen.has(identity)) throw new Error("GitLab 项目和分支配置重复");
    seen.add(identity);
    if (entry.statuses != null && (!Array.isArray(entry.statuses) ||
        entry.statuses.some(status => !STATUSES.includes(status)))) throw new Error("GitLab 项目 statuses 包含无效状态");
    return { id, name: entry.name?.trim() || "", ref, statuses: [...new Set(entry.statuses || [])].sort() };
  });
  return { ...plugin, baseUrl: url.href.replace(/\/+$/, ""), token: plugin.token?.trim() || "", tokenEnv, proxy, projects,
    interval_ms: number(plugin.interval_ms, 60000, 1000, 86400000, "gitlab.interval_ms"),
    timeoutMs: number(plugin.timeoutMs, 20000, 1000, 300000, "gitlab.timeoutMs"),
    observationTtlMs: number(plugin.observationTtlMs, 0, 0, 86400000, "gitlab.observationTtlMs"),
    emitOnFirstFetch: plugin.emitOnFirstFetch === true,
    lookbackMs: number(plugin.lookbackMs, 604800000, 60000, 31536000000, "gitlab.lookbackMs"),
    maxPages: number(plugin.maxPages, 20, 1, 1000, "gitlab.maxPages"),
    maxResponseBytes: number(plugin.maxResponseBytes, 2097152, 1024, 20971520, "gitlab.maxResponseBytes"),
  };
}

module.exports = { name: "gitlab", requires: ["storage"], normalizeOptions,
  shouldLoad: config => isPluginEnabled(config, "gitlab"), load: () => require("./index") };
