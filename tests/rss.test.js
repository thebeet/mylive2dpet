const test = require("node:test");
const assert = require("node:assert/strict");
const { workStorage } = require("./helpers/workStorage");
const { parseFeed, hash } = require("../electron/plugins/rss/parser");
const { createRssPlugin, readFeed } = require("../electron/plugins/rss");
const definition = require("../electron/plugins/rss/definition");
const { normalizeConfig } = require("../electron/config");
const { MessageBus } = require("../electron/architecture/messageBus");
const { createPerceptionService } = require("../electron/architecture/perceptionService");
const { createPluginHost } = require("../electron/pluginHost");
const { createServiceRegistry } = require("../electron/architecture/serviceRegistry");
const { createWorkMemory } = require("../electron/plugins/memory/workMemory");
const { createRssHistory, MAX_RECORDS } = require("../electron/plugins/rss/history");
const { createRawLogRepository } = require("../electron/plugins/rawLog/repository");

const URL = "https://example.com/feed";
const settle = () => new Promise(resolve => setImmediate(resolve));
const item = (id, content = "正文", date = "2026-11-04T10:00:00Z") =>
  `<item><guid>${id}</guid><title>标题 ${id}</title><link>/posts/${id}</link><pubDate>${date}</pubDate><description><![CDATA[<p>${content}</p>]]></description></item>`;
const rss = (...items) => `<rss version="2.0"><channel><title>订阅测试</title>${items.join("")}</channel></rss>`;
const response = (xml, headers = {}) => new Response(xml, { headers });

function harness(t, options = {}, overrides = {}, existing) {
  const stored = existing || workStorage();
  const bus = new MessageBus();
  const perception = createPerceptionService(bus);
  const timers = new Set(), requests = [], warnings = [];
  let currentXml = rss(item("1"));
  let clock = Date.now();
  const context = { config: { get: () => ({ plugins: [{ name: "rss", feeds: [URL], ...options }] }) },
    storage: stored.storage, perception, logger: { warn: message => warnings.push(message) } };
  const dependencies = { now: () => clock,
    fetch: async (url, init) => { requests.push({ url, init }); return response(currentXml); },
    setTimeout: (callback, ms) => { const timer = { callback, ms }; timers.add(timer); return timer; },
    clearTimeout: timer => timers.delete(timer), ...overrides };
  const plugin = createRssPlugin(context, dependencies);
  t.after(async () => { await plugin.dispose(); if (!existing) stored.db.close(); });
  return { ...stored, plugin, perception, context, requests, timers, warnings,
    xml: value => { currentXml = value; }, advance: ms => { clock += ms; },
    async start() { plugin.start(); await settle(); },
    async poll() {
      assert.equal(timers.size, 1);
      const timer = [...timers][0]; timers.delete(timer); clock += timer.ms; timer.callback(); await settle();
    },
  };
}

test("parses RSS 2, Atom XHTML and RSS 1 with stable identities and plain content", () => {
  const parsed = parseFeed(rss(item("001", "A &amp; B")), URL);
  assert.equal(parsed.items[0].content, "A & B");
  assert.equal(parsed.items[0].link, "https://example.com/posts/001");
  const atom = parseFeed(`<feed xmlns="http://www.w3.org/2005/Atom"><title>项目动态</title>
    <entry><id>tag:example,1</id><title>提交</title><updated>2026-11-04T10:00:00Z</updated>
    <link rel="self" href="/api/1"/><link rel="alternate" href="/commit/1"/>
    <author><name>作者</name></author><content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>修复 <b>登录</b></p></div></content>
    </entry></feed>`, URL);
  assert.equal(atom.items[0].content, "修复 登录");
  assert.equal(atom.items[0].author, "作者");
  assert.equal(atom.items[0].link, "https://example.com/commit/1");
  const rdf = parseFeed(`<rdf:RDF xmlns:rdf="urn:rdf"><channel><title>旧格式</title></channel>${item("1")}</rdf:RDF>`, URL);
  assert.equal(rdf.items.length, 1);
  assert.equal(parseFeed(rss(item("1"), item("1")), URL).items.length, 1);
  assert.equal(parseFeed(rss(item("1", "修改")), URL).items[0].id, parseFeed(rss(item("1")), URL).items[0].id);
});

