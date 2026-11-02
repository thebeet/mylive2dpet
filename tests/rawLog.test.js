const test = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { EventEmitter } = require("node:events");
const { createModelClient } = require("../electron/llm/client");
const { createConversation } = require("../electron/conversation");
const { createRawLogRepository } = require("../electron/plugins/rawLog/repository");
const { normalizeUsage } = require("../electron/plugins/rawLog/usage");
const { activate } = require("../electron/plugins/rawLog");
const { MessageBus } = require("../electron/architecture/messageBus");
const EVENTS = require("../electron/architecture/events");
const { petPayload } = require("./helpers/petPayload");
const { createStorage } = require("../electron/storage");
const { createSqliteBackend } = require("../electron/plugins/storageSqlite/backend");
const { createScreenshotReader } = require("../electron/plugins/rawLog/screenshots");
const { clearRawLog } = require("../electron/plugins/rawLog/clear");
const { getLogGeneration } = require("../electron/storage/logLifecycle");
const { createPerceptionService } = require("../electron/architecture/perceptionService");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");

const quiet = { info() {}, warn() {}, error() {} };
function storageFor(db) {
  db.exec("CREATE TABLE IF NOT EXISTS test_migrations(namespace TEXT PRIMARY KEY, version INTEGER NOT NULL)");
  let next = 0;
  const adapter = {
    prepare: sql => db.prepare(sql), exec: sql => db.exec(sql),
    compact() { db.exec("VACUUM"); return { supported: true }; },
    transaction(work) {
      const name = `raw_test_${++next}`;
      db.exec(`SAVEPOINT ${name}`);
      try { const result = work(); db.exec(`RELEASE ${name}`); return result; }
      catch (error) { db.exec(`ROLLBACK TO ${name}; RELEASE ${name}`); throw error; }
    },
    migrate(name, migrations) {
      adapter.transaction(() => {
        const version = db.prepare("SELECT version FROM test_migrations WHERE namespace = ?").get(name)?.version || 0;
        for (let i = version; i < migrations.length; i++) migrations[i](adapter);
        db.prepare("INSERT INTO test_migrations VALUES (?, ?) ON CONFLICT(namespace) DO UPDATE SET version=excluded.version").run(name, migrations.length);
      });
    },
  };
  const core = createStorage();
  core.registerBackend(createSqliteBackend(adapter));
  return core.api;
}
function chat(options = {}) {
  return createConversation({
    getConfig: () => ({ conversation: { ai: {
      endpoint: "https://example.invalid/v1", apiKey: "secret-api-key", model: "test-model",
    } } }), getExpressions: () => ["neutral"], encodeImage: () => "actual-image",
    configureProxy: async () => {}, writeLog() {}, logger: quiet, ...options,
  });
}

test("raw log captures exact wire messages and images before sending, including text services", async () => {
  const starts = [], ends = [];
  const service = chat({ onRequest: (entry) => starts.push(entry), onResult: (entry) => ends.push(entry),
    fetchImpl: async (_url, init) => {
      assert.deepEqual(starts.at(-1).request, JSON.parse(init.body));
      assert.equal(ends.length, starts.length - 1);
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: {
        role: "assistant", content: JSON.stringify(petPayload({ response: "hello" })),
      } }] }) };
    } });
  await service.decideFromObservations([{ id: "input", source: "screen", role: "context",
    content: [{ type: "text", text: "屏幕观察" }, { type: "image", path: "/image.png" }] }]);
  const messages = [{ role: "system", content: "总结记忆" }, { role: "user", content: "原文\n第二行" }];
  await service.generateText(messages);
  assert.equal(starts.length, 2);
  assert.equal(starts[0].request.messages[1].content.at(-1).image_url.url, "data:image/jpeg;base64,actual-image");
  assert.deepEqual(starts[1].request.messages, messages);
  assert.equal(starts[0].sessionId, starts[1].sessionId);
  assert.notEqual(starts[0].id, starts[1].id);
  assert.deepEqual(ends.map((entry) => entry.id), starts.map((entry) => entry.id));
  assert.equal(ends[0].status, 200);
  assert.ok(!JSON.stringify({ starts, ends }).includes("secret-api-key"));
});

test("each retry is recorded separately and cancellation completes a pending request", async () => {
  const starts = [], ends = [];
  const controller = new AbortController();
  let attempts = 0;
  const service = chat({ onRequest: (entry) => starts.push(entry), onResult: (entry) => ends.push(entry),
    fetchImpl: async (_url, init) => {
      if (++attempts === 1) return { ok: false, status: 503, text: async () => '{"error":{"message":"try again"}}' };
      controller.abort(new Error("cancelled by user"));
      init.signal.throwIfAborted();
    } });
  await assert.rejects(service.generateText([{ role: "user", content: "hello" }], { signal: controller.signal }), /cancelled/);
  assert.equal(starts.length, 2);
  assert.equal(ends.length, 2);
  assert.notEqual(starts[0].id, starts[1].id);
  assert.equal(ends[0].status, 503);
  assert.match(ends[0].error, /try again/);
  assert.match(ends[1].error, /cancelled/);
});

