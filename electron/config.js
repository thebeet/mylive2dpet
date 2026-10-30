const fs = require("fs");
const path = require("path");
const { isDeepStrictEqual } = require("node:util");
const { getOptions: conversationOptions } = require("./conversation/options");
const pluginDefinitions = require("./plugins/manifest");
const { object, dictionary, number, freeze } = require("./architecture/configValidation");

const CONFIG_PATH = path.join(__dirname, "../config.json");
/** Validate current configuration and fill plugin defaults. */
function normalizeConfig(input) {
  if (!object(input)) throw new Error("配置根节点必须是对象");
  for (const key of Object.keys(input)) {
    if (!["ui", "conversation", "decision", "observations", "plugins"].includes(key) && !key.startsWith("_")) {
      throw new Error(`不支持的配置根字段: ${key}，功能配置请放入 plugins`);
    }
  }
  for (const key of ["ui", "conversation", "decision", "observations"]) dictionary(input[key], key);
  if (input.plugins != null && !Array.isArray(input.plugins)) throw new Error("plugins 必须是数组");
  const plugins = new Map();
  const pluginNames = new Set(pluginDefinitions.map(({ name }) => name));
  for (const plugin of input.plugins || []) {
    if (!object(plugin) || typeof plugin.name !== "string" || !plugin.name.trim()) throw new Error("插件必须有非空名称");
    if (!pluginNames.has(plugin.name)) throw new Error(`不支持的插件: ${plugin.name}`);
    if (plugins.has(plugin.name)) throw new Error(`插件名称重复: ${plugin.name}`);
    if (plugin.enabled != null && typeof plugin.enabled !== "boolean") throw new Error(`plugins.${plugin.name}.enabled 必须是布尔值`);
    plugins.set(plugin.name, { ...plugin });
  }
  const conversation = conversationOptions(input);
  if (input.decision?.enabled != null && typeof input.decision.enabled !== "boolean") throw new Error("decision.enabled 必须是布尔值");
  for (const definition of pluginDefinitions) {
    const plugin = plugins.get(definition.name);
    if (!plugin && !definition.defaultConfig) continue;
    const normalized = definition.normalizeOptions?.(plugin) || plugin;
    plugins.set(definition.name, { ...plugin, ...normalized, name: definition.name });
  }
  const decision = { ...input.decision };
  for (const key of Object.keys(decision)) {
    if (!["enabled", "interval_ms"].includes(key) && !key.startsWith("_")) {
      throw new Error(`不支持的决策配置字段: ${key}`);
    }
  }
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
  return freeze({ ...input, plugins: [...plugins.values()], conversation, decision, observations });
}

function createConfigStore(filePath, { logger = console, checkIntervalMs = 1000, changeDebounceMs = 100 } = {}) {
  let cached = null;
  let stamp = null;
  let checkedAt = 0;
  let lastError = null;
  let watcher = null;
  let reloadTimer = null;
  const listeners = new Set();
  function load({ force = false } = {}) {
    const now = Date.now();
    if (cached && !force && (watcher || now - checkedAt < checkIntervalMs)) return cached;
    checkedAt = now;
    const previous = cached;
    try {
      const stat = fs.statSync(filePath);
      const nextStamp = `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
      if (cached && !force && nextStamp === stamp) return cached;
      let parsed;
      try { parsed = JSON.parse(fs.readFileSync(filePath, "utf8")); }
      catch { throw new Error("配置文件无法读取或 JSON 格式无效"); }
      const next = normalizeConfig(parsed);
      const changed = cached && !isDeepStrictEqual(cached, next);
      if (!cached || changed) cached = next;
      stamp = nextStamp;
      lastError = null;
      if (watcher && changed) logger.info?.("[config] config.json 已更新，已加载新配置");
    } catch (error) {
      const message = error.code ? "配置文件无法读取" : error.message;
      if (!cached) throw new Error(message);
      if (lastError !== message) logger.warn(`[config] ${message}，继续使用上次有效配置`);
      lastError = message;
    }
    if (previous && cached !== previous) {
      for (const listener of listeners) {
        try {
          Promise.resolve(listener(cached, previous)).catch((error) =>
            logger.error?.("[config] 配置更新处理失败:", error));
        } catch (error) { logger.error?.("[config] 配置更新处理失败:", error); }
      }
    }
    return cached;
  }
  function onFileChange(_event, filename) {
    if (filename != null && String(filename) !== path.basename(filePath)) return;
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => {
      reloadTimer = null;
      load({ force: true });
    }, changeDebounceMs);
    reloadTimer.unref();
  }
  function stopWatching() {
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = null;
    watcher?.close();
    watcher = null;
  }
  function startWatching() {
    if (watcher) return stopWatching;
    load({ force: true });
    // Watch the directory so an editor's atomic rename does not detach the watcher.
    watcher = fs.watch(path.dirname(filePath), { persistent: false }, onFileChange);
    watcher.on("error", (error) => {
      stopWatching();
      logger.warn(`[config] 配置监听失败: ${error.message}`);
    });
    return stopWatching;
  }
  function subscribe(listener) {
    if (typeof listener !== "function") throw new TypeError("config listener must be a function");
    listeners.add(listener);
    return () => listeners.delete(listener);
  }
  return { load, startWatching, stopWatching, subscribe,
    getStatus: () => ({ loaded: Boolean(cached), error: lastError }) };
}
const store = createConfigStore(CONFIG_PATH);
module.exports = { CONFIG_PATH, loadConfig: store.load, startConfigWatcher: store.startWatching,
  stopConfigWatcher: store.stopWatching, subscribeConfig: store.subscribe, normalizeConfig, createConfigStore };