test("parses GitLab Atom HTML void tags without losing following content", () => {
  const atom = content => `<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>commit:1</id>
    <content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">${content}</div></content>
    </entry></feed>`;
  for (const content of ["<p>before<br>after<img src='/avatar.png'>tail</p><hr><p>end<wbr>text</p>",
    "<p>before<br/>after<img src='/avatar.png'/>tail</p><hr/><p>end<wbr/>text</p>",
    "<p>before<br></br>after<img src='/avatar.png'></img>tail</p><hr></hr><p>end<wbr></wbr>text</p>"]) {
    assert.equal(parseFeed(atom(content), URL).items[0].content, "before after tail end text");
  }
  assert.throws(() => parseFeed(atom("<p>before<br>after</div>"), URL), /XML 格式无效/);
});

test("rejects malformed XML, non-feed pages and entity declarations", () => {
  for (const xml of ["<rss>", "<html><body>login</body></html>", '<!DOCTYPE rss [<!ENTITY x "bad">]><rss/>']) {
    assert.throws(() => parseFeed(xml, URL));
  }
  assert.equal(parseFeed(rss(), URL).items.length, 0);
});

test("first fetch seeds state; new and edited entries queue once without forcing a decision", async t => {
  const h = harness(t);
  await h.start();
  assert.equal(h.perception.pendingCount(), 0);
  h.xml(rss(item("2", "新增", "2026-11-04T11:00:00Z"), item("1", "修改")));
  await h.poll();
  const observations = await h.perception.takeBatch();
  assert.equal(observations.length, 2);
  assert.equal(observations[0].source, "rss");
  assert.equal(observations[0].role, "context");
  assert.equal(observations[0].expiresAt, undefined);
  assert.equal(JSON.parse(observations[0].content[0].text).eventType, "updated");
  assert.equal(JSON.parse(observations[1].content[0].text).content, "新增");
  await h.poll();
  assert.equal(h.perception.pendingCount(), 0);
  assert.equal(h.timers.size, 1);
});

test("persistent checkpoints survive plugin recreation and capture offline updates", async t => {
  const h = harness(t);
  await h.start(); await h.plugin.stop();
  const recovered = harness(t, { feeds: [{ url: URL, proxy: "http://localhost:8899" }] }, {}, { storage: h.storage, db: h.db });
  recovered.xml(rss(item("1"), item("2")));
  await recovered.start();
  assert.equal(recovered.perception.pendingCount(), 1);
  assert.equal(JSON.parse((await recovered.perception.takeBatch())[0].content[0].text).title, "标题 2");
  await recovered.poll();
  assert.equal(recovered.perception.pendingCount(), 0);
});

test("optional initial emission, truncation and TTL apply at actual observation capture", async t => {
  const h = harness(t, { emitOnFirstFetch: true, maxContentChars: 100, observationTtlMs: 60000 });
  h.xml(rss(item("1", "字".repeat(150))));
  await h.start();
  const [observation] = await h.perception.takeBatch();
  const data = JSON.parse(observation.content[0].text);
  assert.equal(data.content.length, 100);
  assert.equal(data.truncated, true);
  assert.equal(observation.expiresAt - Date.parse(observation.capturedAt), 60000);
});

test("HTTP validators are reused and 304 does not emit duplicate observations", async t => {
  const calls = [];
  const h = harness(t, {}, { fetch: async (url, init) => {
    calls.push(init.headers);
    return calls.length === 1 ? response(rss(item("1")), { etag: '"v1"', "last-modified": "Wed, 04 Nov 2026 10:00:00 GMT" })
      : new Response(null, { status: 304 });
  } });
  await h.start(); await h.poll();
  assert.equal(calls[1]["If-None-Match"], '"v1"');
  assert.equal(calls[1]["If-Modified-Since"], "Wed, 04 Nov 2026 10:00:00 GMT");
  assert.equal(h.perception.pendingCount(), 0);
  const logs = createRssHistory(h.storage);
  const log = logs.get(logs.list().entries[0].id);
  assert.equal(log.state, "not-modified");
  assert.equal(log.status, 304);
  assert.equal(log.rawXml, undefined);
});