test("failing log observers cannot prevent a successful model call", async () => {
  const service = chat({ storage: { isAvailable: () => true, collection() { throw new Error("log storage unavailable"); } },
    onRequest() { throw new Error("disk full"); }, onResult() { throw new Error("disk full"); },
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => '{"choices":[{"message":{"content":"ok"}}]}' }) });
  assert.equal(await service.generateText([{ role: "user", content: "hello" }]), "ok");
});

test("text calls reject exhausted reasoning budgets and partial output without treating them as empty facts", async () => {
  for (const content of [null, '[{"text":"用户喜欢喝咖啡"}]']) {
    const service = chat({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({
      model: "reasoning-model", choices: [{ finish_reason: "length", message: { content } }],
      usage: { completion_tokens: 256, completion_tokens_details: { reasoning_tokens: 256 } },
    }) }) });
    await assert.rejects(service.generateText([{ role: "user", content: "提取事实" }], { max_tokens: 256 }),
      error => {
        assert.equal(error.code, "AI_OUTPUT_TRUNCATED");
        assert.equal(error.retryable, false);
        assert.match(error.message, /token 上限.*model=reasoning-model.*finish_reason=length.*max_tokens=256.*reasoning_tokens=256/);
        return true;
      });
  }
});

test("text calls distinguish successful empty fact arrays from missing response content", async () => {
  let content = "[]";
  const service = chat({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({
    choices: [{ finish_reason: "stop", message: { content } }],
  }) }) });
  const messages = [{ role: "user", content: "提取事实" }];
  assert.equal(await service.generateText(messages), "[]");
  content = " ";
  await assert.rejects(service.generateText(messages), /返回空正文.*finish_reason=stop/);
});

test("text timeout overrides cover network and total budgets without changing ordinary calls or wire fields", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal;
  const service = createModelClient({
    configureProxy: async () => {}, writeLog() {}, logger: quiet,
    getOptions: () => ({
      endpoint: "https://example.invalid/v1", apiKey: "test", model: "test", timeoutMs: 10, retryBudgetMs: 20,
    }),
    fetchImpl: async (_url, init) => {
      signal = init.signal;
      const body = JSON.parse(init.body);
      for (const field of ["timeoutMs", "retryBudgetMs", "maxRetries"]) assert.ok(!Object.hasOwn(body, field));
      await new Promise((resolve) => setTimeout(resolve, 35));
      signal.throwIfAborted();
      return { ok: true, status: 200, text: async () => '{"choices":[{"message":{"content":"ok"}}]}' };
    },
  });
  const pending = service.generateText([{ role: "user", content: "整理记忆" }], {
    timeoutMs: 50, retryBudgetMs: 100, maxRetries: 0,
  });
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(25);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(10);
  assert.equal(await pending, "ok");
  const ordinary = assert.rejects(service.generateText([{ role: "user", content: "普通摘要" }], { maxRetries: 0 }), /超时（10ms）/);
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(11);
  await ordinary;
  assert.equal(signal.aborted, true);
});

test("SQLite pagination omits large content while details preserve raw request and response", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const repository = createRawLogRepository(storageFor(db));
  const request = { model: "test", messages: [{ role: "user", content: "<script>raw text</script>" }] };
  for (let i = 1; i <= 4; i++) repository.append({ id: `id-${i}`, sessionId: "session", t: i, label: "ai:text", request });
  repository.finish({ id: "id-4", finishedAt: 10, status: 200, response: { choices: [{ message: { role: "assistant", content: "reply" } }] } });
  const first = repository.list({ limit: 2 });
  assert.deepEqual(first.entries.map((entry) => entry.id), ["id-4", "id-3"]);
  assert.equal(first.entries[0].request, undefined);
  assert.equal(first.entries[0].finishedAt, 10);
  const second = repository.list({ limit: 2, before: first.nextCursor });
  assert.deepEqual(second.entries.map((entry) => entry.id), ["id-2", "id-1"]);
  assert.equal(second.nextCursor, null);
  assert.deepEqual(repository.get("id-4").request, request);
  assert.equal(repository.get("id-4").response.choices[0].message.content, "reply");
  assert.throws(() => repository.list({ before: "1 OR 1=1" }), /游标/);
  assert.throws(() => repository.get("missing"), /不存在/);
});

