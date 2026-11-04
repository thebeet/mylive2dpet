const test = require("node:test");
const assert = require("node:assert/strict");
const { createWebClient } = require("../electron/plugins/webSearch/client");
const { normalizeOptions } = require("../electron/plugins/webSearch/options");
const { createWebSearchPlugin } = require("../electron/plugins/webSearch");
const { createTransport } = require("../electron/plugins/webSearch/transport");
const { createPluginHost } = require("../electron/pluginHost");
const { createPromptExtensions } = require("../electron/architecture/promptExtensions");
const { createServiceRegistry } = require("../electron/architecture/serviceRegistry");
const { MessageBus } = require("../electron/architecture/messageBus");
const { createPerceptionService } = require("../electron/architecture/perceptionService");
const { normalizeConfig } = require("../electron/config");
const EVENTS = require("../electron/architecture/events");
const definition = require("../electron/plugins/webSearch/definition");
const quiet = { info() {}, warn() {}, error() {} };
const settle = () => new Promise((resolve) => setImmediate(resolve));
const options = (overrides = {}) => normalizeOptions({ name: "web-search", enabled: true,
  providers: { deepseek: { apiKey: "test-deepseek" }, openai: { apiKey: "test-openai", model: "configured-search-model" } }, ...overrides });
const response = (data, status = 200) => ({ ok: status === 200, status, text: async () => JSON.stringify(data) });

test("DeepSeek search and fetch match documented endpoints and normalize distinct result types", async () => {
  const calls = [], proxies = [];
  const client = createWebClient(options(), { configureProxy: async (proxy) => proxies.push(proxy),
    fetchImpl: async (url, init) => {
      calls.push({ url, ...init, body: JSON.parse(init.body) });
      return url.endsWith("/search") ? response({ results: [{ title: "title", url: "https://example.com/page",
        snippet: "snippet", summary: "summary", content: "full content", date: "2026-11-04T00:00:00Z", site_name: "Example" }] })
        : response({ title: "page", content: "# Markdown\nBody" });
    } });
  const search = await client.search({ query: " query ", maxResults: 3, includeContent: true, originalQuestion: "question" });
  assert.deepEqual(calls[0].body, { query: "query", count: 3, need_content: true, ori_question: "question" });
  assert.equal(calls[0].url, "https://api.deepseek.com/v1/tools/search");
  assert.equal(calls[0].headers.Authorization, "Bearer test-deepseek");
  assert.equal(calls[0].redirect, "error");
  assert.equal(search.results[0].summary, "summary");
  assert.equal(search.results[0].content, "full content");
  assert.equal(search.results[0].publishedAt, "2026-11-04T00:00:00Z");
  const page = await client.fetch({ url: "https://example.com/page" });
  assert.equal(calls[1].url, "https://api.deepseek.com/v1/tools/fetch");
  assert.deepEqual(calls[1].body, { url: "https://example.com/page" });
  assert.equal(page.format, "markdown");
  assert.equal(page.content, "# Markdown\nBody");
  assert.deepEqual(proxies, [""]);
});

test("OpenAI uses Responses web_search and distinguishes model synthesis from source snippets or page content", async () => {
  let request;
  const client = createWebClient(options({ searchProvider: "openai", fetchProvider: "" }), {
    fetchImpl: async (url, init) => {
      request = { url, ...JSON.parse(init.body) };
      return response({ status: "completed", output: [
        { type: "web_search_call", status: "completed", action: { type: "search", sources: [{ type: "url", url: "https://second.example/" }] } },
        { type: "message", content: [{ type: "output_text", text: "Synthesized answer", annotations: [
          { type: "url_citation", url: "https://first.example/", title: "First source" },
          { type: "url_citation", url: "https://first.example/", title: "First source" },
        ] }] },
      ] });
    } });
  const result = await client.search({ query: "latest info", maxResults: 2 });
  assert.equal(request.url, "https://api.openai.com/v1/responses");
  assert.equal(request.model, "configured-search-model");
  assert.deepEqual(request.tools, [{ type: "web_search" }]);
  assert.deepEqual(request.include, ["web_search_call.action.sources"]);
  assert.equal(request.store, false);
  assert.equal(result.answerKind, "model-synthesis");
  assert.equal(result.answer, "Synthesized answer");
  assert.equal(result.results.length, 2);
  assert.equal(Object.hasOwn(result.results[0], "content"), false);
  assert.equal(Object.hasOwn(result.results[0], "snippet"), false);
  await assert.rejects(client.fetch({ url: "https://example.com" }), /未配置/);
});

