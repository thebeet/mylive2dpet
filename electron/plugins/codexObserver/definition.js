const os = require("node:os");
const path = require("node:path");
const { isPluginEnabled } = require("../registry");
const { number } = require("../../architecture/configValidation");

function normalizeOptions(plugin = {}) {
  const allowed = ["name", "enabled", "sessionsDir", "projects", "interval_ms", "observationTtlMs"];
  for (const key of Object.keys(plugin)) {
    if (!allowed.includes(key) && !key.startsWith("_")) throw new Error(`不支持的 Codex 观察配置字段: ${key}`);
  }
  if (plugin.sessionsDir != null && (typeof plugin.sessionsDir !== "string" || !plugin.sessionsDir.trim())) {
    throw new Error("codex-observer.sessionsDir 必须是非空路径");
  }
  if (plugin.projects != null && (!Array.isArray(plugin.projects) ||
      plugin.projects.some(value => typeof value !== "string" || !value.trim()))) {
    throw new Error("codex-observer.projects 必须是项目路径数组");
  }
  const expand = value => path.resolve(value === "~" ? os.homedir() :
    value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value);
  return { ...plugin,
    sessionsDir: expand(plugin.sessionsDir || path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions")),
    projects: [...new Set((plugin.projects || []).map(expand))],
    interval_ms: number(plugin.interval_ms, 2000, 250, 86400000, "codex-observer.interval_ms"),
    observationTtlMs: number(plugin.observationTtlMs, 0, 0, 86400000, "codex-observer.observationTtlMs"),
  };
}

module.exports = { name: "codex-observer", requires: ["storage"], normalizeOptions,
  shouldLoad: config => isPluginEnabled(config, "codex-observer"), load: () => require("./index") };