test("Storage screenshots are referenced in persisted logs while wire images and preview metadata stay intact", async (t) => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  const storage = storageFor(db);
  const original = Buffer.from("original screenshot");
  const blob = storage.blobs("screenshots").put(original, { mimeType: "image/jpeg", capturedAt: 100 });
  const uri = `storage://screenshots/${blob.id}`;
  const repository = createRawLogRepository(storage);
  let start;
  const service = chat({ storage, onRequest(entry) { start = entry; repository.append(entry); },
    onResult: entry => repository.finish(entry),
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body);
      assert.deepEqual(request, start.request);
      const image = request.messages.at(-1).content.at(-1);
      assert.equal(image.image_url.url, "data:image/jpeg;base64,actual-image");
      assert.equal(image.logImageSource, undefined);
      assert.equal(request.imageReferences, undefined);
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: {
        content: JSON.stringify(petPayload({ response: "hello" })),
      } }] }) };
    } });
  await service.decideFromObservations([{ id: "input", source: "screen", role: "context",
    content: [{ type: "image", uri }] }]);
  assert.deepEqual(start.imageReferences, [{ messageIndex: 1, contentIndex: 3, uri }]);
  const row = db.prepare("SELECT request_json FROM ai_requests").get();
  assert.ok(!row.request_json.includes("base64"));
  const result = repository.get(start.id);
  assert.equal(result.request.messages.at(-1).content.at(-1).image_url.url, uri);
  assert.equal(result.request.messages.at(-1).content.at(-1).logImageSource, "original");
  assert.equal(result.imagePreviews[uri].url, `data:image/jpeg;base64,${original.toString("base64")}`);
  assert.equal(db.prepare("SELECT count(*) AS n FROM storage_blobs").get().n, 1);
  storage.blobs("screenshots").delete(blob.id);
  assert.match(repository.get(start.id).imagePreviews[uri].error, /不存在/);
});

test("legacy inline images migrate losslessly once and repeated requests share one binary image", (t) => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  const storage = storageFor(db);
  const legacy = storage.repository("raw-log");
  const url = `data:image/png;base64,${Buffer.from("legacy image").toString("base64")}`;
  const request = { model: "test", messages: [{ role: "user", content: [
    { type: "image_url", image_url: { url, detail: "low" } },
    { type: "image_url", image_url: { url: "data:image/png;base64,not-valid!" } },
  ] }] };
  for (let i = 0; i < 30; i++) legacy.append({ id: `old-${i}`, sessionId: "old", t: i, label: "ai:vision", request });
  const repository = createRawLogRepository(storage);
  const result = repository.get("old-0");
  const part = result.request.messages[0].content[0];
  assert.match(part.image_url.url, /^storage:\/\/raw-log-images\//);
  assert.equal(part.image_url.detail, "low");
  assert.equal(result.imagePreviews[part.image_url.url].url, url);
  assert.deepEqual(result.request.messages[0].content[1], request.messages[0].content[1]);
  assert.equal(repository.get("old-1").request.messages[0].content[0].image_url.url, part.image_url.url);
  assert.equal(repository.get("old-29").request.messages[0].content[0].image_url.url, part.image_url.url);
  repository.append({ id: "retry", sessionId: "new", t: 3, label: "ai:vision", request });
  assert.equal(repository.get("retry").request.messages[0].content[0].image_url.url, part.image_url.url);
  assert.equal(request.messages[0].content[0].image_url.url, url);
  createRawLogRepository(storageFor(db));
  assert.equal(db.prepare("SELECT count(*) AS n FROM storage_blobs").get().n, 1);
});

test("image writes roll back with failed request inserts and missing original references preserve wire bytes", (t) => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  const storage = storageFor(db), repository = createRawLogRepository(storage);
  const request = { model: "test", messages: [{ role: "user", content: [] }] };
  const entry = { id: "same", sessionId: "s", t: 1, label: "ai:vision", request };
  repository.append(entry);
  const url = `data:image/jpeg;base64,${Buffer.from("fallback image").toString("base64")}`;
  request.messages[0].content.push({ type: "image_url", image_url: { url } });
  entry.imageReferences = [{ messageIndex: 0, contentIndex: 0, uri: "storage://screenshots/missing" }];
  assert.throws(() => repository.append(entry), /UNIQUE/);
  assert.equal(storage.blobs("raw-log-images").list().entries.length, 0);
  assert.equal(storage.collection("raw-log.image-index").list().length, 0);
  repository.append({ ...entry, id: "fallback" });
  const result = repository.get("fallback"), uri = result.request.messages[0].content[0].image_url.url;
  assert.equal(result.imagePreviews[uri].url, url);
});

