const test = require("node:test");
const assert = require("node:assert/strict");
const { workStorage } = require("./helpers/workStorage");
const { createGitlabPlugin, readJson } = require("../electron/plugins/gitlab");
const definition = require("../electron/plugins/gitlab/definition");
const { normalizeConfig } = require("../electron/config");
const { MessageBus } = require("../electron/architecture/messageBus");
const { createPerceptionService } = require("../electron/architecture/perceptionService");
const { createServiceRegistry } = require("../electron/architecture/serviceRegistry");
const { createPluginHost } = require("../electron/pluginHost");
const { createGitlabHistory, MAX_RECORDS } = require("../electron/plugins/gitlab/history");
const { createRawLogRepository } = require("../electron/plugins/rawLog/repository");

const settle = () => new Promise(resolve => setImmediate(resolve));
const pipeline = (id, status = "running", extra = {}) => ({ id, status, ref: "main", sha: "abc",
  web_url: `https://gitlab.example/team/project/-/pipelines/${id}`, ...extra });
const response = (items, headers = {}) => new Response(JSON.stringify(items), { headers });
const latestLog = h => {
  const history = createGitlabHistory(h.storage);
  return history.get(history.list().entries[0].id);
};

function harness(t, options = {}, overrides = {}, existing) {
  const stored = existing || workStorage(), timers = new Set(), requests = [], warnings = [];
  const perception = createPerceptionService(new MessageBus());
  let items = [pipeline(1)], clock = Date.now();
  const context = { config: { get: () => ({ plugins: [{ name: "gitlab", baseUrl: "https://gitlab.example",
    token: "test-secret", projects: ["team/project"], ...options }] }) },
    storage: stored.storage, perception, logger: { warn: message => warnings.push(message) } };
  const plugin = createGitlabPlugin(context, { now: () => clock,
    fetch: async (url, init) => { requests.push({ url, init }); return response(items); },
    setTimeout: (callback, ms) => { const timer = { callback, ms }; timers.add(timer); return timer; },
    clearTimeout: timer => timers.delete(timer), ...overrides });
  t.after(async () => { await plugin.dispose(); if (!existing) stored.db.close(); });
  return { ...stored, context, plugin, perception, timers, requests, warnings,
    items: value => { items = value; },
    async start() { plugin.start(); await settle(); },
    async poll() {
      assert.equal(timers.size, 1);
      const timer = [...timers][0]; timers.delete(timer); clock += timer.ms; timer.callback(); await settle();
    },
    async data() { return (await perception.takeBatch()).map(item => JSON.parse(item.content[0].text)); },
  };
}

test("baseline, status transitions, new pipelines and unchanged polling", async t => {
  const h = harness(t);
  await h.start();
  assert.equal(h.perception.pendingCount(), 0);
  h.items([pipeline(1, "failed"), pipeline(2, "success")]);
  await h.poll();
  const data = await h.data();
  assert.deepEqual(data.map(item => [item.eventType, item.previousStatus, item.status]),
    [["status-changed", "running", "failed"], ["new", null, "success"]]);
  await h.poll();
  assert.equal(h.perception.pendingCount(), 0);
  assert.equal(h.warnings.length, 0);
  const url = new URL(h.requests[0].url);
  assert.equal(url.pathname, "/api/v4/projects/team%2Fproject/pipelines");
  assert.equal(url.searchParams.get("per_page"), "100");
  assert.ok(url.searchParams.has("updated_after"));
  assert.equal(h.requests[0].init.headers["PRIVATE-TOKEN"], "test-secret");
  assert.equal(h.requests[0].init.redirect, "error");
});

test("status and branch filters still track excluded statuses and retry transitions", async t => {
  const h = harness(t, { projects: [{ id: 42, ref: "main", statuses: ["failed", "success"] }] });
  await h.start();
  h.items([pipeline(1, "failed"), pipeline(2, "failed", { ref: "develop" })]); await h.poll();
  assert.equal((await h.data()).length, 1);
  h.items([pipeline(1, "running")]); await h.poll();
  assert.equal(h.perception.pendingCount(), 0);
  h.items([pipeline(1, "failed")]); await h.poll();
  assert.equal((await h.data())[0].previousStatus, "running");
  h.items([pipeline(1, "success")]); await h.poll();
  assert.equal((await h.data())[0].previousStatus, "failed");
  assert.equal(new URL(h.requests[0].url).searchParams.get("ref"), "main");
  assert.equal(new URL(h.requests[0].url).searchParams.has("status"), false);
});