test("search and fetch can use different providers and malformed or unfinished provider responses fail", async () => {
  const urls = [];
  const mixed = createWebClient(options({ searchProvider: "openai", fetchProvider: "deepseek" }), {
    fetchImpl: async (url) => {
      urls.push(url);
      return response({ title: "page", content: "body" });
    } });
  await mixed.fetch({ url: "https://example.com" });
  assert.equal(urls[0], "https://api.deepseek.com/v1/tools/fetch");
  for (const data of [{ status: "incomplete", output: [] }, { status: "completed", output: [] },
    { status: "completed", output: [{ type: "web_search_call", status: "completed" }, { type: "message", content: [{ type: "refusal" }] }] }]) {
    const client = createWebClient(options({ searchProvider: "openai", fetchProvider: "" }), { fetchImpl: async () => response(data) });
    await assert.rejects(client.search({ query: "query" }), /未完成|未执行|拒绝/);
  }
  const invalid = createWebClient(options(), { fetchImpl: async () => response({}) });
  await assert.rejects(invalid.search({ query: "query" }), /results/);
  await assert.rejects(invalid.fetch({ url: "https://example.com" }), /正文/);
});

test("client validates inputs, filters unsafe results, deduplicates URLs and bounds returned content", async () => {
  let calls = 0;
  const client = createWebClient(options({ maxContentChars: 1000 }), { fetchImpl: async (url) => {
    calls++;
    return url.endsWith("/search") ? response({ results: [
      { title: "unsafe", url: "javascript:alert(1)" },
      { title: "valid", url: "https://example.com", summary: "x".repeat(2000) },
      { title: "duplicate", url: "https://example.com/" },
    ] }) : response({ title: "page", content: "x".repeat(2000) });
  } });
  for (const input of [{ query: " " }, { query: "x".repeat(129) }, { query: "x", maxResults: 51 }, { query: "x", includeContent: "yes" }]) {
    await assert.rejects(client.search(input));
  }
  for (const url of ["file:///etc/passwd", "https://user:password@example.com", "invalid"]) await assert.rejects(client.fetch({ url }));
  assert.equal(calls, 0);
  const data = await client.search({ query: "query" });
  assert.equal(data.results.length, 1);
  assert.ok(data.results[0].summary.length <= 1000);
  const page = await client.fetch({ url: "https://example.com" });
  assert.equal(page.content.length, 1000);
  assert.equal(page.truncated, true);
});

test("transport retries only transient errors and bounds stalled requests and cancellation", async () => {
  let calls = 0;
  const post = createTransport({ endpoint: "https://test.invalid", apiKey: "secret" }, { timeoutMs: 1000, maxRetries: 1 }, {
    retryWait: async () => {}, fetchImpl: async () => ++calls === 1 ? response({}, 429) : response({ results: [] }) });
  await post("/search", {}); assert.equal(calls, 2);
  calls = 0;
  const denied = createTransport({ endpoint: "https://test.invalid", apiKey: "secret" }, { timeoutMs: 1000, maxRetries: 2 }, {
    retryWait: async () => {}, fetchImpl: async () => { calls++; return response({ error: { message: "secret" } }, 401); } });
  await assert.rejects(denied("/search", {}), (error) => error.status === 401 && !error.message.includes("secret"));
  assert.equal(calls, 1);
  const stuck = createTransport({ endpoint: "https://test.invalid", apiKey: "secret" }, { timeoutMs: 20, maxRetries: 0 }, {
    fetchImpl: async () => ({ ok: true, status: 200, text: () => new Promise(() => {}) }) });
  await assert.rejects(stuck("/search", {}), /超时/);
  const controller = new AbortController();
  const waiting = stuck("/search", {}, { signal: controller.signal }); controller.abort(new Error("cancelled"));
  await assert.rejects(waiting, /cancelled/);
});