test("failed legacy migration preserves the original row and can retry without orphan images", (t) => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  const storage = storageFor(db), legacy = storage.repository("raw-log");
  const url = `data:image/png;base64,${Buffer.from("migration image").toString("base64")}`;
  const request = { model: "test", messages: [{ content: [{ type: "image_url", image_url: { url } }] }] };
  legacy.append({ id: "old", sessionId: "s", t: 1, label: "ai:vision", request });
  db.exec("CREATE TRIGGER fail_migration BEFORE UPDATE OF request_json ON ai_requests BEGIN SELECT RAISE(ABORT, 'disk failure'); END");
  assert.throws(() => createRawLogRepository(storage), /disk failure/);
  assert.deepEqual(legacy.get("old").request, request);
  assert.equal(storage.blobs("raw-log-images").list().entries.length, 0);
  assert.equal(storage.collection("raw-log.image-index").list().length, 0);
  assert.equal(storage.collection("raw-log.migrations").get("image-references-v1"), undefined);
  db.exec("DROP TRIGGER fail_migration");
  const result = createRawLogRepository(storage).get("old");
  assert.equal(result.imagePreviews[result.request.messages[0].content[0].image_url.url].url, url);
  assert.equal(storage.blobs("raw-log-images").list().entries.length, 1);
});

test("screenshot tab paginates all saved captures without bytes and reads original images with grouped summaries", t => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  const storage = storageFor(db), reader = createScreenshotReader(storage);
  assert.deepEqual(reader.listScreenshots().entries, []);
  const captures = [];
  for (let i = 0; i < 4; i++) captures.push(storage.blobs("screenshots").put(Buffer.from(`original-${i}`), {
    mimeType: "image/jpeg", capturedAt: `2026-11-02T00:00:0${i}Z`, width: 1920, height: 1080,
    filename: `screen-${i}.jpg`, manual: i === 3, trigger: i === 3 ? "manual" : "interval",
  }));
  const analyses = [{ decisionId: "decision", completedAt: 100,
    screenshotIds: captures.slice(0, 2).map(entry => entry.id), screenSummary: "批次画面摘要", workSummary: "工作摘要" }];
  storage.blobs("screenshots").updateMetadata(captures[0].id, { analyses });
  const first = reader.listScreenshots({ limit: 2 });
  assert.deepEqual(first.entries.map(entry => entry.id), captures.slice(2).reverse().map(entry => entry.id));
  assert.equal(first.entries[0].metadata.manual, true);
  assert.ok(first.entries.every(entry => !Object.hasOwn(entry, "data") && !Object.hasOwn(entry, "imageUrl")));
  const next = reader.listScreenshots({ limit: 2, before: first.nextCursor });
  assert.deepEqual(next.entries.map(entry => entry.id), captures.slice(0, 2).reverse().map(entry => entry.id));
  assert.equal(next.nextCursor, null);
  const detail = reader.getScreenshot(captures[0].id);
  assert.deepEqual(detail.metadata.analyses, analyses);
  assert.equal(detail.imageUrl, `data:image/jpeg;base64,${Buffer.from("original-0").toString("base64")}`);
  assert.equal(detail.uri, `storage://screenshots/${captures[0].id}`);
  assert.equal(detail.data, undefined);
  assert.throws(() => reader.listScreenshots({ before: "bad" }), /cursor/);
  assert.throws(() => reader.getScreenshot(null), /无效/);
  const other = storage.blobs("raw-log-images").put(Buffer.from("other"), { mimeType: "image/png" });
  assert.throws(() => reader.getScreenshot(other.id), /不存在/);
  storage.blobs("screenshots").delete(captures[0].id);
  assert.throws(() => reader.getScreenshot(captures[0].id), /不存在/);
});