test("persistent checkpoints capture offline changes and preserve the saved query cursor", async t => {
  const h = harness(t); await h.start(); await h.plugin.stop();
  const checkpoint = h.storage.collection("gitlab.pipelines").list()[0].value;
  const restored = harness(t, {}, {}, { storage: h.storage, db: h.db });
  restored.items([pipeline(1, "success")]); await restored.start();
  assert.equal((await restored.data())[0].previousStatus, "running");
  assert.equal(new URL(restored.requests[0].url).searchParams.get("updated_after"),
    new Date(checkpoint.checkedAt - 60000).toISOString());
  await restored.poll(); assert.equal(restored.perception.pendingCount(), 0);
});

test("pagination includes every page before establishing a baseline", async t => {
  const pages = [];
  const h = harness(t, { emitOnFirstFetch: true }, { fetch: async url => {
    const page = new URL(url).searchParams.get("page"); pages.push(page);
    return response([pipeline(Number(page))], { "x-next-page": page === "1" ? "2" : "" });
  } });
  await h.start();
  assert.deepEqual(pages, ["1", "2"]);
  assert.equal(h.perception.pendingCount(), 2);
});

test("pagination limit and malformed responses never commit a partial baseline", async t => {
  let broken = true;
  const h = harness(t, { maxPages: 1 }, { fetch: async () => broken
    ? response([pipeline(1)], { "x-next-page": "2" }) : response([pipeline(1)]) });
  await h.start();
  assert.equal(h.storage.collection("gitlab.pipelines").list().length, 0);
  assert.match(h.warnings[0], /maxPages/);
  broken = false; await h.poll();
  assert.equal(h.perception.pendingCount(), 0, "first successful read only establishes baseline");
  for (const payload of [{ message: "unauthorized" }, [null], [{ id: 1 }]]) {
    const invalid = harness(t, {}, { fetch: async () => response(payload) });
    await invalid.start();
    assert.equal(invalid.storage.collection("gitlab.pipelines").list().length, 0);
    assert.equal(invalid.warnings.length, 1);
  }
});

test("queue failure retries unsent changes without replaying accepted observations", async t => {
  const h = harness(t);
  await h.start();
  const before = h.storage.collection("gitlab.pipelines").list()[0].value.checkedAt;
  let count = 0, fail = true;
  const submit = h.context.perception.submit;
  h.context.perception.submit = async item => {
    if (++count === 2 && fail) throw new Error("queue full");
    return submit(item);
  };
  h.items([pipeline(1, "failed"), pipeline(2, "failed")]); await h.poll();
  assert.equal(h.storage.collection("gitlab.pipelines").list()[0].value.checkedAt, before);
  fail = false; await h.poll();
  assert.equal(count, 3);
  assert.equal(h.perception.pendingCount(), 2);
});

test("authentication failures do not prevent other projects; rate limits honor Retry-After", async t => {
  const h = harness(t, { projects: [1, 2], emitOnFirstFetch: true }, { fetch: async url =>
    new URL(url).pathname.includes("/1/") ? new Response(null, { status: 403 }) : response([pipeline(1)]) });
  await h.start();
  assert.equal(h.perception.pendingCount(), 1);
  assert.match(h.warnings[0], /403/);
  const limited = harness(t, {}, { fetch: async () => new Response(null, { status: 429, headers: { "retry-after": "120" } }) });
  await limited.start();
  assert.equal([...limited.timers][0].ms, 120000);
});

test("environment token, safe observation URLs, redaction and capture TTL", async t => {
  let fail = false;
  const h = harness(t, { token: "", tokenEnv: "GITLAB_TOKEN", emitOnFirstFetch: true, observationTtlMs: 60000 }, {
    env: { GITLAB_TOKEN: "private-token" }, fetch: async (_url, init) => {
      assert.equal(init.headers["PRIVATE-TOKEN"], "private-token");
      if (fail) throw new Error("network private-token");
      return response([pipeline(1, "failed", { ref: "private-token", web_url: "https://gitlab.example/p?access_token=private-token" })]);
    },
  });
  await h.start();
  const [item] = await h.perception.takeBatch();
  assert.equal(item.expiresAt - Date.parse(item.capturedAt), 60000);
  assert.doesNotMatch(JSON.stringify(item), /private-token|access_token/);
  assert.doesNotMatch(JSON.stringify(h.storage.collection("gitlab.pipelines").list()), /private-token/);
  fail = true; await h.poll();
  assert.doesNotMatch(h.warnings.join(""), /private-token/);
});