test("DeepSeek Fetch 404 reports unavailable page content, while Search 404 remains an API error", async () => {
  let calls = 0;
  const client = createWebClient(options(), { fetchImpl: async () => {
    calls++;
    return response({ error: { message: "provider internal details" } }, 404);
  } });
  await assert.rejects(client.fetch({ url: "https://example.com/page" }),
    (error) => error.status === 404 && error.code === "page_content_unavailable");
  await assert.rejects(client.search({ query: "news" }),
    (error) => error.status === 404 && error.code !== "page_content_unavailable");
  assert.equal(calls, 2); // Permanent errors are not retried by the transport.
});

function pluginHarness(t, overrides = {}) {
  const bus = new MessageBus({ logger: quiet }), perception = createPerceptionService(bus);
  const services = createServiceRegistry(), prompts = createPromptExtensions();
  const requests = [], calls = [];
  const config = { plugins: [options(overrides.options)] };
  const client = overrides.client || { capabilities: { search: true, fetch: true },
    search: async (input) => { calls.push(input); return { results: [{ title: "source", url: "https://example.com" }] }; },
    fetch: async (input) => ({ url: input.url, title: "page", content: "body" }) };
  const plugin = createWebSearchPlugin({ bus, perception, config: { get: () => config }, logger: overrides.logger || quiet,
    systemPrompt: { register: (extension) => prompts.register("web-search", extension) },
    services: { register: (name, service) => services.register(`web-search.${name}`, service), get: services.get },
    decisions: { request: async (request) => requests.push(request) },
  }, { client });
  t.after(() => plugin.dispose()); plugin.start();
  return { plugin, bus, perception, services, prompts, requests, calls };
}
const decision = (id, effects, observations = [{ role: "user", content: [{ type: "text", text: "original question" }] }]) =>
  ({ id, observations, result: { effects, speak: false, reply: "" } });

test("failure observations distinguish unavailable Fetch content from API failure without copying provider details", async (t) => {
  const h = pluginHarness(t, { client: { capabilities: { search: true, fetch: true },
    fetch: async () => { throw Object.assign(new Error("secret provider detail"), { status: 404, code: "page_content_unavailable" }); },
    search: async () => { throw Object.assign(new Error("secret provider detail"), { status: 401 }); },
  } });
  await h.bus.notify(EVENTS.DECISION_COMPLETED, decision("fetch-failure", [{ type: "web-search.fetch", url: "https://example.com" }],
    [{ role: "user", content: [{ type: "text", text: "读取 https://example.com" }] }]));
  await settle();
  const [page] = await h.perception.takeBatch();
  const failure = JSON.parse(page.content[0].text).result;
  assert.equal(failure.errorCode, "page_content_unavailable");
  assert.match(failure.error, /不能据此断言链接不存在/);
  assert.match(failure.error, /改用搜索/);
  await h.bus.notify(EVENTS.DECISION_COMPLETED, decision("api-failure", [{ type: "web-search.query", query: "news", maxResults: 1 }]));
  await settle();
  const [api] = await h.perception.takeBatch();
  assert.equal(JSON.parse(api.content[0].text).result.errorCode, "provider_http_error");
  assert.equal(JSON.parse(api.content[0].text).result.status, 401);
  for (const observation of [page, api]) assert.equal(observation.content[0].text.includes("secret provider detail"), false);
});

test("model Fetch rejects copied sample URLs before making a network request", async (t) => {
  let fetched = 0;
  const h = pluginHarness(t, { client: { capabilities: { search: true, fetch: true },
    search: async () => ({ results: [] }), fetch: async () => { fetched++; return { content: "Example Domain" }; },
  } });
  await h.bus.notify(EVENTS.DECISION_COMPLETED, decision("news", [{ type: "web-search.fetch", url: "https://example.com" }]));
  await settle();
  const [observation] = await h.perception.takeBatch();
  assert.equal(fetched, 0);
  const failure = JSON.parse(observation.content[0].text).result;
  assert.equal(failure.errorCode, "unverified_fetch_url");
  assert.match(failure.error, /未发送网络请求/);
  assert.match(failure.error, /web-search.query/);
  assert.equal(h.prompts.collect().contributions[0].text.includes("https://example.com"), false);
});

