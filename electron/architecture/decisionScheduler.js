/** Serial decision requests with cancellable waiters and one automatic timer. */
function createDecisionScheduler({ execute, getPolicy = () => ({}), hasPendingUser = () => false, logger = console }) {
  const pending = new Map();
  let running = true;
  let automatic = false;
  let timer = null;
  let current = null;
  let controller = new AbortController();
  let disposed = false;

  function clearTimer() { if (timer) clearTimeout(timer); timer = null; }

  function schedule(initial = false) {
    clearTimer();
    const policy = getPolicy();
    if (!running || !automatic || policy.enabled === false || policy.interval_ms < 0) return;
    const wait = initial ? 8000 : Math.max(1000, Number(policy.interval_ms) || 0);
    timer = setTimeout(() => {
      timer = null;
      void request({ trigger: initial ? "startup" : "interval", waitForIdle: false })
        .catch((error) => { if (running) logger.error("automatic decision failed:", error); });
    }, wait);
  }

  function pump() {
    if (current || !running || pending.size === 0) return;
    clearTimer();
    const [trigger, waiters] = pending.entries().next().value;
    pending.delete(trigger);
    for (const waiter of waiters) waiter.cleanup();
    const signal = controller.signal;
    const task = Promise.resolve().then(() => {
      signal.throwIfAborted();
      return execute({ trigger, signal });
    }).then(
      (result) => { for (const waiter of waiters) waiter.resolve(result); },
      (error) => { for (const waiter of waiters) waiter.reject(error); },
    ).finally(() => {
      if (current === task) current = null;
      if (pending.size) pump();
      else if (running && hasPendingUser()) {
        void request({ trigger: "pending-user-input" }).catch((error) => {
          if (running) logger.error("pending user decision failed:", error);
        });
      }
      else schedule();
    });
    current = task;
  }

  function request({ trigger = "manual", signal, waitForIdle = true, waitTimeoutMs = 120000 } = {}) {
    if (disposed || !running) return Promise.reject(new Error("决策调度已停止"));
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (current && !waitForIdle) return Promise.resolve({ skipped: "busy" });
    return new Promise((resolve, reject) => {
      const waiters = pending.get(trigger) || [];
      let timeout;
      const waiter = { resolve, reject, cleanup() {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
      } };
      function remove(error) {
        waiter.cleanup();
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        if (!waiters.length && pending.get(trigger) === waiters) pending.delete(trigger);
        reject(error);
      }
      function abort() { remove(signal.reason); }
      timeout = setTimeout(() => remove(new Error("等待当前决策结束超时")), waitTimeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      waiters.push(waiter);
      pending.set(trigger, waiters);
      pump();
    });
  }

  function start() {
    if (disposed) return;
    if (!running) controller = new AbortController();
    running = true;
    automatic = true;
    if (hasPendingUser()) {
      void request({ trigger: "resume-user-input" }).catch((error) => {
        if (running) logger.error("resumed user decision failed:", error);
      });
    } else schedule(true);
  }

  function stop() {
    running = false;
    automatic = false;
    clearTimer();
    controller.abort();
    for (const waiters of pending.values()) {
      for (const waiter of waiters) { waiter.cleanup(); waiter.reject(controller.signal.reason); }
    }
    pending.clear();
    return current || Promise.resolve();
  }

  return { request, start, stop,
    dispose() { disposed = true; return stop(); },
    getState: () => ({ running, busy: Boolean(current), pending: pending.size }) };
}

module.exports = { createDecisionScheduler };