test("proxy setup uses an isolated Electron session and retries failed setup", async t => {
  let attempts = 0;
  const routes = [], calls = [];
  const h = harness(t, { proxy: "http://localhost:7890" }, { fetch: undefined, getSession: partition => {
    assert.match(partition, /^gitlab:/);
    return { async setProxy(route) { routes.push(route); if (++attempts === 1) throw new Error("proxy unavailable"); },
      async fetch(url, init) { calls.push({ url, init }); return response([pipeline(1)]); } };
  } });
  await h.start(); await h.poll(); await h.poll();
  assert.equal(attempts, 2);
  assert.deepEqual(routes[1], { proxyRules: "http://localhost:7890" });
  assert.equal(calls.length, 2);
});

test("stop aborts network and rejects late results without scheduling more work", async t => {
  let resolve, signal;
  const h = harness(t, { emitOnFirstFetch: true }, { fetch: async (_url, init) => {
    signal = init.signal; return new Promise(done => { resolve = done; });
  } });
  await h.start(); h.plugin.start();
  const stopping = h.plugin.stop();
  assert.equal(signal.aborted, true);
  resolve(response([pipeline(1)])); await stopping;
  assert.equal(h.perception.pendingCount(), 0);
  assert.equal(h.timers.size, 0);
});

test("stop waits for accepted ingress and saves it before disposal clears pending observations", async t => {
  let release;
  const h = harness(t, { emitOnFirstFetch: true });
  h.items([pipeline(1), pipeline(2)]);
  const submit = h.context.perception.submit;
  h.context.perception.submit = async item => { await new Promise(done => { release = done; }); return submit(item); };
  await h.start();
  let stopped = false;
  const stopping = h.plugin.stop().then(() => { stopped = true; });
  await settle(); assert.equal(stopped, false);
  release(); await stopping;
  assert.equal(h.perception.pendingCount(), 1);
  assert.equal(Object.keys(h.storage.collection("gitlab.pipelines").list()[0].value.seen).length, 1);
  await h.plugin.dispose(); assert.equal(h.perception.pendingCount(), 0);
});

test("bounded JSON reader rejects declared and streamed oversized bodies", async () => {
  const signal = new AbortController().signal;
  await assert.rejects(readJson(response([], { "content-length": "9999" }), 1024, signal), /过大/);
  await assert.rejects(readJson(response(["x".repeat(2000)]), 1024, signal), /过大/);
  await assert.rejects(readJson(new Response("<html>login</html>"), 1024, signal), /JSON/);
});

test("configuration is optional, validated and stable after normalization", () => {
  assert.equal(definition.shouldLoad(normalizeConfig({})), false);
  const config = normalizeConfig({ plugins: [{ name: "gitlab", tokenEnv: "GITLAB_TOKEN",
    projects: [{ id: 42, ref: "main", statuses: ["failed"] }] }] });
  assert.equal(definition.shouldLoad(config), true);
  assert.deepEqual(normalizeConfig(config), config);
  for (const options of [{ baseUrl: "file:///tmp" }, { baseUrl: "https://u:p@host" },
    { baseUrl: "https://host?token=secret" }, { projects: "x" }, { projects: [0] },
    { projects: [{ id: 1, statuses: ["invalid"] }] }, { projects: [{ id: 1, ref: 1 }] },
    { projects: [1, "1"] }, { token: 1 }, { token: "x", tokenEnv: "TOKEN" },
    { tokenEnv: "invalid-key" }, { proxy: "socks5://host" }, { interval_ms: 0 },
    { maxPages: 0 }, { emitOnFirstFetch: "yes" }, { unexpected: true }]) {
    assert.throws(() => normalizeConfig({ plugins: [{ name: "gitlab", ...options }] }));
  }
});