test("diagnostic logs identify received and rejected effects without logging configured keys", async (t) => {
  const logs = [];
  const logger = { info: (line) => logs.push(line), warn: (line) => logs.push(line) };
  const h = pluginHarness(t, { logger });
  await h.bus.notify(EVENTS.DECISION_COMPLETED, decision("log-decision", [
    { type: "web-search.fetch", url: "https://example.com/page?apiKey=test-deepseek" },
  ], [{ role: "user", content: [{ type: "text", text: "查新闻 test-deepseek" }] }]));
  await settle();
  const received = logs.find((line) => line.startsWith("web effect.received:"));
  assert.ok(received.includes('"type":"web-search.fetch"'));
  assert.ok(received.includes('"requestId":"log-decision:0"'));
  assert.ok(logs.some((line) => line.startsWith("web fetch.rejected:") && line.includes('"networkRequestSent":false')));
  assert.ok(logs.some((line) => line.startsWith("web observation.queued:")));
  assert.ok(logs.some((line) => line.startsWith("web decision.requested:")));
  assert.equal(logs.some((line) => line.startsWith("web http.start:")), false);
  assert.equal(logs.join("\n").includes("test-deepseek"), false);
  assert.equal(logs.join("\n").includes("test-openai"), false);
});

test("HTTP diagnostic logs correlate attempts, status and retries without copying API bodies or credentials", async () => {
  const logs = [], logger = { info: (line) => logs.push(line), warn: (line) => logs.push(line) };
  let calls = 0;
  const client = createWebClient(options(), { logger, retryWait: async () => {}, fetchImpl: async () => {
    if (++calls === 1) return response({ error: { message: "private API failure body" } }, 429);
    return response({ results: [{ title: "source", url: "https://example.com", content: "private page body" }] });
  } });
  await client.search({ query: "news" }, { requestId: "trace-id" });
  assert.equal(logs.filter((line) => line.startsWith("web http.start:")).length, 2);
  assert.ok(logs.some((line) => line.includes('"apiUrl":"https://api.deepseek.com/v1/tools/search"')));
  assert.ok(logs.some((line) => line.includes('"status":429') && line.includes('"willRetry":true')));
  assert.ok(logs.some((line) => line.includes('"status":200') && line.includes('"attempt":2')));
  for (const line of logs) assert.ok(line.includes('"requestId":"trace-id"'));
  for (const secret of ["private API failure body", "private page body", "test-deepseek"]) {
    assert.equal(logs.join("\n").includes(secret), false);
  }
});

test("model Fetch accepts search result URLs in the same chain but rejects unrelated guesses and new chains", async (t) => {
  const fetched = [];
  const h = pluginHarness(t, { client: { capabilities: { search: true, fetch: true },
    search: async () => ({ results: [{ title: "source", url: "https://news.example/article" }] }),
    fetch: async ({ url }) => { fetched.push(url); return { url, content: "article" }; },
  } });
  await h.bus.notify(EVENTS.DECISION_COMPLETED, decision("search", [{ type: "web-search.query", query: "game news", maxResults: 1 }]));
  await settle();
  const [search] = await h.perception.takeBatch();
  await h.bus.notify(EVENTS.DECISION_COMPLETED, decision("read", [
    { type: "web-search.fetch", url: "https://news.example/article" },
    { type: "web-search.fetch", url: "https://news.example/guessed" },
  ], [search]));
  await settle();
  const followups = await h.perception.takeBatch();
  assert.deepEqual(fetched, ["https://news.example/article"]);
  assert.ok(followups.some((item) => JSON.parse(item.content[0].text).result.errorCode === "unverified_fetch_url"));
  await h.bus.notify(EVENTS.DECISION_COMPLETED, decision("new-question", [{ type: "web-search.fetch", url: "https://news.example/article" }]));
  await settle();
  assert.equal(fetched.length, 1);
});