test("conversation groups merge turns and retries, preserve full requests, sum usage and paginate whole sessions", t => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  const storage = storageFor(db), repository = createRawLogRepository(storage);
  const system = { role: "system", content: "shared-system" };
  const initial = [{ role: "user", content: "initial-context" }];
  const append = (id, conversation, messages, label = "ai:vision") => repository.append({
    id, sessionId: "process", t: Number(id.slice(1)), label, conversation, request: { model: "test", messages },
  });
  const finish = (id, error = "") => repository.finish({ id, finishedAt: 100, error, status: error ? 503 : 200,
    response: { choices: [{ message: { role: "assistant", content: `reply-${id}` } }], usage: {
      prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 30 },
    } } });
  const c1 = { id: "context-one", kind: "turn", turn: 1, turnId: "turn-one" };
  const firstMessages = [system, ...initial, { role: "user", content: "input-one" }];
  append("r1", c1, firstMessages); finish("r1", "retry");
  append("r2", c1, firstMessages); finish("r2");
  append("r3", { ...c1, turn: 2, turnId: "turn-two" }, [system, ...initial,
    { role: "user", content: "old input" }, { role: "assistant", content: "old reply" },
    { role: "user", content: "input-two" }]); finish("r3");
  append("r4", { id: "context-one", kind: "summary" }, [system, { role: "user", content: "summary-input" }], "ai:text"); finish("r4");
  append("r5", { id: "context-two", kind: "turn", turn: 1, turnId: "turn-three" }, [system, { role: "user", content: "new-context" }]);
  append("r6", undefined, [system, { role: "user", content: "independent-memory-task" }], "ai:text"); finish("r6");
  const first = repository.listGroups({ limit: 2 });
  assert.deepEqual(first.entries.map(entry => entry.id), ["request:r6", "conversation:context-two"]);
  assert.equal(first.entries[1].pendingCount, 1);
  assert.equal(first.entries[1].finishedAt, null);
  assert.equal(first.entries[1].usageComplete, false);
  const next = repository.listGroups({ before: first.nextCursor, limit: 2 });
  assert.deepEqual(next.entries.map(entry => entry.id), ["conversation:context-one"]);
  const group = next.entries[0];
  assert.equal(group.turnCount, 2);
  assert.equal(group.requestCount, 4);
  assert.equal(group.summaryCount, 1);
  assert.equal(group.errorCount, 1);
  assert.equal(group.pendingCount, 0);
  assert.equal(group.usage.inputTokens, 400);
  assert.equal(group.usage.totalTokens, 440);
  assert.equal(group.usage.cachedTokens, 120);
  assert.equal(group.usage.uncachedTokens, 280);
  assert.equal(group.usage.reasoningTokens, null);
  assert.equal(group.request, undefined);
  const detail = repository.getGroup(group.id);
  assert.deepEqual(detail.initialMessages, [system, ...initial]);
  assert.deepEqual(detail.entries.map(entry => entry.input.content), ["input-one", "input-one", "input-two", "summary-input"]);
  assert.ok(detail.entries.every(entry => !Object.hasOwn(entry, "request") && !Object.hasOwn(entry, "imagePreviews")));
  assert.deepEqual(repository.get("r1").request.messages, firstMessages);
  append("r7", { id: "context-one", kind: "turn", turn: 3, turnId: "turn-four" }, firstMessages);
  const later = repository.listGroups({ before: first.nextCursor, limit: 2 }).entries[0];
  assert.equal(later.sequence, group.sequence); // Stable group cursor even as new requests arrive.
  assert.equal(later.requestCount, 5);
  assert.equal(later.usage.inputTokens, null); // Pending usage must not understate totals.
  assert.throws(() => repository.listGroups({ before: "invalid" }), /游标/);
  assert.throws(() => repository.getGroup("invalid"), /无效/);
  assert.throws(() => repository.getGroup("request:context-one"), /不存在/);
  assert.throws(() => repository.getGroup("conversation:missing"), /不存在/);
});

test("raw-log v1 upgrades preserve legacy requests as standalone groups without guessing contexts", t => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  db.exec(`CREATE TABLE test_migrations(namespace TEXT PRIMARY KEY, version INTEGER NOT NULL);
    INSERT INTO test_migrations VALUES ('raw-log',1);
    CREATE TABLE ai_requests(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL,created_at INTEGER NOT NULL,label TEXT NOT NULL,model TEXT NOT NULL,
      request_json TEXT NOT NULL,finished_at INTEGER,status INTEGER,response_json TEXT,error TEXT NOT NULL DEFAULT '');`);
  const request = { model: "old", messages: [{ role: "user", content: "legacy" }] };
  for (let i = 1; i <= 2; i++) db.prepare(`INSERT INTO ai_requests(id,session_id,created_at,label,model,request_json,finished_at)
    VALUES (?,?,?,?,?,?,?)`).run(`old-${i}`, "old-process", i, "ai:vision", "old", JSON.stringify(request), i);
  const repository = createRawLogRepository(storageFor(db));
  assert.deepEqual(repository.listGroups().entries.map(entry => entry.id), ["request:old-2", "request:old-1"]);
  assert.deepEqual(repository.get("old-1").request, request);
  assert.equal(db.prepare("SELECT version FROM test_migrations WHERE namespace='raw-log'").get().version, 2);
  assert.equal(createRawLogRepository(storageFor(db)).listGroups().entries.length, 2);
});