test("host reload unloads timers and pending observations while retaining checkpoints", async t => {
  const stored = workStorage(), bus = new MessageBus(), services = createServiceRegistry();
  services.register("storage", stored.storage);
  const perception = createPerceptionService(bus), timers = new Set();
  let items = [pipeline(1)];
  const config = normalizeConfig({ plugins: [{ name: "gitlab", token: "secret", projects: [1], emitOnFirstFetch: true }] });
  const host = createPluginHost({ bus, services, storage: stored.core, perception, getConfig: () => config,
    definitions: [{ ...definition, load: () => ({ activate: context => createGitlabPlugin(context, {
      fetch: async () => response(items), setTimeout: callback => { const timer = { callback }; timers.add(timer); return timer; },
      clearTimeout: timer => timers.delete(timer),
    }) }) }] });
  t.after(async () => { await host.dispose(); stored.db.close(); });
  await host.activate(); await host.start(); await settle();
  assert.equal(host.getState().gitlab.status, "running");
  assert.equal(perception.pendingCount(), 1);
  await host.reload(normalizeConfig({ plugins: [{ name: "gitlab", enabled: false }] }));
  assert.equal(perception.pendingCount(), 0); assert.equal(timers.size, 0);
  items = [pipeline(1), pipeline(2)]; await host.reload(config); await settle();
  assert.equal(perception.pendingCount(), 1);
});

test("query history retains baseline, unchanged, filtered and delivered pipeline results with raw pages", async t => {
  const h = harness(t, { projects: [{ id: "team/project", statuses: ["failed"] }] });
  h.items([pipeline(1, "failed"), pipeline(2)]);
  await h.start();
  let record = latestLog(h);
  assert.equal(record.state, "baseline");
  assert.equal(record.pageCount, 1);
  assert.equal(record.status, 200);
  assert.deepEqual(record.items.map(item => item.delivery), ["baseline", "filtered"]);
  assert.deepEqual(JSON.parse(record.pages[0].rawBody).map(item => item.id), [1, 2]);
  assert.equal(record.request.statuses[0], "failed");
  assert.equal(record.matchedCount, 1);
  await h.poll();
  record = latestLog(h);
  assert.equal(record.state, "success");
  assert.deepEqual(record.items.map(item => item.delivery), ["unchanged", "unchanged"]);
  h.items([pipeline(1, "running"), pipeline(2, "failed")]); await h.poll();
  record = latestLog(h);
  assert.deepEqual(record.items.map(item => [item.delivery, item.previousStatus]), [["filtered", "failed"], ["queued", "running"]]);
  assert.equal(record.queuedCount, 1);
  assert.match(record.items[1].observationId, /^gitlab:/);
  assert.equal(h.perception.pendingCount(), 1);
});

test("query history preserves all pages, partial results, invalid JSON, HTTP bodies and rate limits without exposing token", async t => {
  const paged = harness(t, {}, { fetch: async url => {
    const page = Number(new URL(url).searchParams.get("page"));
    return response([pipeline(page, "failed", { ref: "test-secret" })], { "x-next-page": page === 1 ? "2" : "" });
  } });
  await paged.start();
  const pages = latestLog(paged).pages;
  assert.equal(pages.length, 2);
  assert.equal(pages[0].response.nextPage, "2");
  assert.equal(pages[1].itemCount, 1);
  assert.doesNotMatch(JSON.stringify(latestLog(paged)), /test-secret|PRIVATE-TOKEN/);
  const partial = harness(t, { maxPages: 1 }, { fetch: async () => response([pipeline(1)], { "x-next-page": "2" }) });
  await partial.start();
  assert.equal(latestLog(partial).state, "failed");
  assert.match(latestLog(partial).error, /maxPages/);
  assert.equal(JSON.parse(latestLog(partial).pages[0].rawBody)[0].id, 1);
  for (const status of [200, 401, 429]) {
    const h = harness(t, {}, { fetch: async () => new Response("<html>test-secret denied</html>",
      { status, headers: { "retry-after": "120" } }) });
    await h.start();
    const record = latestLog(h);
    assert.equal(record.state, "failed");
    assert.equal(record.pages[0].response.status, status);
    assert.equal(record.pages[0].rawBody, "<html>[redacted] denied</html>");
    assert.match(record.error, status === 200 ? /JSON/ : new RegExp(`HTTP ${status}`));
    if (status === 429) assert.equal(record.retryAfterMs, 120000);
    assert.equal(h.storage.collection("gitlab.pipelines").list().length, 0);
  }
});