test("failed ingress retains unsent changes and does not commit new HTTP validators", async t => {
  let version = 0, reject = true, count = 0;
  const h = harness(t, {}, { fetch: async () => response(version ? rss(item("1"), item("2"), item("3")) : rss(item("1")),
    { etag: version ? '"new"' : '"old"' }) });
  const submit = h.context.perception.submit;
  h.context.perception.submit = async observation => {
    count++;
    if (count === 2 && reject) throw new Error("queue full");
    return submit(observation);
  };
  await h.start(); version = 1; await h.poll();
  assert.equal(h.storage.collection("rss.feeds").get(hash(URL)).etag, '"old"');
  reject = false; await h.poll();
  assert.equal(count, 3, "accepted item is not replayed; failed item is retried");
  assert.equal(h.perception.pendingCount(), 2);
  assert.equal(h.storage.collection("rss.feeds").get(hash(URL)).etag, '"new"');
});

test("one failing feed does not prevent other subscriptions; failures never establish a baseline", async t => {
  let broken = true;
  const h = harness(t, { feeds: [URL, "https://example.org/feed"], emitOnFirstFetch: true }, {
    fetch: async url => url === URL && broken ? response("<html>login</html>") : response(rss(item("1"))),
  });
  await h.start();
  assert.equal(h.perception.pendingCount(), 1);
  assert.equal(h.storage.collection("rss.feeds").get(hash(URL)), undefined);
  broken = false; await h.poll();
  assert.equal(h.perception.pendingCount(), 2);
  assert.equal(h.warnings.length, 1);
});

test("proxy is configured once and access tokens are absent from observations and warnings", async t => {
  const url = `${URL}?feed_token=private-secret`;
  const proxies = [];
  let fail = false;
  const h = harness(t, { feeds: [{ url, proxy: "http://127.0.0.1:8899" }], emitOnFirstFetch: true }, {
    configureProxy: async proxy => proxies.push(proxy),
    fetch: async requested => {
      assert.equal(requested, url);
      if (fail) throw new Error(`failure ${url}`);
      return response(rss(item("1", "private-secret")));
    },
  });
  await h.start();
  const [observation] = await h.perception.takeBatch();
  assert.doesNotMatch(JSON.stringify(observation), /private-secret|feed_token/);
  const logs = createRssHistory(h.storage);
  assert.doesNotMatch(JSON.stringify(logs.get(logs.list().entries[0].id)), /private-secret/);
  fail = true; await h.poll();
  assert.deepEqual(proxies, ["http://127.0.0.1:8899"]);
  assert.doesNotMatch(h.warnings.join(""), /private-secret/);
});

test("each feed uses its own proxy route, direct feeds are isolated and matching routes reuse setup", async t => {
  const proxyA = "http://localhost:8899", proxyB = "http://localhost:9000";
  const feeds = [{ url: URL, proxy: proxyA }, { url: "https://example.org/feed", proxy: proxyB },
    "https://direct.example/feed", { url: "https://shared.example/feed", proxy: proxyA }];
  const sessions = [], calls = [];
  const h = harness(t, { feeds }, { fetch: undefined, getSession: partition => {
    const session = { partition, configurations: [],
      async setProxy(options) { this.configurations.push(options); },
      async fetch(url) { calls.push({ url, route: this.configurations[0] }); return response(rss(item("1"))); },
    };
    sessions.push(session); return session;
  } });
  await h.start(); await h.poll();
  assert.equal(sessions.length, 3);
  assert.equal(new Set(sessions.map(session => session.partition)).size, 3);
  assert.ok(sessions.every(session => session.configurations.length === 1));
  const expected = [{ proxyRules: proxyA }, { proxyRules: proxyB }, { mode: "direct" }, { proxyRules: proxyA }];
  assert.deepEqual(calls.slice(0, 4).map(call => call.route), expected);
  assert.deepEqual(calls.slice(4).map(call => call.route), expected);
  assert.equal(h.warnings.length, 0);
});

test("feed-specific intervals poll independently while omitted intervals inherit the plugin default", async t => {
  const fast = "https://fast.example/feed", slow = "https://slow.example/feed";
  const h = harness(t, { interval_ms: 5000, feeds: [URL,
    { url: fast, interval_ms: 1000 }, { url: slow, interval_ms: 10000 }] });
  await h.start();
  assert.deepEqual(h.requests.map(request => request.url), [URL, fast, slow]);
  assert.equal([...h.timers][0].ms, 1000);
  for (let i = 0; i < 4; i++) await h.poll();
  assert.equal(h.requests.filter(request => request.url === URL).length, 1);
  assert.equal(h.requests.filter(request => request.url === fast).length, 5);
  assert.equal(h.requests.filter(request => request.url === slow).length, 1);
  await h.poll();
  assert.deepEqual(h.requests.slice(-2).map(request => request.url), [URL, fast]);
  for (let i = 0; i < 5; i++) await h.poll();
  assert.equal(h.requests.filter(request => request.url === URL).length, 3);
  assert.equal(h.requests.filter(request => request.url === fast).length, 11);
  assert.equal(h.requests.filter(request => request.url === slow).length, 2);
});