test("clearing removes raw records and image stores atomically, preserves memory and rejects stale writes", t => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  const storage = storageFor(db), repository = createRawLogRepository(storage);
  const request = { model: "test", messages: [{ role: "user", content: [{ type: "image_url", image_url: {
    url: `data:image/png;base64,${Buffer.from("image").toString("base64")}`,
  } }] }] };
  const entry = { id: "old", sessionId: "s", t: 1, label: "ai:vision", request, logGeneration: 0 };
  repository.append(entry);
  storage.blobs("screenshots").put(Buffer.from("screenshot"));
  storage.collection("core.ai-log").set("old", { response: "old" });
  storage.collection("memory-owned").set("fact", "keep");
  storage.blobs("other-plugin").put(Buffer.from("keep"));
  const history = storage.repository("dialogue-history");
  // Domain tables and unrelated plugin collections are outside the cleanup scope.
  const result = repository.clear();
  assert.deepEqual(result, { requests: 1, screenshots: 1, requestImages: 1, diagnostics: 1, generation: 1 });
  assert.equal(repository.list().entries.length, 0);
  assert.equal(repository.listGroups().entries.length, 0);
  assert.equal(storage.blobs("screenshots").list().entries.length, 0);
  assert.equal(storage.blobs("raw-log-images").list().entries.length, 0);
  assert.equal(storage.collection("raw-log.image-index").list().length, 0);
  assert.equal(storage.collection("core.ai-log").list().length, 0);
  assert.equal(storage.collection("memory-owned").get("fact"), "keep");
  assert.equal(storage.blobs("other-plugin").list().entries.length, 1);
  assert.ok(history.list());
  repository.finish({ id: "old", finishedAt: 100, response: "late" });
  repository.append({ ...entry, id: "stale-retry" });
  assert.equal(repository.list().entries.length, 0);
  assert.equal(storage.blobs("raw-log-images").list().entries.length, 0);
  repository.append({ ...entry, id: "new", logGeneration: 1 });
  assert.equal(repository.list().entries.length, 1);
  assert.equal(storage.blobs("raw-log-images").list().entries.length, 1);
  assert.equal(repository.clear().generation, 2);
  assert.equal(repository.clear().requests, 0);
  assert.equal(getLogGeneration(storageFor(db)), 3);
});

test("failed cleanup rolls back requests, binary images, hash indexes and the deletion generation", t => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  const storage = storageFor(db), repository = createRawLogRepository(storage);
  repository.append({ id: "keep", sessionId: "s", t: 1, label: "ai:text", request: { model: "test", messages: [] } });
  const shot = storage.blobs("screenshots").put(Buffer.from("keep"));
  storage.collection("core.ai-log").set("keep", "diagnostic");
  db.exec("CREATE TRIGGER fail_clear BEFORE DELETE ON storage_blobs BEGIN SELECT RAISE(ABORT, 'delete failed'); END");
  assert.throws(() => repository.clear(), /delete failed/);
  assert.equal(repository.list().entries.length, 1);
  assert.ok(storage.blobs("screenshots").get(shot.id));
  assert.equal(storage.collection("core.ai-log").get("keep"), "diagnostic");
  assert.equal(getLogGeneration(storage), 0);
});

test("requests started before cleanup can finish and retry without restoring cleared logs or encoded screenshots", async t => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  const storage = storageFor(db), repository = createRawLogRepository(storage), starts = [];
  const shot = storage.blobs("screenshots").put(Buffer.from("original"), { mimeType: "image/jpeg" });
  let resolveFirst, attempts = 0;
  const service = chat({ storage, writeLog: undefined, encodeImage: () => Buffer.from("encoded").toString("base64"),
    retryWait: async () => {}, onRequest: entry => { starts.push(entry); repository.append(entry); },
    onResult: entry => repository.finish(entry),
    fetchImpl: async (_url, init) => {
      assert.equal(JSON.parse(init.body).logGeneration, undefined);
      if (++attempts === 1) return new Promise(resolve => { resolveFirst = resolve; });
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: {
        content: JSON.stringify(petPayload({ response: "reply", screenSummary: "screen", workSummary: "work" })),
      } }] }) };
    },
  });
  t.after(() => service.dispose());
  const decision = service.decideFromObservations([{ id: "image", source: "screen", role: "context",
    content: [{ type: "image", uri: `storage://screenshots/${shot.id}` }] }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(resolveFirst);
  repository.clear();
  resolveFirst({ ok: false, status: 503, text: async () => '{"error":{"message":"retry"}}' });
  await decision;
  assert.deepEqual(starts.map(entry => entry.logGeneration), [0, 0]);
  assert.equal(repository.list().entries.length, 0);
  assert.equal(storage.blobs("raw-log-images").list().entries.length, 0);
  assert.equal(storage.blobs("screenshots").list().entries.length, 0);
  assert.equal(storage.collection("core.ai-log").list().length, 0);
  await service.generateText([{ role: "user", content: "new request" }]);
  assert.equal(starts.at(-1).logGeneration, 1);
  assert.equal(repository.list().entries.length, 1);
  assert.equal(storage.collection("core.ai-log").list().length, 1);
});