test("query history records partially accepted observations and queue errors without altering retries", async t => {
  const h = harness(t, { emitOnFirstFetch: true });
  let count = 0;
  const submit = h.context.perception.submit;
  h.context.perception.submit = async item => {
    if (++count === 2) throw new Error("queue full test-secret");
    return submit(item);
  };
  h.items([pipeline(1, "failed"), pipeline(2, "failed")]); await h.start();
  const record = latestLog(h);
  assert.equal(record.state, "failed");
  assert.equal(record.queuedCount, 1);
  assert.deepEqual(record.items.map(item => item.delivery), ["queued", "failed"]);
  assert.equal(record.items[1].error, "queue full [redacted]");
  await h.poll();
  assert.equal(latestLog(h).queuedCount, 1);
  assert.equal(h.perception.pendingCount(), 2);
});

test("clearing raw logs removes query history, preserves checkpoints and blocks late writes", async t => {
  const h = harness(t); await h.start();
  const history = createGitlabHistory(h.storage), oldId = latestLog(h).id;
  const checkpoint = h.storage.collection("gitlab.pipelines").list()[0];
  assert.equal(createRawLogRepository(h.storage).clear().gitlab, 1);
  assert.deepEqual(h.storage.collection("gitlab.pipelines").list()[0], checkpoint);
  history.update(oldId, { state: "success", pages: [{ rawBody: "late" }] });
  assert.equal(history.list().entries.length, 0);
  await h.poll(); assert.equal(history.list().entries.length, 1);
  assert.equal(h.perception.pendingCount(), 0);
  let resolve;
  const late = harness(t, {}, { fetch: () => new Promise(done => { resolve = done; }) });
  await late.start();
  assert.equal(createRawLogRepository(late.storage).clear().gitlab, 1);
  resolve(response([pipeline(1)])); await settle();
  assert.equal(createGitlabHistory(late.storage).list().entries.length, 0);
  assert.equal(late.storage.collection("gitlab.pipelines").list().length, 1);
});

test("query history recovers interruptions, bounds retention and paginates metadata without response bodies", t => {
  const h = workStorage(); t.after(() => h.db.close());
  let clock = 1;
  const history = createGitlabHistory(h.storage, { now: () => clock++ });
  for (let i = 0; i < MAX_RECORDS + 2; i++) history.begin({ id: `check-${i}`, pages: [{ rawBody: "large" }], items: [pipeline(i + 1)] });
  assert.equal(history.list({ limit: 100 }).entries.length, 100);
  assert.equal(h.storage.collection("gitlab.history").list().length, MAX_RECORDS);
  const first = history.list({ limit: 100 }), second = history.list({ before: first.nextCursor, limit: 100 });
  assert.equal(new Set([...first.entries, ...second.entries].map(e => e.id)).size, MAX_RECORDS);
  assert.equal(second.nextCursor, null);
  assert.equal(first.entries[0].pages, undefined);
  assert.equal(first.entries[0].items, undefined);
  assert.throws(() => history.get("check-0"), /不存在/);
  history.recover();
  assert.equal(history.get(first.entries[0].id).state, "cancelled");
  assert.equal(history.get(first.entries[0].id).pages[0].rawBody, "large");
  assert.throws(() => history.list({ before: "invalid" }), /游标/);
  assert.throws(() => history.list({ limit: 101 }), /分页/);
});

test("query logging storage failures do not block accepted observations", async t => {
  const h = harness(t, { emitOnFirstFetch: true });
  const collection = h.storage.collection;
  h.storage.collection = name => name === "gitlab.history" ? {
    get() { throw new Error("log store unavailable"); }, list() { throw new Error("log store unavailable"); },
    set() { throw new Error("log store unavailable"); },
  } : collection(name);
  await h.start();
  assert.equal(h.perception.pendingCount(), 1);
  assert.equal(h.storage.collection("gitlab.pipelines").list().length, 1);
  assert.ok(h.warnings.some(w => /日志保存失败/.test(w)));
});