test("each polling interval starts at that feed's completion time", async t => {
  const h = harness(t, { interval_ms: 5000, feeds: [{ url: URL, interval_ms: 1000 }, "https://other.example/feed"] }, {
    fetch: async () => { h.advance(250); return response(rss(item("1"))); },
  });
  await h.start();
  assert.equal([...h.timers][0].ms, 750);
  await h.poll();
  assert.equal([...h.timers][0].ms, 1000);
});

test("an empty subscription list does not schedule polling", async t => {
  const h = harness(t, { feeds: [] });
  await h.start();
  assert.equal(h.requests.length, 0);
  assert.equal(h.timers.size, 0);
});

test("a failed feed proxy setup is retried next poll while other routes continue", async t => {
  const proxy = "http://localhost:8899";
  let attempts = 0;
  const setups = [];
  const h = harness(t, { feeds: [{ url: URL, proxy }, "https://direct.example/feed"], emitOnFirstFetch: true }, {
    configureProxy: async route => {
      setups.push(route);
      if (route === proxy && ++attempts === 1) throw new Error("proxy setup failed");
    },
  });
  await h.start();
  assert.equal(h.perception.pendingCount(), 1);
  await h.poll();
  assert.equal(h.perception.pendingCount(), 2);
  assert.deepEqual(setups, [proxy, "", proxy]);
});

test("stop aborts requests and discards late results; polling never overlaps", async t => {
  let resolve, signal, count = 0;
  const h = harness(t, { emitOnFirstFetch: true }, { fetch: async (_url, init) => {
    count++; signal = init.signal;
    return new Promise(done => { resolve = done; });
  } });
  await h.start(); h.plugin.start();
  assert.equal(count, 1); assert.equal(h.timers.size, 0);
  const stopping = h.plugin.stop();
  assert.equal(signal.aborted, true);
  resolve(response(rss(item("1")))); await stopping;
  assert.equal(h.perception.pendingCount(), 0);
  assert.equal(h.timers.size, 0);
  assert.equal(h.storage.collection("rss.feeds").list().length, 0);
});

test("stop waits for accepted ingress and records it without submitting remaining items", async t => {
  let release;
  const h = harness(t, { emitOnFirstFetch: true });
  h.xml(rss(item("1"), item("2")));
  const submit = h.context.perception.submit;
  h.context.perception.submit = async observation => {
    await new Promise(resolve => { release = resolve; });
    return submit(observation);
  };
  await h.start();
  let stopped = false;
  const stopping = h.plugin.stop().then(() => { stopped = true; });
  await settle(); assert.equal(stopped, false);
  release(); await stopping;
  assert.equal(h.perception.pendingCount(), 1);
  assert.equal(Object.keys(h.storage.collection("rss.feeds").get(hash(URL)).seen).length, 1);
  assert.equal(h.timers.size, 0);
});

test("bounded response reading rejects declared and streamed oversized bodies and decodes XML encodings", async () => {
  const signal = new AbortController().signal;
  await assert.rejects(readFeed(response("xx", { "content-length": "5000" }), 1024, signal), /过大/);
  await assert.rejects(readFeed(response("x".repeat(2000)), 1024, signal), /过大/);
  const xml = '<?xml version="1.0" encoding="UTF-16LE"?><rss><channel><title>中文</title></channel></rss>';
  assert.equal(parseFeed(await readFeed(response(Buffer.from(xml, "utf16le")), 4096, signal), URL).title, "中文");
});

