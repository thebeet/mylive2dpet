const path = require("path");
const { randomUUID } = require("crypto");
const { withTimeout } = require("./timeout");
const { createRotatingLog } = require("./log");
const { sleep, isRetryableError, isRetryableStatus, messageContentToText } = require("./retry");

/** Shared Chat Completions client; receives model settings without plugin dependencies. */
function createModelClient({ getOptions, logger = console, fetchImpl, writeLog, onRequest, onResult, configureProxy }) {
  function getNetworkSession() {
    return require("electron").session.fromPartition("conversation");
  }
  const fetchChat = fetchImpl || ((url, init) => getNetworkSession().fetch(url, init));
  function normalizeEndpoint(endpoint) {
    const base = String(endpoint || "").replace(/\/+$/, "");
    if (base.endsWith("/chat/completions")) return base;
    return `${base}/chat/completions`;
  }

  async function applyProxy(proxy) {
    if (configureProxy) return configureProxy(proxy);
    if (!proxy) {
      await getNetworkSession().setProxy({ mode: "direct" });
      return;
    }
    await getNetworkSession().setProxy({
      proxyRules: proxy,
      proxyBypassRules: "<local>",
    });
  }

  const MAX_RETRIES = 3;
  const RETRY_BASE_MS = 800;
  const OPENAI_LOG_PATH = path.join(__dirname, "../../logs/openai.jsonl");
  const appendLog = writeLog || createRotatingLog(OPENAI_LOG_PATH);
  const sessionId = randomUUID();

  async function notifyLog(observer, entry) {
    try { await observer?.(entry); }
    catch (error) { logger.warn("[ai:raw-log] record failed:", error.message); }
  }

  function appendOpenAiLog(entry) {
    try {
      appendLog(entry);
    } catch (err) {
      logger.warn(
        "[ai:log] write failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  /**
   * @param {string} url
   * @param {RequestInit} init
   * @param {{ maxRetries?: number, label?: string, timeoutMs?: number }} [opts]
   */
  async function fetchChatJson(url, init, opts = {}) {
    const maxRetries =
      Number.isFinite(opts.maxRetries) && opts.maxRetries >= 0
        ? Math.floor(opts.maxRetries)
        : MAX_RETRIES;
    const label = opts.label || "api";
    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let requestId;
      let startedAt;
      let status = null;
      let response = null;
      try {
        init.signal?.throwIfAborted();
        const ai = getOptions();
        const { res, text } = await withTimeout(async (signal) => {
          signal.throwIfAborted();
          requestId = randomUUID();
          startedAt = Date.now();
          await notifyLog(onRequest, { id: requestId, sessionId, t: startedAt,
            label, request: JSON.parse(init.body) });
          signal.throwIfAborted();
          const res = await fetchChat(url, { ...init, signal });
          status = res.status;
          const text = await res.text();
          response = text;
          signal.throwIfAborted();
          return { res, text };
        }, { signal: init.signal, timeoutMs: Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : Number(ai.timeoutMs) || 120000 });
        init.signal?.throwIfAborted();
        let data;
        try {
          data = JSON.parse(text);
        } catch {
          appendOpenAiLog({
            t: new Date().toISOString(),
            label,
            ok: false,
            status: res.status,
            body: text.slice(0, 4000),
          });
          const err = new Error(
            `API 返回非 JSON (${res.status}): ${text.slice(0, 200)}`,
          );
          err.status = res.status;
          err.retryable = isRetryableStatus(res.status);
          throw err;
        }
        if (!res.ok) {
          appendOpenAiLog({
            t: new Date().toISOString(),
            label,
            ok: false,
            status: res.status,
            body: data,
          });
          const err = new Error(
            `API ${res.status}: ${data?.error?.message || text.slice(0, 200)}`,
          );
          err.status = res.status;
          throw err;
        }
        appendOpenAiLog({
          t: new Date().toISOString(),
          label,
          ok: true,
          status: res.status,
          content: messageContentToText(
            data?.choices?.[0]?.message?.content,
          ).trim(),
          body: data,
        });
        await notifyLog(onResult, { id: requestId, status, response: data,
          finishedAt: Date.now(), error: "" });
        return data;
      } catch (err) {
        if (requestId) await notifyLog(onResult, { id: requestId, status, response,
          finishedAt: Date.now(), error: String(err?.message || err) });
        if (init.signal?.aborted) throw err;
        lastError = err;
        const canRetry = attempt < maxRetries && isRetryableError(err);
        if (!canRetry) throw err;
        const delay = RETRY_BASE_MS * (attempt + 1);
        logger.warn(
          `[${label}] attempt ${attempt + 1}/${maxRetries + 1} failed, retry in ${delay}ms:`,
          err instanceof Error ? err.message : err,
        );
        await sleep(delay, init.signal);
      }
    }

    throw lastError;
  }

  /**
   * Lightweight text-only chat/completions call (memory summary / extract).
   * Uses current config endpoint; does not touch short-term memory.
   * @param {object[]} messages
   * @param {{ max_tokens?: number, temperature?: number, signal?: AbortSignal, timeoutMs?: number, retryBudgetMs?: number, maxRetries?: number }} [opts]
   */
  async function callChatCompletions(messages, opts = {}) {
    opts.signal?.throwIfAborted();
    const ai = getOptions();
    const maxTokens =
      Number(opts.max_tokens) > 0
        ? Number(opts.max_tokens)
        : Number(ai.max_tokens) > 0
          ? Number(ai.max_tokens)
          : 256;

    const body = {
      model: ai.model,
      temperature:
        typeof opts.temperature === "number" ? opts.temperature : 0.3,
      max_tokens: maxTokens,
      stream: false,
      messages,
    };

    const data = await complete(body, { ...opts, label: "ai:text" });

    const choice = data?.choices?.[0];
    const text = messageContentToText(choice?.message?.content).trim();
    if (choice?.finish_reason === "length" || !text) {
      const reason = choice?.finish_reason || "unknown";
      const usage = data?.usage;
      const details = `model=${data?.model || ai.model}, finish_reason=${reason}, max_tokens=${maxTokens}, ` +
        `completion_tokens=${usage?.completion_tokens ?? "unknown"}, reasoning_tokens=${usage?.completion_tokens_details?.reasoning_tokens ?? "unknown"}`;
      throw new Error(`${reason === "length" ? "AI 文本输出达到 token 上限，内容不完整；请增大 maxTokens" : "AI 文本接口返回空正文"}（${details}）`);
    }
    return text;
  }

  async function complete(body, opts = {}) {
    opts.signal?.throwIfAborted();
    const ai = getOptions();
    if (!ai?.endpoint || !ai?.apiKey || !ai?.model) {
      throw new Error("请配置 conversation.ai.endpoint / apiKey / model");
    }
    await applyProxy(ai.proxy);
    opts.signal?.throwIfAborted();
    return fetchChatJson(normalizeEndpoint(ai.endpoint), {
      method: "POST", signal: opts.signal,
      headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${ai.apiKey}` },
      body: JSON.stringify(body),
    }, opts);
  }

  function withBudget(operation, { signal, retryBudgetMs } = {}) {
    const ai = getOptions();
    return withTimeout(operation, { signal,
      timeoutMs: Number(retryBudgetMs) > 0 ? Number(retryBudgetMs) : Number(ai.retryBudgetMs) || 360000,
      label: "AI 整轮请求" });
  }

  return { complete, withBudget,
    generateText: (messages, options = {}) => withBudget(
      (signal) => callChatCompletions(messages, { ...options, signal }), options),
  };
}

module.exports = { createModelClient };