test("cleanup deletes only legacy AI logs and generated screenshots, drops deleted observations and keeps new data", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pet-log-clear-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "logs/screenshots"), { recursive: true });
  const removed = ["logs/openai.jsonl", "logs/openai.jsonl.1", "logs/screenshots/2026-11-02_01-02-03.jpg", "logs/screenshots/2026-11-02_01-02-03_42.jpg"];
  const kept = ["logs/memory.jsonl", "logs/dialogue-history.jsonl", "logs/screenshots/.gitkeep", "logs/screenshots/notes.txt"];
  for (const name of [...removed, ...kept]) fs.writeFileSync(path.join(root, name), "test");
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  const storage = storageFor(db), repository = createRawLogRepository(storage);
  const bus = new MessageBus({ logger: quiet }), perception = createPerceptionService(bus);
  const shot = storage.blobs("screenshots").put(Buffer.from("old"));
  await perception.submit({ source: "screen", content: [{ type: "image", uri: `storage://screenshots/${shot.id}` }] });
  await perception.submit({ source: "manual-input", role: "user", content: [{ type: "text", text: "keep text" }] });
  bus.subscribe(EVENTS.RAW_LOG_CLEARED, async () => {
    const fresh = storage.blobs("screenshots").put(Buffer.from("new"));
    await perception.submit({ source: "screen", content: [{ type: "image", uri: `storage://screenshots/${fresh.id}` }] });
  });
  const result = await clearRawLog({ paths: { projectRoot: root }, bus, perception }, repository, storage);
  assert.equal(result.legacyLogs, 2);
  assert.equal(result.legacyScreenshots, 2);
  assert.deepEqual(result.warnings, []);
  for (const name of removed) assert.equal(fs.existsSync(path.join(root, name)), false);
  for (const name of kept) assert.equal(fs.readFileSync(path.join(root, name), "utf8"), "test");
  assert.equal(fs.readdirSync(path.join(root, "logs")).some(name => name.startsWith(".raw-log-clear-")), false);
  assert.equal(perception.pendingCount(), 2);
  assert.equal(storage.blobs("screenshots").list().entries.length, 1);
});

test("legacy files are restored when Storage deletion fails", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pet-log-rollback-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "logs"));
  const file = path.join(root, "logs/openai.jsonl"); fs.writeFileSync(file, "keep");
  await assert.rejects(clearRawLog({ paths: { projectRoot: root } }, { clear() { throw new Error("storage failed"); } }), /storage failed/);
  assert.equal(fs.readFileSync(file, "utf8"), "keep");
  assert.deepEqual(fs.readdirSync(path.join(root, "logs")), ["openai.jsonl"]);
});

test("compaction failure reports committed cleanup and still removes stale observations", async t => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  const storage = storageFor(db), repository = createRawLogRepository(storage);
  storage.blobs("screenshots").put(Buffer.from("old"));
  const calls = [];
  const result = await clearRawLog({ bus: new MessageBus(), perception: { discard() { calls.push("discard"); } } }, repository,
    { ...storage, compact() { calls.push("compact"); throw new Error("disk full"); } });
  assert.deepEqual(calls, ["discard", "compact"]);
  assert.equal(result.screenshots, 1);
  assert.equal(result.compacted, false);
  assert.match(result.warnings[0], /日志已清理.*压缩失败.*disk full/);
  assert.equal(storage.blobs("screenshots").list().entries.length, 0);
});

test("legacy file deletion failure returns a warning and restores remaining files for a future cleanup", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pet-log-file-failure-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "logs"));
  const file = path.join(root, "logs/openai.jsonl"); fs.writeFileSync(file, "keep until deleted");
  const remove = fs.rmSync;
  const mock = t.mock.method(fs, "rmSync", (target, ...args) => {
    if (String(target).includes(".raw-log-clear-")) throw new Error("permission denied");
    return remove(target, ...args);
  });
  let cleared = false;
  const result = await clearRawLog({ paths: { projectRoot: root }, bus: new MessageBus() }, {
    clear() { cleared = true; return { requests: 1, screenshots: 0, generation: 1 }; },
  });
  mock.mock.restore();
  assert.equal(cleared, true);
  assert.equal(result.legacyLogs, 0);
  assert.match(result.warnings[0], /未能删除.*permission denied/);
  assert.equal(fs.readFileSync(file, "utf8"), "keep until deleted");
  assert.deepEqual(fs.readdirSync(path.join(root, "logs")), ["openai.jsonl"]);
});

