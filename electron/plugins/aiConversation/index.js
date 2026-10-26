const { createChatService } = require("./chat");

function activate(context) {
  const chat = createChatService({
    getConfig: context.config.get,
    getExpressions: context.pet.getExpressions,
    logger: context.logger,
  });
  const controllers = new Set();
  const tasks = new Set();
  let running = true;
  let disposed = false;

  function request(operation, externalSignal) {
    if (!running || disposed) return Promise.reject(new Error("AI 对话插件已停止"));
    const controller = new AbortController();
    const signal = externalSignal
      ? AbortSignal.any([controller.signal, externalSignal]) : controller.signal;
    controllers.add(controller);
    const task = Promise.resolve().then(async () => {
      signal.throwIfAborted();
      const result = await operation(signal);
      signal.throwIfAborted();
      return result;
    }).finally(() => { controllers.delete(controller); tasks.delete(task); });
    tasks.add(task);
    return task;
  }

  const unregisterText = context.services.register("text", (messages, options = {}) =>
    request((signal) => chat.callChatCompletions(messages, { ...options, signal }), options.signal));
  const unregisterDecision = context.decisions.register(({ observations, context: blocks, signal }) =>
    request((requestSignal) => chat.decideFromObservations(observations, {
      context: blocks, signal: requestSignal,
    }), signal));

  function stop() {
    running = false;
    for (const controller of controllers) controller.abort();
    return Promise.allSettled([...tasks]);
  }

  return {
    start() { if (!disposed) running = true; },
    stop,
    dispose() {
      disposed = true;
      unregisterDecision();
      unregisterText();
      return stop();
    },
  };
}

module.exports = { activate };