test("model Fetch accepts a user-provided URL with surrounding punctuation", async (t) => {
  const fetched = [];
  const h = pluginHarness(t, { client: { capabilities: { search: true, fetch: true },
    fetch: async ({ url }) => { fetched.push(url); return { url, content: "article" }; },
  } });
  await h.bus.notify(EVENTS.DECISION_COMPLETED, decision("user-link", [{ type: "web-search.fetch", url: "https://news.example/article" }],
    [{ role: "user", content: [{ type: "text", text: "帮我读一下（https://news.example/article）。" }] }]));
  await settle();
  assert.deepEqual(fetched, ["https://news.example/article"]);
});

test("effects run in background and return observations followed by a decision, without blocking notification listeners", async (t) => {
  let release;
  const wait = new Promise((resolve) => { release = resolve; });
  const h = pluginHarness(t, { client: { capabilities: { search: true, fetch: true },
    search: async () => { await wait; return { results: [] }; }, fetch: async () => ({ content: "page" }) } });
  let notified = false;
  h.bus.subscribe(EVENTS.DECISION_COMPLETED, () => { notified = true; });
  const event = decision("d1", [{ type: "web-search.query", query: "query", maxResults: 3 }]);
  await h.bus.notify(EVENTS.DECISION_COMPLETED, event);
  assert.equal(notified, true); assert.equal(h.perception.pendingCount(), 0);
  release(); await settle();
  const [result] = await h.perception.takeBatch();
  assert.equal(result.source, "web-search"); assert.equal(result.role, "context");
  assert.equal(result.metadata.decisionId, "d1");
  assert.equal(JSON.parse(result.content[0].text).originalQuestion, "original question");
  assert.equal(h.requests.length, 1);
  await h.bus.notify(EVENTS.DECISION_COMPLETED, event); await settle();
  assert.equal(h.perception.pendingCount(), 0);
});

test("web history records effects, direct calls and rejected URLs with their trigger context and result", async (t) => {
  const h = pluginHarness(t);
  await h.bus.notify(EVENTS.DECISION_COMPLETED, decision("history-search", [{ type: "web-search.query", query: "news", maxResults: 1 }]));
  await settle();
  const history = h.services.get("web-search.history");
  const search = history.get("history-search:0");
  assert.equal(search.operation, "search");
  assert.equal(search.state, "success");
  assert.equal(search.originalQuestion, "original question");
  assert.equal(search.result.results[0].title, "source");
  assert.equal(search.observationId, "web-search:history-search:0");
  await h.bus.notify(EVENTS.DECISION_COMPLETED, decision("history-fetch", [{ type: "web-search.fetch", url: "https://unverified.example" }]));
  await settle();
  assert.equal(history.get("history-fetch:0").state, "rejected");
  await h.services.get("web-search.client").fetch({ url: "https://direct.example" });
  const direct = history.list().entries.find(entry => entry.origin === "service");
  assert.equal(direct.operation, "fetch");
  assert.equal(direct.state, "success");
  assert.equal(history.get(direct.id).result.content, "body");
  await h.plugin.dispose();
  assert.equal(h.services.get("web-search.history"), undefined);
});

test("failed operations return a failure observation and request-chain limits stop loops", async (t) => {
  const h = pluginHarness(t, { options: { maxRequestsPerChain: 1 }, client: { capabilities: { search: true, fetch: false },
    search: async () => { throw Object.assign(new Error("provider failure"), { status: 402 }); } } });
  await h.bus.notify(EVENTS.DECISION_COMPLETED, decision("d1", [{ type: "web-search.query", query: "query", maxResults: 1 }]));
  await settle();
  const [observation] = await h.perception.takeBatch();
  assert.equal(JSON.parse(observation.content[0].text).result.ok, false);
  assert.equal(JSON.parse(observation.content[0].text).result.status, 402);
  assert.equal(h.prompts.collect().effectSchemas.length, 1);
  await h.bus.notify(EVENTS.DECISION_COMPLETED, decision("d2", [{ type: "web-search.query", query: "repeat", maxResults: 1 }], [observation]));
  await settle(); assert.equal(h.perception.pendingCount(), 0);
});

