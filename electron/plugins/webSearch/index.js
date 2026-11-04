const { getOptions } = require("./options");
const { createWebClient, httpUrl } = require("./client");
const { createPromptExtension } = require("./prompt");
const { createDiagnostics } = require("./diagnostics");
const { createWebHistory } = require("./history");
const { randomUUID } = require("node:crypto");
const EVENTS = require("../../architecture/events");

function createWebSearchPlugin(context, dependencies = {}) {
  const options = getOptions(context.config.get());
  const history = createWebHistory({ options, logger: context.logger, getStorage: () => context.services.get("storage") });
  const diagnostic = createDiagnostics(options, context.logger);
  const log = (event, fields, level) => { diagnostic(event, fields, level); if (event.startsWith("http.")) history.http(event, fields); };
  const client = dependencies.client || createWebClient(options, { ...dependencies, diagnostics: log });
  const requestFields = (input = {}) => ({ type: input.type, query: input.query, url: input.url,
    maxResults: input.maxResults, includeContent: input.includeContent });
  const resultFields = (result) => ({ provider: result.provider, resultCount: result.results?.length,
    sources: result.results?.map((item) => ({ title: item.title, url: item.url })),
    url: result.url, title: result.title, contentChars: result.content?.length,
    answerChars: result.answer?.length, truncated: result.truncated });
  log("configured", { searchProvider: options.searchProvider, fetchProvider: options.fetchProvider,
    providers: Object.fromEntries(Object.entries(options.providers).map(([name, config]) => [name, {
      endpoint: config.endpoint, model: config.model, proxyConfigured: Boolean(config.proxy) }])),
    capabilities: client.capabilities, maxConcurrent: options.maxConcurrent, maxRequestsPerChain: options.maxRequestsPerChain });
  let running = false, disposed = false;
  let controller = new AbortController();
  const pending = [], flights = new Set(), decisions = new Set();
  const seen = new Set(), chains = new Map();
  const sourceUrls = new Map();

  function rememberUrls(chainId, urls) {
    if (!sourceUrls.has(chainId)) sourceUrls.set(chainId, new Set());
    const known = sourceUrls.get(chainId);
    for (const raw of urls) {
      if (known.size >= 200) break;
      try { known.add(httpUrl(raw)); } catch { /* Ignore invalid source addresses. */ }
    }
    if (sourceUrls.size > 1000) sourceUrls.delete(sourceUrls.keys().next().value);
  }
  const unregisterPrompt = context.systemPrompt.register(createPromptExtension(options, client.capabilities));
  const unregisterService = context.services.register("client", {
    capabilities: client.capabilities,
    search: (input, settings) => direct("search", input, settings),
    fetch: (input, settings) => direct("fetch", input, settings),
  });
  const unregisterHistory = context.services.register("history", { list: history.list, get: history.get }, { allowWhileStopped: true });
  const unsubscribeClear = context.bus.subscribe(EVENTS.RAW_LOG_CLEARED, () => history.clearMemory(), { allowWhileStopped: true });

  function track(set, task) {
    set.add(task);
    void task.finally(() => set.delete(task)).catch(() => {});
    return task;
  }

  function direct(method, input, settings = {}) {
    if (!running || disposed) return Promise.reject(new Error("网页搜索插件已停止"));
    if (flights.size >= options.maxConcurrent) return Promise.reject(new Error("网页请求正在忙碌"));
    const signal = settings.signal ? AbortSignal.any([settings.signal, controller.signal]) : controller.signal;
    const requestId = `direct:${randomUUID()}`, startedAt = Date.now();
    history.begin({ id: requestId, operation: method, request: input, state: "running",
      provider: method === "search" ? options.searchProvider : options.fetchProvider, origin: "service" });
    log("request.start", { requestId, operation: method, ...requestFields(input) });
    const task = Promise.resolve().then(() => client[method](input, { ...settings, signal, requestId }))
      .then((result) => {
        signal.throwIfAborted();
        history.update(requestId, { state: "success", result, finishedAt: Date.now(), elapsedMs: Date.now() - startedAt });
        log("request.success", { requestId, elapsedMs: Date.now() - startedAt, ...resultFields(result) }); return result;
      })
      .catch((error) => { log("request.failed", { requestId, error: error.message, status: error.status,
        cancelled: signal.aborted, elapsedMs: Date.now() - startedAt }, "warn");
        history.update(requestId, { state: signal.aborted ? "cancelled" : "failed", error: error.message,
          status: error.status, finishedAt: Date.now(), elapsedMs: Date.now() - startedAt }); throw error;
      });
    flights.add(task);
    void task.finally(() => { flights.delete(task); pump(); }).catch(() => {});
    return task;
  }

  async function execute(job, signal) {
    let result;
    const startedAt = Date.now();
    const detail = { requestId: job.id, decisionId: job.decisionId, chainId: job.chainId, chainUsed: job.chainUsed };
    history.update(job.id, { state: "running", startedAt });
    log("request.start", { ...detail, ...requestFields(job.effect),
      provider: job.effect.type === "web-search.query" ? options.searchProvider : options.fetchProvider });
    try {
      const effect = job.effect;
      if (effect.type === "web-search.query") {
        if (Object.keys(effect).some((key) => !["type", "query", "maxResults"].includes(key))) throw new Error("搜索 effect 格式无效");
        result = await client.search({ query: effect.query, maxResults: effect.maxResults,
          ...(job.originalQuestion ? { originalQuestion: [...job.originalQuestion].slice(0, 128).join("") } : {}) }, { signal, requestId: job.id });
        if (!signal.aborted) rememberUrls(job.chainId, (result.results || []).map((item) => item.url));
      } else {
        if (!client.capabilities.fetch) throw new Error("未配置支持 Fetch 的 provider");
        if (Object.keys(effect).some((key) => !["type", "url"].includes(key))) throw new Error("Fetch effect 格式无效");
        if (!sourceUrls.get(job.chainId)?.has(httpUrl(effect.url))) {
          log("fetch.rejected", { ...detail, url: effect.url, reason: "unverified_fetch_url", networkRequestSent: false,
            allowedUrls: [...(sourceUrls.get(job.chainId) || [])] }, "warn");
          throw Object.assign(new Error("Fetch URL 未来自用户或本次搜索"), { code: "unverified_fetch_url" });
        }
        result = await client.fetch({ url: effect.url }, { signal, requestId: job.id });
      }
      signal.throwIfAborted();
      log("request.success", { ...detail, elapsedMs: Date.now() - startedAt, ...resultFields(result) });
      result = { ok: true, ...result };
    } catch (error) {
      if (signal.aborted) {
        history.update(job.id, { state: "cancelled", finishedAt: Date.now(), elapsedMs: Date.now() - startedAt });
        log("request.cancelled", { ...detail, elapsedMs: Date.now() - startedAt }); return;
      }
      // Provider bodies and keys are never copied into model-visible failure messages.
      const pageUnavailable = error.code === "page_content_unavailable";
      const unverifiedUrl = error.code === "unverified_fetch_url";
      result = { ok: false,
        error: unverifiedUrl ? "Fetch 地址不是用户提供或本次搜索返回的 URL，插件已拦截，未发送网络请求。请返回 web-search.query 并填写真实搜索词。"
          : pageUnavailable
          ? "Fetch 未能获取可用正文，可能是页面不可用、站点拦截或没有可提取内容；不能据此断言链接不存在。请改用搜索获取摘要，不要猜测其他页面地址。"
          : error.status ? "网页服务 API 请求失败；不要将其解释为目标新闻链接失效。"
            : "网页请求失败或参数无效",
        errorCode: unverifiedUrl ? "unverified_fetch_url" : pageUnavailable ? "page_content_unavailable" : error.status ? "provider_http_error" : "request_failed",
        ...(error.status ? { status: error.status } : {}),
      };
      log("request.failed", { ...detail, error: error.message, errorCode: result.errorCode,
        status: error.status, elapsedMs: Date.now() - startedAt }, "warn");
    }
    history.update(job.id, { state: result.ok ? "success" : result.errorCode === "unverified_fetch_url" ? "rejected" : "failed",
      result, finishedAt: Date.now(), elapsedMs: Date.now() - startedAt });
    if (signal.aborted || !running || disposed) return;
    await context.perception.submit({
      id: `web-search:${job.id}`, source: "web-search", role: "context", trigger: "web-search-result",
      expiresAt: Date.now() + options.observationTtlMs,
      content: [{ type: "text", text: JSON.stringify({ operation: job.effect.type,
        originalQuestion: job.originalQuestion, request: job.effect, result }) }],
      metadata: { label: "网页查询结果（外部资料）", requestId: job.id, decisionId: job.decisionId,
        chainId: job.chainId, chainUsed: job.chainUsed, originalQuestion: job.originalQuestion },
    });
    log("observation.queued", { ...detail, observationId: `web-search:${job.id}`, ok: result.ok, errorCode: result.errorCode });
    history.update(job.id, { observationId: `web-search:${job.id}` });
    if (signal.aborted || !running || disposed) return;
    // Never await a new decision from inside decision.completed or from plugin teardown.
    log("decision.requested", detail);
    const request = Promise.resolve().then(() => context.decisions.request({ trigger: "web-search-result", signal }))
      .catch((error) => { if (!signal.aborted) log("decision.failed", { ...detail, error: error.message }, "warn"); });
    track(decisions, request);
  }

  function pump() {
    if (!running || disposed) return;
    while (pending.length && flights.size < options.maxConcurrent) {
      const job = pending.shift(), signal = controller.signal;
      const task = Promise.resolve().then(() => execute(job, signal))
        .catch((error) => { if (!signal.aborted) log("observation.failed", { requestId: job.id, error: error.message }, "warn"); });
      flights.add(task);
      void task.finally(() => { flights.delete(task); pump(); });
    }
  }

  const unsubscribe = context.bus.subscribe(EVENTS.DECISION_COMPLETED, (event) => {
    if (!running || disposed || typeof event.id !== "string") return;
    const observations = event.observations || [];
    const userText = observations.filter((item) => item.role === "user").flatMap((item) => item.content)
      .filter((part) => part.type === "text").map((part) => part.text).join("\n").slice(0, 4000);
    const previous = observations.find((item) => item.source === "web-search")?.metadata;
    const chainId = userText ? event.id : previous?.chainId || event.id;
    rememberUrls(chainId, [...userText.matchAll(/https?:\/\/[^\s<>"'`，。；！？（）【】]+/gi)]
      .map(([url]) => url.replace(/[.,;!?)\]]+$/, "")));
    const originalQuestion = userText || previous?.originalQuestion || "";
    let used = Math.max(chains.get(chainId) || 0, userText ? 0 : Number(previous?.chainUsed) || 0);
    for (const [index, effect] of (event.result.effects || []).entries()) {
      if (!["web-search.query", "web-search.fetch"].includes(effect.type)) continue;
      const id = `${event.id}:${index}`;
      const detail = { requestId: id, decisionId: event.id, chainId, ...requestFields(effect) };
      log("effect.received", { ...detail, modelReply: event.result.reply,
        effectFields: Object.keys(effect), originalQuestion });
      if (seen.has(id)) { log("effect.skipped", { ...detail, reason: "duplicate" }); continue; }
      history.begin({ id, decisionId: event.id, chainId, operation: effect.type === "web-search.query" ? "search" : "fetch",
        provider: effect.type === "web-search.query" ? options.searchProvider : options.fetchProvider,
        request: effect, originalQuestion, modelReply: event.result.reply, state: "queued", origin: "effect" });
      seen.add(id);
      if (seen.size > 1000) seen.delete(seen.values().next().value);
      if (used >= options.maxRequestsPerChain || pending.length + flights.size >= options.maxPending) {
        history.update(id, { state: "skipped", error: used >= options.maxRequestsPerChain ? "请求链次数已用完" : "待处理请求已满", finishedAt: Date.now() });
        log("effect.skipped", { ...detail, reason: used >= options.maxRequestsPerChain ? "chain_limit" : "pending_limit",
          chainUsed: used, pending: pending.length, inFlight: flights.size }, "warn");
        continue;
      }
      used++;
      history.update(id, { chainUsed: used });
      chains.set(chainId, used);
      if (chains.size > 1000) chains.delete(chains.keys().next().value);
      pending.push({ id, decisionId: event.id, chainId, chainUsed: used, originalQuestion, effect });
      log("effect.queued", { ...detail, chainUsed: used, pending: pending.length, inFlight: flights.size });
    }
    pump();
  });

  function stop() {
    log("stopped", { inFlight: flights.size, droppedPending: pending.length, decisionRequests: decisions.size });
    running = false;
    controller.abort();
    for (const job of pending) history.update(job.id, { state: "cancelled", error: "插件停止，待处理请求已取消", finishedAt: Date.now() });
    pending.length = 0;
    return Promise.allSettled([...flights, ...decisions]);
  }
  return {
    start() { if (!disposed && !running) { controller = new AbortController(); running = true; log("started"); pump(); } },
    stop,
    dispose() {
      if (disposed) return stop();
      disposed = true;
      unsubscribe(); unsubscribeClear(); unregisterPrompt(); unregisterService(); unregisterHistory();
      return stop();
    },
  };
}

module.exports = { activate: createWebSearchPlugin, createWebSearchPlugin };