test("per-request token usage is read from existing raw responses without sending their full content in pagination", (t) => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  const repository = createRawLogRepository(storageFor(db));
  const responses = [
    { usage: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200,
      prompt_tokens_details: { cached_tokens: 400, cache_write_tokens: 300 }, completion_tokens_details: { reasoning_tokens: 80 } } },
    { usage: { prompt_tokens: 120, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 0 } } },
    { usage: { prompt_tokens: 100, completion_tokens: 50 } },
    JSON.stringify({ usage: { prompt_tokens: 500, completion_tokens: 75, prompt_cache_hit_tokens: 128, prompt_cache_miss_tokens: 372 } }),
    { usage: "malformed usage" },
  ];
  for (const [i, response] of responses.entries()) {
    repository.append({ id: `usage${i}`, sessionId: "session", t: i, label: "ai:text", request: { model: "test", messages: [] } });
    repository.finish({ id: `usage${i}`, finishedAt: 100, status: 200, response });
  }
  const listed = new Map(repository.list().entries.map((entry) => [entry.id, entry]));
  const expected = { inputTokens: 1000, outputTokens: 200, totalTokens: 1200, cachedTokens: 400,
    uncachedTokens: 600, cacheWriteTokens: 300, reasoningTokens: 80 };
  assert.deepEqual(listed.get("usage0").usage, expected);
  assert.deepEqual(repository.get("usage0").usage, expected);
  assert.deepEqual(repository.get("usage0").response, responses[0]);
  assert.equal(Object.hasOwn(listed.get("usage0"), "response_json"), false);
  assert.equal(Object.hasOwn(listed.get("usage0"), "usageJson"), false);
  assert.equal(listed.get("usage1").usage.cachedTokens, 0);
  assert.equal(listed.get("usage1").usage.uncachedTokens, 120);
  assert.equal(listed.get("usage2").usage.cachedTokens, null);
  assert.equal(listed.get("usage2").usage.uncachedTokens, null);
  assert.equal(listed.get("usage3").usage.uncachedTokens, 372);
  assert.deepEqual(listed.get("usage3").usage, repository.get("usage3").usage);
  assert.equal(listed.get("usage4").usage, null);
});

test("usage supports Responses counters and keeps absent or inconsistent cache counters unknown", () => {
  assert.deepEqual(normalizeUsage({ input_tokens: 100, output_tokens: 20,
    input_tokens_details: { cached_tokens: 80 }, output_tokens_details: { reasoning_tokens: 10 } }),
  { inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedTokens: 80, uncachedTokens: 20, cacheWriteTokens: null, reasoningTokens: 10 });
  assert.equal(normalizeUsage({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 120 } }).uncachedTokens, null);
  assert.equal(normalizeUsage({ prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cache_write_tokens: 97 } }).cachedTokens, null);
  assert.equal(normalizeUsage({}), null);
  assert.equal(normalizeUsage({ prompt_tokens: -1, completion_tokens: Infinity }), null);
});

test("log plugin validates window identity and records late cancellation while stopped", async (t) => {
  const db = new DatabaseSync(":memory:");
  const bus = new MessageBus({ logger: quiet });
  const handlers = new Map();
  const windows = [];
  let menu;
  const plugin = activate({ bus, logger: quiet,
    services: { get: () => storageFor(db) },
    menu: { register: (provide) => { menu = provide; return () => { menu = null; }; } },
    ipc: { handle: (channel, handler) => { handlers.set(channel, handler); return () => handlers.delete(channel); } },
    windows: { create: (options) => {
      const win = new EventEmitter();
      Object.assign(win, { options, webContents: {}, destroyed: false, shows: 0,
        isDestroyed() { return this.destroyed; }, isMinimized: () => false,
        show() { this.shows++; }, focus() {}, loadFile: async () => {},
        destroy() { this.destroyed = true; this.emit("closed"); } });
      windows.push(win); return win;
    } },
  });
  t.after(() => { plugin.dispose(); db.close(); });
  await bus.notify(EVENTS.AI_REQUEST_STARTED, { id: "pending", sessionId: "session", t: 1,
    label: "ai:text", request: { model: "test", messages: [{ role: "user", content: "hello" }] } });
  menu()[0].click(); menu()[0].click();
  assert.equal(windows.length, 1);
  const win = windows[0];
  assert.equal(win.options.webPreferences.sandbox, true);
  assert.throws(() => handlers.get("list")({ sender: {} }), /来源无效/);
  assert.throws(() => handlers.get("listGroups")({ sender: {} }), /来源无效/);
  assert.throws(() => handlers.get("getGroup")({ sender: {} }, "conversation:any"), /来源无效/);
  assert.throws(() => handlers.get("clear")({ sender: {} }), /来源无效/);
  assert.throws(() => handlers.get("listScreenshots")({ sender: {} }), /来源无效/);
  assert.throws(() => handlers.get("getScreenshot")({ sender: {} }, "any"), /来源无效/);
  assert.equal(handlers.get("list")({ sender: win.webContents }).entries.length, 1);
  assert.equal(handlers.get("listScreenshots")({ sender: win.webContents }).entries.length, 0);
  plugin.stop(); win.emit("ready-to-show");
  assert.equal(win.shows, 1);
  assert.throws(() => handlers.get("get")({ sender: win.webContents }, "pending"), /已关闭/);
  assert.throws(() => handlers.get("listScreenshots")({ sender: win.webContents }), /已关闭/);
  await bus.notify(EVENTS.AI_REQUEST_FINISHED, { id: "pending", finishedAt: 2, error: "cancelled" });
  assert.equal(db.prepare("SELECT error FROM ai_requests WHERE id = 'pending'").get().error, "cancelled");
  plugin.start(); menu()[0].click();
  plugin.dispose();
  assert.equal(windows[1].destroyed, true);
  assert.equal(handlers.size, 0);
});