test("configuration is optional, validated and stable after normalization", () => {
  assert.equal(definition.shouldLoad(normalizeConfig({})), false);
  const config = normalizeConfig({ plugins: [{ name: "rss", feeds: [{ url: URL, proxy: "http://localhost:8899" }] }] });
  assert.equal(definition.shouldLoad(config), true);
  assert.deepEqual(normalizeConfig(config), config);
  const timed = normalizeConfig({ plugins: [{ name: "rss", interval_ms: 5000,
    feeds: [{ url: URL, interval_ms: 1000 }, "https://other.example/feed"] }] });
  assert.deepEqual(normalizeConfig(timed), timed);
  const rssOptions = timed.plugins.find(plugin => plugin.name === "rss");
  assert.equal(rssOptions.feeds[0].interval_ms, 1000);
  assert.equal(rssOptions.feeds[1].interval_ms, undefined);
  assert.equal(rssOptions.interval_ms, 5000);
  for (const options of [{ feeds: "x" }, { feeds: ["file:///a"] }, { feeds: [URL, URL] },
    { feeds: [{ url: URL, name: 1 }] }, { feeds: [{ url: URL, proxy: "socks5://localhost" }] },
    { feeds: [{ url: URL, proxy: 1 }] }, { feeds: [{ url: URL, interval_ms: 0 }] },
    { feeds: [{ url: URL, interval_ms: 86400001 }] }, { proxy: "http://localhost:8899" }, { interval_ms: 0 },
    { maxContentChars: 0 }, { emitOnFirstFetch: "yes" }, { unexpected: true }]) {
    assert.throws(() => normalizeConfig({ plugins: [{ name: "rss", ...options }] }));
  }
});

test("host unload cancels timers and removes RSS observations; reenable preserves checkpoints", async t => {
  const stored = workStorage(), bus = new MessageBus(), services = createServiceRegistry();
  services.register("storage", stored.storage);
  const perception = createPerceptionService(bus);
  const timers = new Set();
  let xml = rss(item("1"));
  const config = normalizeConfig({ plugins: [{ name: "rss", feeds: [URL], emitOnFirstFetch: true }] });
  const host = createPluginHost({ bus, services, storage: stored.core, perception,
    getConfig: () => config, definitions: [{ ...definition, load: () => ({ activate: context => createRssPlugin(context, {
      fetch: async () => response(xml), setTimeout: callback => { const timer = { callback }; timers.add(timer); return timer; },
      clearTimeout: timer => timers.delete(timer),
    }) }) }] });
  t.after(async () => { await host.dispose(); stored.db.close(); });
  await host.activate(); await host.start(); await settle();
  assert.equal(host.getState().rss.status, "running");
  assert.equal(perception.pendingCount(), 1);
  await host.reload(normalizeConfig({ plugins: [{ name: "rss", enabled: false }] }));
  assert.equal(perception.pendingCount(), 0); assert.equal(timers.size, 0);
  xml = rss(item("1"), item("2"));
  await host.reload(config); await settle();
  assert.equal(perception.pendingCount(), 1);
});

test("RSS articles are not ingested as evidence about the user's personal relationships", t => {
  const stored = workStorage(); t.after(() => stored.db.close());
  const work = createWorkMemory({ services: { get: () => stored.storage } }, {
    options: () => ({ enabled: true, storageService: "storage", work: { enabled: true } }),
    isAvailable: () => true,
  });
  work.ingestObservation({ source: "rss", role: "context", content: [{ type: "text", text: "某人发布了文章" }] });
  assert.equal(stored.storage.hasRepository("work-memory"), false);
});

test("fetch history records baseline XML, full parsed content and entry delivery without replaying updates", async t => {
  const h = harness(t, { maxContentChars: 100 });
  const logs = createRssHistory(h.storage);
  const baselineXml = rss(item("1", "初始正文"));
  h.xml(baselineXml); await h.start();
  const initial = logs.get(logs.list().entries[0].id);
  assert.equal(initial.state, "baseline");
  assert.equal(initial.rawXml, baselineXml);
  assert.equal(initial.items[0].delivery, "baseline");
  assert.equal(initial.queuedCount, 0);
  assert.equal(initial.status, 200);
  h.xml(rss(item("1", "修改正文"), item("2", "字".repeat(150))));
  await h.poll();
  const latest = logs.get(logs.list().entries[0].id);
  assert.equal(latest.state, "success");
  assert.equal(latest.itemCount, 2);
  assert.equal(latest.changedCount, 2);
  assert.equal(latest.queuedCount, 2);
  assert.ok(latest.items.every(item => item.delivery === "queued" && item.observationId));
  assert.equal(latest.items[1].content.length, 150, "fetch logs retain content beyond observation truncation");
  const observations = await h.perception.takeBatch();
  assert.equal(JSON.parse(observations[1].content[0].text).content.length, 100);
  assert.equal(logs.list().entries[0].items, undefined);
  assert.equal(logs.list().entries[0].rawXml, undefined);
  await h.poll();
  const unchanged = logs.get(logs.list().entries[0].id);
  assert.equal(unchanged.queuedCount, 0);
  assert.ok(unchanged.items.every(item => item.delivery === "unchanged"));
});