test("stop cancels in-flight work, drops waiting jobs and rejects late ingress and old service calls", async (t) => {
  let release, called = 0;
  const wait = new Promise((resolve) => { release = resolve; });
  const h = pluginHarness(t, { options: { maxConcurrent: 1 }, client: { capabilities: { search: true, fetch: true },
    search: async () => { called++; await wait; return { results: [] }; } } });
  await h.bus.notify(EVENTS.DECISION_COMPLETED, decision("d1", [
    { type: "web-search.query", query: "one", maxResults: 1 }, { type: "web-search.query", query: "two", maxResults: 1 },
  ]));
  await settle(); const stopping = h.plugin.stop(); release(); await stopping;
  assert.equal(called, 1); assert.equal(h.perception.pendingCount(), 0); assert.equal(h.requests.length, 0);
  await assert.rejects(h.services.get("web-search.client").search({ query: "x" }), /已停止/);
  await h.plugin.dispose(); assert.equal(h.prompts.collect().contributions.length, 0);
  assert.equal(h.services.get("web-search.client"), undefined);
});

test("configuration is opt-in, validates credentials and capabilities, and the host cleans registrations", async (t) => {
  assert.equal(definition.shouldLoad(normalizeConfig({})), false);
  for (const plugin of [{ name: "web-search", enabled: true },
    { name: "web-search", enabled: true, searchProvider: "openai", providers: { openai: { apiKey: "key" } } },
    { name: "web-search", fetchProvider: "openai" }, { name: "web-search", maxConcurrent: 0 }]) {
    assert.throws(() => normalizeConfig({ plugins: [plugin] }));
  }
  const config = normalizeConfig({ plugins: [options()] }), services = createServiceRegistry(), prompts = createPromptExtensions();
  const host = createPluginHost({ bus: new MessageBus({ logger: quiet }), services, promptExtensions: prompts,
    getConfig: () => config, logger: quiet, definitions: [definition] });
  t.after(() => host.dispose());
  await host.activate(); await host.start();
  assert.equal(host.getState()["web-search"].status, "running");
  assert.ok(services.get("web-search.client"));
  assert.equal(prompts.collect().effectSchemas.length, 2);
  await host.reload(normalizeConfig({ plugins: [{ name: "web-search", enabled: false }] }));
  assert.equal(services.get("web-search.client"), undefined);
  assert.equal(prompts.collect().effectSchemas.length, 0);
});

test("a new provider factory implements the abstraction without using built-in API protocols", async () => {
  const called = [];
  const config = { ...options(), searchProvider: "custom", fetchProvider: "custom",
    providers: { custom: { endpoint: "https://custom.invalid", apiKey: "key" } } };
  const client = createWebClient(config, { providerFactories: { custom: ({ config }) => ({
    capabilities: { search: true, fetch: true },
    search: async (input) => { called.push([config.endpoint, input.query]); return { results: [{ title: "custom", url: "https://example.com" }] }; },
    fetch: async ({ url }) => ({ url, title: "custom page", content: "markdown body", format: "markdown" }),
  }) } });
  assert.equal((await client.search({ query: "query" })).provider, "custom");
  assert.equal((await client.fetch({ url: "https://example.com" })).content, "markdown body");
  assert.deepEqual(called, [["https://custom.invalid", "query"]]);
});

test("direct service completion releases capacity for queued effects", async (t) => {
  let release, calls = 0;
  const wait = new Promise((resolve) => { release = resolve; });
  const h = pluginHarness(t, { options: { maxConcurrent: 1 }, client: { capabilities: { search: true, fetch: true },
    search: async () => { if (++calls === 1) await wait; return { results: [] }; } } });
  const direct = h.services.get("web-search.client").search({ query: "direct" });
  await settle();
  await h.bus.notify(EVENTS.DECISION_COMPLETED, decision("d1", [{ type: "web-search.query", query: "effect", maxResults: 1 }]));
  assert.equal(calls, 1);
  release(); await direct; await settle();
  assert.equal(calls, 2);
  assert.equal(h.perception.pendingCount(), 1);
});
