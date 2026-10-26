function retryable(error) {
  if (typeof error?.retryable === "boolean") return error.retryable;
  if (typeof error?.status === "number") {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  return /ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket|network|fetch failed/i.test(String(error?.message || ""));
}

function observationError(message, observationId, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.observationId = observationId;
  error.retryable = false;
  return error;
}

module.exports = { retryable, observationError };
