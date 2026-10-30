function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    function abort() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal.reason);
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function isRetryableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

function isRetryableError(err) {
  if (!err) return false;
  if (typeof err.retryable === "boolean") return err.retryable;
  const msg = String(err.message || err);
  if (/非 JSON|ERR_|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket|network|fetch failed/i.test(msg)) {
    return true;
  }
  if (typeof err.status === "number") return isRetryableStatus(err.status);
  return false;
}

function messageContentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part.text === "string") return part.text;
        return "";
      })
      .join("");
  }
  return "";
}

module.exports = { sleep, isRetryableStatus, isRetryableError, messageContentToText };