test("fetch history retains HTTP and XML failures and partial queue submission outcomes", async t => {
  let mode = "http";
  const h = harness(t, { emitOnFirstFetch: true }, { fetch: async () => mode === "http"
    ? new Response("service unavailable", { status: 503 }) : response(mode === "xml" ? "<html>login page</html>" : rss(item("1"), item("2"))) });
  const logs = createRssHistory(h.storage);
  await h.start();
  let record = logs.get(logs.list().entries[0].id);
  assert.equal(record.state, "failed");
  assert.equal(record.status, 503);
  assert.equal(record.rawXml, "service unavailable");
  mode = "xml"; await h.poll();
  record = logs.get(logs.list().entries[0].id);
  assert.equal(record.state, "failed");
  assert.equal(record.rawXml, "<html>login page</html>");
  mode = "queue";
  const submit = h.context.perception.submit;
  let count = 0;
  h.context.perception.submit = async observation => {
    if (++count === 2) throw new Error("queue full");
    return submit(observation);
  };
  await h.poll();
  record = logs.get(logs.list().entries[0].id);
  assert.equal(record.state, "failed");
  assert.equal(record.queuedCount, 1);
  assert.deepEqual(record.items.map(item => item.delivery), ["queued", "failed"]);
  assert.equal(record.items[1].error, "queue full");
});

test("clearing raw logs removes RSS history but preserves checkpoints and rejects late fetch results", async t => {
  let resolve, calls = 0;
  const h = harness(t, {}, { fetch: async () => ++calls === 1 ? new Promise(done => { resolve = done; })
    : response(rss(item("1"), item("2"))) });
  const logs = createRssHistory(h.storage), raw = createRawLogRepository(h.storage);
  await h.start();
  assert.equal(logs.list().entries.length, 1);
  assert.equal(raw.clear().rss, 1);
  resolve(response(rss(item("1")))); await settle();
  assert.equal(logs.list().entries.length, 0);
  assert.equal(h.storage.collection("rss.feeds").get(hash(URL)).initialized, true);
  await h.poll();
  assert.equal(logs.list().entries.length, 1);
  assert.equal(h.perception.pendingCount(), 1);
  assert.equal(raw.clear().rss, 1);
  assert.equal(h.storage.collection("rss.feeds").get(hash(URL)).initialized, true);
  await h.poll();
  assert.equal(h.perception.pendingCount(), 1, "clearing fetch logs does not replay delivered entries");
});

test("RSS history paginates without bodies, recovers interrupted checks and retains a bounded history", t => {
  const stored = workStorage(); t.after(() => stored.db.close());
  const logs = createRssHistory(stored.storage, { now: () => 100 });
  for (const id of ["a", "b", "c"]) {
    logs.begin({ id, rawXml: "raw", items: [{ content: "body" }] });
    if (id !== "c") logs.update(id, { state: "success" });
  }
  const first = logs.list({ limit: 1 });
  assert.equal(first.entries[0].id, "c");
  assert.equal(first.entries[0].items, undefined);
  assert.equal(logs.list({ limit: 1, before: first.nextCursor }).entries[0].id, "b");
  const restored = createRssHistory(stored.storage);
  restored.recover();
  assert.equal(restored.get("c").state, "cancelled");
  assert.equal(restored.get("a").state, "success");
  for (const options of [{ limit: 0 }, { before: "invalid" }, { before: { t: 0 } }]) {
    assert.throws(() => restored.list(options));
  }
  for (let i = 0; i < MAX_RECORDS; i++) logs.begin({ id: `retained-${String(i).padStart(3, "0")}` });
  assert.equal(stored.storage.collection("rss.history").list().length, MAX_RECORDS);
  assert.throws(() => logs.get("a"), /已清理/);
});

test("RSS log write failures cannot prevent successful observation submission", async t => {
  const stored = workStorage();
  const storage = { ...stored.storage, collection(namespace) {
    if (namespace === "rss.history") throw new Error("history unavailable");
    return stored.storage.collection(namespace);
  } };
  const h = harness(t, { emitOnFirstFetch: true }, {}, { storage, db: stored.db });
  t.after(async () => { await h.plugin.dispose(); stored.db.close(); });
  await h.start();
  assert.equal(h.perception.pendingCount(), 1);
  assert.equal(storage.collection("rss.feeds").get(hash(URL)).initialized, true);
});
