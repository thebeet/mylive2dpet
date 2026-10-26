const path = require("path");
const { buildSystemPrompt } = require("./prompt");
const { extractChatPayload } = require("./parseChatText");
const { getOptions } = require("./options");
const { buildRequestBody, prepareObservations } = require("./request");
const { withTimeout } = require("./timeout");
const { createRotatingLog } = require("./log");

/** Provider implementation; host services are injected during activation. */
function createChatService({ getConfig, getExpressions, logger = console,
  fetchImpl,
  encodeImage,
  writeLog,
  configureProxy = null,
}) {
  function getNetworkSession() {
    return require("electron").session.fromPartition("ai-conversation");
  }
  const fetchChat = fetchImpl || ((url, init) => getNetworkSession().fetch(url, init));
  const encode = encodeImage || imageToBase64Jpeg;

  function normalizeEndpoint(endpoint) {
    const base = String(endpoint || "").replace(/\/+$/, "");
    if (base.endsWith("/chat/completions")) return base;
    return `${base}/chat/completions`;
  }

  function imageToBase64Jpeg(filePath, maxWidth = 1920, quality = 25) {
    let image = require("electron").nativeImage.createFromPath(filePath);
    if (image.isEmpty()) {
      throw new Error(`无法读取截图: ${filePath}`);
    }
    const { width } = image.getSize();
    if (width > maxWidth) {
      image = image.resize({ width: maxWidth, quality: "better" });
    }
    return image.toJPEG(quality).toString("base64");
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

  const MAX_RETRIES = 3;
  const RETRY_BASE_MS = 800;
  const OPENAI_LOG_PATH = path.join(__dirname, "../../../logs/openai.jsonl");
  const appendLog = writeLog || createRotatingLog(OPENAI_LOG_PATH);

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

  /**
   * @param {string} url
   * @param {RequestInit} init
   * @param {{ maxRetries?: number, label?: string }} [opts]
   */
  async function fetchChatJson(url, init, opts = {}) {
    const maxRetries =
      Number.isFinite(opts.maxRetries) && opts.maxRetries >= 0
        ? Math.floor(opts.maxRetries)
        : MAX_RETRIES;
    const label = opts.label || "api";
    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        init.signal?.throwIfAborted();
        const { ai } = getOptions(getConfig());
        const { res, text } = await withTimeout(async (signal) => {
          const res = await fetchChat(url, { ...init, signal });
          const text = await res.text();
          signal.throwIfAborted();
          return { res, text };
        }, { signal: init.signal, timeoutMs: Number(ai.timeoutMs) || 30000 });
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
        return data;
      } catch (err) {
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
   * @param {{ max_tokens?: number, temperature?: number, signal?: AbortSignal }} [opts]
   */
  async function callChatCompletions(messages, opts = {}) {
    opts.signal?.throwIfAborted();
    const config = getConfig();
    const { ai } = getOptions(config);
    if (!ai?.endpoint || !ai?.apiKey || !ai?.model) {
      throw new Error("AI 对话插件缺少 ai.endpoint / apiKey / model");
    }

    await applyProxy(ai.proxy);
    const url = normalizeEndpoint(ai.endpoint);
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

    const data = await fetchChatJson(
      url,
      {
        method: "POST",
        signal: opts.signal,
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${ai.apiKey}`,
        },
        body: JSON.stringify(body),
      },
      { label: "ai:text" },
    );

    return messageContentToText(data?.choices?.[0]?.message?.content).trim();
  }

  /**
   * Make a decision from queued observations produced by the perception module.
   * @param {Array<object>} observations Generic observations with text/image content.
   */
  async function decideFromObservations(observations, { context = [], signal } = {}) {
    signal?.throwIfAborted();
    if (!Array.isArray(observations) || observations.length === 0) {
      throw new Error("没有可用于决策的感知观察");
    }

    const config = getConfig();
    const { ai, character } = getOptions(config);
    if (!ai?.endpoint || !ai?.apiKey || !ai?.model) {
      throw new Error("AI 对话插件缺少 ai.endpoint / apiKey / model");
    }

    const expressions = getExpressions();
    await applyProxy(ai.proxy);

    signal?.throwIfAborted();
    const inputs = prepareObservations(observations, encode);
    const systemPrompt = buildSystemPrompt(character, {
      expressions,
      context,
    });
    const url = normalizeEndpoint(ai.endpoint);
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${ai.apiKey}`,
    };

    const body = buildRequestBody(ai, systemPrompt, inputs);
    let response = "";
    let expression = "neutral";
    let screenSummary = "";
    let audioSummary = "";
    let raw = "";
    let lastParseError = null;
    const hasImages = observations.some(({ content }) => content.some(({ type }) => type === "image"));
    const hasAudio = observations.some(({ metadata }) => metadata?.modality === "audio");

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const data = await fetchChatJson(
          url,
          {
            method: "POST",
            signal,
            headers,
            body: JSON.stringify(body),
          },
          { maxRetries: 0, label: "ai:vision" },
        );

        signal?.throwIfAborted();
        raw = messageContentToText(data?.choices?.[0]?.message?.content).trim();
        const parsed = extractChatPayload(raw, expressions);
        response = (parsed.response || "").trim();
        expression = parsed.expression || "neutral";
        screenSummary = hasImages ? (parsed.screenSummary || "").trim() : "";
        audioSummary = hasAudio ? (parsed.audioSummary || "").trim() : "";

        if (!response && raw.trim()) {
          const lines = raw.trim().split(/\r?\n/);
          if (
            lines.length === 1 &&
            !isLikelyExpressionOnly(lines[0], expressions)
          ) {
            response = lines[0].trim();
            expression = "neutral";
          }
        }

        if (!response) {
          const error = new Error('API 未返回有效台词（需要 JSON：{"expression":"...","response":"...","screenSummary":"..."}）');
          error.retryable = true;
          throw error;
        }
        lastParseError = null;
        break;
      } catch (err) {
        if (signal?.aborted) throw err;
        lastParseError = err;
        const canRetry =
          attempt < MAX_RETRIES &&
          (isRetryableError(err) ||
            /未返回有效台词/.test(String(err?.message || "")));
        if (!canRetry) throw err;
        const delay = RETRY_BASE_MS * (attempt + 1);
        logger.warn(
          `[ai:vision] attempt ${attempt + 1}/${MAX_RETRIES + 1} failed, retry in ${delay}ms:`,
          err instanceof Error ? err.message : err,
        );
        await sleep(delay, signal);
      }
    }

    if (!response) {
      throw (
        lastParseError ||
        new Error(
          'API 未返回有效台词（需要 JSON：{"expression":"...","response":"...","screenSummary":"..."}）',
        )
      );
    }

    signal?.throwIfAborted();
    return {
      reply: response,
      expression,
      summaries: { screen: screenSummary, audio: audioSummary },
      metadata: {
        raw,
        observationCount: observations.length,
        resources: observations.flatMap(({ content }) => content
          .filter(({ type }) => type !== "text")
          .map(({ type, path, uri }) => ({ type, path, uri }))),
      },
    };
  }

  function isLikelyExpressionOnly(line, allowed) {
    const s = String(line || "").trim();
    if (!s || /\s/.test(s)) return false;
    return allowed.some((e) => e.toLowerCase() === s.toLowerCase());
  }


  function boundedOperation(operation, signal) {
    const { ai } = getOptions(getConfig());
    return withTimeout(operation, { signal, timeoutMs: Number(ai.retryBudgetMs) || 90000, label: "AI 整轮请求" });
  }
  return {
    decideFromObservations: (observations, options = {}) => boundedOperation(
      (signal) => decideFromObservations(observations, { ...options, signal }), options.signal),
    callChatCompletions: (messages, options = {}) => boundedOperation(
      (signal) => callChatCompletions(messages, { ...options, signal }), options.signal),
  };
}

module.exports = { createChatService };
