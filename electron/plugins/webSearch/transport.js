const { withTimeout } = require("../../llm/timeout");
const { sleep } = require("../../llm/retry");

function createTransport(config, options, { fetchImpl, configureProxy, retryWait = sleep, diagnostics = () => {}, providerName } = {}) {
  const getSession = () => require("electron").session.fromPartition(`web-search:${config.endpoint}`);
  const fetchJson = fetchImpl || ((url, init) => getSession().fetch(url, init));
  let ready;
  function prepare() {
    if (!ready) ready = Promise.resolve().then(() => configureProxy ? configureProxy(config.proxy || "")
      : fetchImpl ? undefined : getSession().setProxy(config.proxy
        ? { proxyRules: config.proxy, proxyBypassRules: "<local>" } : { mode: "direct" }))
      .catch((error) => { ready = null; throw error; });
    return ready;
  }
  const redact = (text) => config.apiKey ? String(text).split(config.apiKey).join("[redacted]") : String(text);
  return async function post(path, body, { signal, requestId } = {}) {
    if (!config.apiKey?.trim()) throw new Error("网页 provider 缺少 apiKey");
    return withTimeout(async (requestSignal) => {
      await prepare();
      for (let attempt = 0; ; attempt++) {
        requestSignal.throwIfAborted();
        const startedAt = Date.now();
        const detail = { requestId, provider: providerName, apiUrl: `${config.endpoint}${path}`, attempt: attempt + 1 };
        try {
          diagnostics("http.start", detail);
          const response = await fetchJson(`${config.endpoint}${path}`, {
            method: "POST", signal: requestSignal, redirect: "error",
            headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${config.apiKey}` },
            body: JSON.stringify(body),
          });
          const raw = await response.text();
          requestSignal.throwIfAborted();
          diagnostics("http.response", { ...detail, status: response.status, elapsedMs: Date.now() - startedAt,
            responseChars: raw.length });
          if (!response.ok) {
            throw Object.assign(new Error(`网页 API HTTP ${response.status}`), {
              status: response.status, retryable: [408, 429].includes(response.status) || response.status >= 500,
            });
          }
          try { return JSON.parse(raw); }
          catch { throw new Error("网页 API 返回无效 JSON"); }
        } catch (error) {
          if (requestSignal.aborted) {
            diagnostics("http.cancelled", { ...detail, elapsedMs: Date.now() - startedAt });
            throw requestSignal.reason;
          }
          const retryable = error.retryable === true || error instanceof TypeError;
          diagnostics("http.failed", { ...detail, status: error.status, elapsedMs: Date.now() - startedAt,
            error: redact(error.message), retryable, willRetry: retryable && attempt < options.maxRetries }, "warn");
          if (!retryable || attempt >= options.maxRetries) {
            error.message = redact(error.message);
            throw error;
          }
          await retryWait(500 * (attempt + 1), requestSignal);
        }
      }
    }, { signal, timeoutMs: options.timeoutMs, label: "网页请求" });
  };
}

module.exports = { createTransport };
