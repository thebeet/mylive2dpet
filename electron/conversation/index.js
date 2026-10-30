const { isDeepStrictEqual } = require("node:util");
const { createModelClient } = require("../llm/client");
const { createConversationPolicy } = require("./decision");
const { getOptions } = require("./options");
const { createContextProviders } = require("../architecture/contextProviders");
const { createConversationHistory } = require("./history");
const EVENTS = require("../architecture/events");

/** Application-owned conversation and model lifetime, independent of plugin loading. */
function createConversation({ getConfig, getExpressions, contextProviders = createContextProviders(), bus,
  logger = console, ...dependencies }) {
  let options = getOptions(getConfig());
  let session = createSession(options);
  let running = true;
  let disposed = false;
  let revision = 0;
  let updates = 0;
  let lifecycle = Promise.resolve();
  const controllers = new Set();
  const decisionControllers = new Set();
  const tasks = new Set();
  const listeners = new Set();

  function createSession(snapshot) {
    const client = createModelClient({ ...dependencies, logger, getOptions: () => snapshot.ai });
    const policy = createConversationPolicy({ client, getOptions: () => snapshot,
      getExpressions, logger, encodeImage: dependencies.encodeImage, retryWait: dependencies.retryWait });
    const history = createConversationHistory({ options: () => snapshot.history, client, logger });
    return { client, policy, history, decisionQueue: Promise.resolve(), contextRevision: contextProviders.getRevision?.() };
  }

  function notify() {
    for (const listener of [...listeners]) {
      try { listener(); }
      catch (error) { logger.warn("[conversation] observer failed:", error); }
    }
  }

  function isAvailable() {
    return running && !disposed && !updates && options.enabled &&
      Boolean(options.ai.endpoint && options.ai.apiKey && options.ai.model);
  }

  function request(operation, externalSignal, decision = false) {
    if (externalSignal?.aborted) return Promise.reject(externalSignal.reason);
    if (disposed || !running) return Promise.reject(new Error("对话核心已停止"));
    if (updates) return Promise.reject(Object.assign(new Error("AI 配置正在更新"), { retryable: true }));
    if (!options.enabled) return Promise.reject(new Error("对话核心已关闭"));
    const controller = new AbortController();
    const signal = externalSignal ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal;
    const snapshot = session;
    controllers.add(controller);
    if (decision) decisionControllers.add(controller);
    const task = Promise.resolve().then(async () => {
      signal.throwIfAborted();
      const result = await operation(snapshot, signal);
      signal.throwIfAborted();
      return result;
    }).finally(() => { controllers.delete(controller); decisionControllers.delete(controller); tasks.delete(task); });
    tasks.add(task);
    return task;
  }

  function cancel(reason) {
    for (const controller of controllers) controller.abort(reason);
    return Promise.allSettled([...tasks]);
  }

  // An optional extension may ignore cancellation; it must not hold shutdown open.
  async function collectContext(input) {
    const { signal } = input;
    signal.throwIfAborted();
    let abort;
    const cancelled = new Promise((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
    });
    try { return await Promise.race([contextProviders.collect(input), cancelled]); }
    finally { signal.removeEventListener("abort", abort); }
  }

  function reconfigure(config) {
    const next = getOptions(config);
    if (!updates && isDeepStrictEqual(next, options)) return Promise.resolve();
    updates++;
    const operation = lifecycle.then(async () => {
      if (disposed) return;
      revision++;
      notify();
      await cancel(new Error("AI 配置已更新，旧请求已取消"));
      if (disposed) return;
      options = next;
      session = createSession(next);
    }).finally(() => { updates--; if (!disposed) notify(); });
    lifecycle = operation.catch(() => {});
    return operation;
  }

  function stop() {
    running = false;
    revision++;
    notify();
    return cancel();
  }

  function clearHistory() {
    session.history.reset();
    for (const controller of decisionControllers) controller.abort(new Error("记忆已清空，旧对话请求已取消"));
  }
  const unsubscribeClear = bus?.subscribe(EVENTS.MEMORY_CLEARED, clearHistory) || (() => {});

  const model = {
    generateText: (messages, settings = {}) => request(
      ({ client }, signal) => client.generateText(messages, { ...settings, signal }), settings.signal),
    isAvailable,
    getRevision: () => revision,
    subscribe(listener) {
      if (typeof listener !== "function") throw new TypeError("model observer must be a function");
      if (disposed) throw new Error("对话核心已卸载");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  return {
    model, generateText: model.generateText, reconfigure, stop,
    clearHistory,
    decideFromObservations: (observations, settings = {}) => request((snapshot, signal) => {
      const task = snapshot.decisionQueue.then(async () => {
        signal.throwIfAborted();
        const currentRevision = contextProviders.getRevision?.();
        if (snapshot.contextRevision !== currentRevision) {
          snapshot.history.reset();
          snapshot.contextRevision = currentRevision;
        }
        const refreshContext = () => settings.context ?? collectContext({ observations,
          trigger: settings.trigger, signal, conversationHistory: true });
        const context = snapshot.history.needsContext() ? await refreshContext() : [];
        signal.throwIfAborted();
        return snapshot.policy.decideFromObservations(observations, { ...settings, context, signal,
          history: snapshot.history, refreshContext });
      });
      snapshot.decisionQueue = task.catch(() => {});
      return task;
    }, settings.signal, true),
    start() { if (!disposed && !running) { running = true; revision++; notify(); } },
    dispose() { disposed = true; unsubscribeClear(); const done = stop(); listeners.clear(); return Promise.all([done, lifecycle]); },
  };
}

module.exports = { createConversation };
