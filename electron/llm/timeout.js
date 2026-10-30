/** Bound both network calls and complete retry operations, including body reads. */
async function withTimeout(operation, { signal, timeoutMs, label = "AI request" }) {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let timer;
  let abort;
  const deadline = new Promise((resolve, reject) => {
    abort = () => reject(combined.reason);
    combined.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => {
      const error = new Error(`${label} 超时（${timeoutMs}ms）`);
      error.code = "AI_TIMEOUT";
      error.retryable = true;
      controller.abort(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(() => { combined.throwIfAborted(); return operation(combined); }), deadline]);
  } finally {
    clearTimeout(timer);
    combined.removeEventListener("abort", abort);
  }
}

module.exports = { withTimeout };
