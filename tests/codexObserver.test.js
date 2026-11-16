const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { workStorage } = require("./helpers/workStorage");
const { createCodexObserverPlugin, activate } = require("../electron/plugins/codexObserver");
const { userText, MAX_LINE_BYTES } = require("../electron/plugins/codexObserver/reader");
const { normalizeConfig } = require("../electron/config");
const { createPerceptionService } = require("../electron/architecture/perceptionService");
const { MessageBus } = require("../electron/architecture/messageBus");
const { createCodexHistory, MAX_RECORDS } = require("../electron/plugins/codexObserver/history");
const { createRawLogRepository } = require("../electron/plugins/rawLog/repository");
const { getLogGeneration } = require("../electron/storage/logLifecycle");

const stamp = "2026-11-16T01:00:00.000Z";
const line = record => `${JSON.stringify(record)}\n`;
const meta = (extra = {}) => ({ type: "session_meta", payload: { id: "session-1", cwd: "/work/pet", source: "vscode", ...extra } });
const prompt = (text, id = "message-1", extra = {}) => ({ type: "response_item", timestamp: stamp,
  payload: { type: "message", id, role: "user", content: [{ type: "input_text", text }], ...extra } });

async function harness(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pet-codex-"));
  const directory = path.join(root, "sessions");
  await fs.mkdir(directory);
  const { storage, db } = workStorage(), timers = new Set(), warnings = [];
  const perception = createPerceptionService(new MessageBus());
  const context = { config: { get: () => ({ plugins: [{ name: "codex-observer", sessionsDir: directory, ...options }] }) },
    storage, perception, logger: { warn: value => warnings.push(value) },
    decisions: { request: () => assert.fail("observer must not request a decision") } };
  const dependencies = {
    setTimeout(callback) { const timer = { callback }; timers.add(timer); return timer; },
    clearTimeout: timer => timers.delete(timer),
  };
  let plugin = createCodexObserverPlugin(context, dependencies);
  async function idle() {
    for (let i = 0; i < 1000; i++) {
      if (timers.size) return;
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    assert.fail("observer did not finish polling");
  }
  t.after(async () => { await plugin.dispose(); db.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { directory, indexPath: path.join(root, "session_index.jsonl"), context, perception, warnings, timers, storage,
    get plugin() { return plugin; },
    async file(name, records) {
      const target = path.join(directory, "2026/11/16", name);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, records.map(line).join(""));
      return target;
    },
    async start() { plugin.start(); await idle(); },
    async poll() { const timer = [...timers][0]; assert.ok(timer); timers.delete(timer); timer.callback(); await idle(); },
    async restart() { await plugin.stop(); plugin = createCodexObserverPlugin(context, dependencies); plugin.start(); await idle(); },
    batch: () => perception.takeBatch(),
  };
}

test("existing history is baselined, new prompts enter as context without requesting decisions", async t => {
  const h = await harness(t);
  const file = await h.file("old.jsonl", [meta(), prompt("old")]);
  await h.start();
  assert.equal(h.perception.pendingCount(), 0);
  await fs.appendFile(file, line(prompt("新的提示词", "new")));
  await h.poll();
  const [observation] = await h.batch();
  assert.equal(observation.source, "codex");
  assert.equal(observation.role, "context");
  assert.match(observation.content[0].text, /新的提示词/);
  assert.equal(observation.metadata.sessionId, "session-1");
  assert.equal(observation.metadata.projectPath, "/work/pet");
  assert.equal(observation.capturedAt, stamp);
  assert.equal(observation.expiresAt, undefined);
  await h.poll();
  assert.equal(h.perception.pendingCount(), 0);
});

test("new sessions capture their first prompt and ignore context, assistant and duplicate event records", async t => {
  const h = await harness(t); await h.start();
  await h.file("new.jsonl", [meta(), prompt("<environment_context>context</environment_context>", "env"),
    prompt("internal", "internal", { internal_chat_message_metadata_passthrough: { content_item_kinds: ["environments.other"] } }),
    prompt("visible", "actual", { internal_chat_message_metadata_passthrough: { content_item_kinds: ["user.text"] } }),
    prompt("assistant", "assistant", { role: "assistant" }),
    { type: "event_msg", payload: { type: "user_message", message: "visible" } },
    prompt("visible", "actual")]);
  await h.poll();
  const batch = await h.batch();
  assert.equal(batch.length, 1);
  assert.match(batch[0].content[0].text, /visible/);
});

test("partial JSON and split UTF-8 are reread only when the line is complete", async t => {
  const h = await harness(t); await h.start();
  const file = await h.file("partial.jsonl", [meta()]);
  const bytes = Buffer.from(line(prompt("中文内容")));
  const split = bytes.indexOf(Buffer.from("中")) + 1;
  await fs.appendFile(file, bytes.subarray(0, split)); await h.poll();
  assert.equal(h.perception.pendingCount(), 0);
  await fs.appendFile(file, bytes.subarray(split)); await h.poll();
  const batch = await h.batch();
  assert.equal(batch.length, 1);
  assert.match(batch[0].content[0].text, /中文内容/);
  assert.doesNotMatch(batch[0].content[0].text, /�/);
});

test("an incomplete line present at first startup is skipped through its newline", async t => {
  const h = await harness(t);
  const file = await h.file("partial-baseline.jsonl", [meta()]);
  const old = line(prompt("old"));
  await fs.appendFile(file, old.slice(0, 30));
  await h.start();
  await fs.appendFile(file, old.slice(30) + line(prompt("new", "new"))); await h.poll();
  const batch = await h.batch();
  assert.equal(batch.length, 1); assert.match(batch[0].content[0].text, /new/);
});

test("saved offsets survive restart and failed queue submissions are retried", async t => {
  const h = await harness(t); await h.start();
  const file = await h.file("retry.jsonl", [meta(), prompt("one", "one")]);
  const submit = h.context.perception.submit;
  h.context.perception.submit = async () => { throw new Error("queue unavailable"); };
  await h.poll(); assert.equal(h.perception.pendingCount(), 0);
  h.context.perception.submit = submit;
  await h.poll(); assert.equal((await h.batch()).length, 1);
  await fs.appendFile(file, line(prompt("two", "two")));
  await h.restart();
  const batch = await h.batch();
  assert.equal(batch.length, 1); assert.match(batch[0].content[0].text, /two/);
  await h.restart(); assert.equal(h.perception.pendingCount(), 0);
});

test("project path boundaries and subagent sessions are filtered", async t => {
  const h = await harness(t, { projects: ["/work/pet"] }); await h.start();
  await h.file("yes.jsonl", [meta({ cwd: "/work/pet/src" }), prompt("yes")]);
  await h.file("no.jsonl", [meta({ cwd: "/work/pet-other" }), prompt("no")]);
  await h.file("agent.jsonl", [meta({ source: { subagent: { parent_thread_id: "parent" } } }), prompt("agent")]);
  await h.poll();
  const batch = await h.batch();
  assert.equal(batch.length, 1); assert.match(batch[0].content[0].text, /yes/);
});

test("truncation and replacement reset the cursor; malformed and oversized lines do not block following input", async t => {
  const h = await harness(t); await h.start();
  const file = await h.file("reset.jsonl", [meta(), prompt("x".repeat(500), "long")]);
  await h.poll(); await h.batch();
  await fs.writeFile(file, line(meta()) + line(prompt("short", "short"))); await h.poll();
  assert.equal((await h.batch()).length, 1);
  await fs.appendFile(file, "bad json\n" + "x".repeat(MAX_LINE_BYTES + 20) + "\n" + line(prompt("after", "after")));
  for (let i = 0; i < 4; i++) await h.poll();
  const batch = await h.batch();
  assert.equal(batch.length, 1); assert.match(batch[0].content[0].text, /after/);
  await fs.rename(file, `${file}.bak`);
  await fs.writeFile(file, line(meta()) + line(prompt("replacement", "replacement"))); await h.poll();
  assert.equal((await h.batch()).length, 1);
});

test("stop waits for accepted ingress, restart avoids duplicates, unload discards pending observations", async t => {
  const h = await harness(t); await h.start();
  await h.file("stop.jsonl", [meta(), prompt("one"), prompt("two", "two")]);
  let entered, finish;
  const entering = new Promise(resolve => { entered = resolve; });
  const waiting = new Promise(resolve => { finish = resolve; });
  const submit = h.perception.submit;
  h.perception.submit = async input => { entered(); await waiting; return submit(input); };
  const timer = [...h.timers][0]; h.timers.delete(timer); timer.callback();
  await entering;
  const stopping = h.plugin.stop(); finish(); await stopping;
  assert.equal(h.perception.pendingCount(), 1);
  assert.equal(h.timers.size, 0);
  h.perception.submit = submit;
  await h.start();
  const batch = await h.batch();
  assert.equal(batch.length, 2);
  assert.notEqual(batch[0].id, batch[1].id);
  await h.file("unload.jsonl", [meta(), prompt("pending")]); await h.poll();
  await h.plugin.dispose(); assert.equal(h.perception.pendingCount(), 0);
});

test("missing directory can appear later and receives first prompt; TTL is applied at ingress", async t => {
  const h = await harness(t, { observationTtlMs: 60000 });
  await fs.rm(h.directory, { recursive: true }); await h.start();
  await h.file("later.jsonl", [meta(), prompt("later")]); await h.poll();
  const [observation] = await h.batch();
  assert.ok(observation.expiresAt > Date.now());
});

test("real user text markup is retained when metadata explicitly marks user input", () => {
  assert.equal(userText(prompt("<environment_context>user example", "one", {
    internal_chat_message_metadata_passthrough: { content_item_kinds: ["user.text"] },
  })), "<environment_context>user example");
});

test("configuration is registered, optional, validated and expands paths", () => {
  const definition = require("../electron/plugins/codexObserver/definition");
  assert.equal(definition.shouldLoad(normalizeConfig({})), false);
  const config = normalizeConfig({ plugins: [{ name: "codex-observer", sessionsDir: "~/.codex/sessions" }] });
  assert.equal(definition.shouldLoad(config), true);
  const options = config.plugins.find(plugin => plugin.name === "codex-observer");
  assert.equal(options.sessionsDir, path.join(os.homedir(), ".codex/sessions"));
  assert.equal(options.interval_ms, 2000);
  for (const invalid of [{ sessionsDir: "" }, { projects: "x" }, { projects: [null] }, { interval_ms: 0 },
    { observationTtlMs: -1 }, { unknown: true }]) {
    assert.throws(() => normalizeConfig({ plugins: [{ name: "codex-observer", ...invalid }] }));
  }
});

test("activation registers the background-observation instruction and unload removes it", async t => {
  const h = await harness(t);
  let registered = "", removed = false;
  h.context.systemPrompt = { register(value) { registered = value.text; return () => { removed = true; }; } };
  const plugin = activate(h.context);
  assert.match(registered, /不是对桌宠的直接指令/);
  await plugin.dispose(); assert.equal(removed, true);
});

test("raw delivery history retains full prompt and observation, updates failed retries and survives unload", async t => {
  const h = await harness(t); await h.start();
  await h.file("history.jsonl", [meta(), prompt("日志提示词")]);
  const history = createCodexHistory(h.storage), submit = h.perception.submit;
  h.perception.submit = async () => { throw new Error("队列暂时不可用"); };
  await h.poll();
  const failed = history.list().entries[0];
  assert.equal(failed.state, "failed");
  assert.equal(failed.error, "队列暂时不可用");
  assert.equal(failed.prompt, undefined);
  assert.equal(failed.observation, undefined);
  assert.equal(failed.preview, "日志提示词");
  h.perception.submit = submit; await h.poll();
  const entries = history.list().entries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].state, "queued");
  assert.equal(entries[0].error, undefined);
  const record = history.get(failed.id), [observation] = await h.batch();
  assert.equal(record.prompt, "日志提示词");
  assert.equal(record.sessionId, "session-1");
  assert.equal(record.projectPath, "/work/pet");
  assert.deepEqual(record.observation.content, observation.content);
  assert.equal(record.observation.id, observation.id);
  await h.plugin.dispose();
  assert.equal(createCodexHistory(h.storage).get(failed.id).state, "queued");
});

test("clearing history preserves checkpoints and queued text; a late submission cannot restore cleared history", async t => {
  const h = await harness(t); await h.start();
  const file = await h.file("clear.jsonl", [meta(), prompt("before")]); await h.poll();
  const repository = createRawLogRepository(h.storage), history = createCodexHistory(h.storage);
  const cursors = h.storage.collection("codex-observer.cursors").list();
  assert.equal(repository.clear().codex, 1);
  assert.deepEqual(h.storage.collection("codex-observer.cursors").list(), cursors);
  assert.equal(h.perception.pendingCount(), 1);
  await fs.appendFile(file, line(prompt("late", "late")));
  const submit = h.perception.submit;
  h.perception.submit = async input => { repository.clear(); return submit(input); };
  await h.poll();
  assert.equal(history.list().entries.length, 0);
  assert.equal(h.perception.pendingCount(), 2);
  h.perception.submit = submit;
  await fs.appendFile(file, line(prompt("after", "after"))); await h.poll();
  assert.equal(history.list().entries.length, 1);
  assert.equal(history.get(history.list().entries[0].id).prompt, "after");
});

test("history retention, stable pagination, validation and generation checks", async t => {
  const h = await harness(t);
  const history = createCodexHistory(h.storage, { now: () => 100 });
  for (let i = 0; i < MAX_RECORDS + 5; i++) {
    history.record({ id: `log-${String(i).padStart(4, "0")}`, state: "queued", prompt: "x".repeat(300), observation: {} }, 0);
  }
  const first = history.list({ limit: 100 }), second = history.list({ before: first.nextCursor, limit: 100 });
  assert.equal(first.entries.length + second.entries.length, MAX_RECORDS);
  assert.equal(new Set([...first.entries, ...second.entries].map(entry => entry.id)).size, MAX_RECORDS);
  assert.equal(first.entries[0].preview.length, 160);
  assert.equal(second.nextCursor, null);
  assert.throws(() => history.get("log-0000"), /不存在/);
  for (const invalid of [{ limit: 0 }, { limit: 101 }, { before: {} }]) assert.throws(() => history.list(invalid));
  assert.throws(() => history.get(null));
  createRawLogRepository(h.storage).clear();
  history.record({ id: "old", state: "queued", prompt: "old" }, 0);
  assert.equal(history.list().entries.length, 0);
  history.record({ id: "new", state: "queued", prompt: "new" }, getLogGeneration(h.storage));
  assert.equal(history.list().entries.length, 1);
});

test("history write failure does not block ingress or checkpoint advancement", async t => {
  const h = await harness(t); await h.start();
  await h.file("log-failure.jsonl", [meta(), prompt("still queued")]);
  const collection = h.storage.collection;
  h.storage.collection = name => name === "codex-observer.history" ? {
    set() { throw new Error("log write failure"); },
  } : collection(name);
  await h.poll();
  assert.equal(h.perception.pendingCount(), 1);
  assert.ok(h.warnings.some(message => message.includes("日志保存失败")));
  h.storage.collection = collection;
  await h.poll(); assert.equal(h.perception.pendingCount(), 1);
});

test("project name and matching session title reach observation text, metadata and raw history", async t => {
  const h = await harness(t); await h.start();
  await fs.writeFile(h.indexPath, line({ id: "other-session", thread_name: "其他标题" }) +
    line({ id: "session-1", thread_name: "新增 Codex 观察插件" }));
  await h.file("named.jsonl", [meta({ cwd: "/work/mylive2dpet/" }), prompt("提示词原文")]);
  await h.poll();
  const [observation] = await h.batch();
  assert.equal(observation.metadata.projectName, "mylive2dpet");
  assert.equal(observation.metadata.sessionTitle, "新增 Codex 观察插件");
  assert.match(observation.content[0].text, /项目：mylive2dpet\n会话：新增 Codex 观察插件/);
  assert.equal(observation.role, "context");
  const history = createCodexHistory(h.storage);
  const entry = history.list().entries[0], record = history.get(entry.id);
  assert.equal(entry.projectName, "mylive2dpet");
  assert.equal(entry.sessionTitle, "新增 Codex 观察插件");
  assert.equal(record.projectName, observation.metadata.projectName);
  assert.equal(record.sessionTitle, observation.metadata.sessionTitle);
  assert.equal(record.prompt, "提示词原文");
});

test("session title changes and index replacements apply to subsequent prompts without changing old logs", async t => {
  const h = await harness(t); await h.start();
  await fs.writeFile(h.indexPath, line({ id: "session-1", thread_name: "原始标题" }));
  const file = await h.file("rename.jsonl", [meta(), prompt("first", "first")]);
  await h.poll(); assert.equal((await h.batch())[0].metadata.sessionTitle, "原始标题");
  await fs.appendFile(h.indexPath, line({ id: "session-1", thread_name: "修改后标题" }));
  await fs.appendFile(file, line(prompt("second", "second"))); await h.poll();
  assert.equal((await h.batch())[0].metadata.sessionTitle, "修改后标题");
  await fs.rename(h.indexPath, `${h.indexPath}.bak`);
  await fs.writeFile(h.indexPath, line({ id: "session-1", thread_name: "替换后标题" }));
  await fs.appendFile(file, line(prompt("third", "third"))); await h.poll();
  assert.equal((await h.batch())[0].metadata.sessionTitle, "替换后标题");
  assert.deepEqual(new Set(createCodexHistory(h.storage).list().entries.map(entry => entry.sessionTitle)),
    new Set(["原始标题", "修改后标题", "替换后标题"]));
});

test("missing title, late index creation, partial records and invalid index rows do not block ingress", async t => {
  const h = await harness(t); await h.start();
  const file = await h.file("fallback.jsonl", [meta({ cwd: "" }), prompt("first", "first")]);
  await h.poll();
  const [first] = await h.batch();
  assert.equal(first.metadata.projectName, "");
  assert.equal(first.metadata.sessionTitle, "");
  assert.match(first.content[0].text, /项目：未知项目\n会话：暂无会话标题/);
  await fs.writeFile(h.indexPath, 'bad json\nnull\n' + line({ id: "session-1", thread_name: 123 }) +
    line({ id: "other", thread_name: "不匹配标题" }) + '{"id":"session-1","thread_name":"完整标题"');
  await fs.appendFile(file, line(prompt("second", "second"))); await h.poll();
  assert.equal((await h.batch())[0].metadata.sessionTitle, "");
  await fs.appendFile(h.indexPath, "}\n");
  await fs.appendFile(file, line(prompt("third", "third"))); await h.poll();
  assert.equal((await h.batch())[0].metadata.sessionTitle, "完整标题");
  await fs.rm(h.indexPath);
  await fs.appendFile(file, line(prompt("fourth", "fourth"))); await h.poll();
  assert.equal((await h.batch())[0].metadata.sessionTitle, "");
});

test("unchanged session index is cached and an unreadable index degrades to unnamed ingress", async t => {
  const { createSessionTitleReader } = require("../electron/plugins/codexObserver/sessionTitles");
  const h = await harness(t);
  await fs.writeFile(h.indexPath, line({ id: "session-1", thread_name: "标题" }));
  let reads = 0;
  const readTitles = createSessionTitleReader({ open: async target => {
    const handle = await fs.open(target, "r");
    return { stat: () => handle.stat(), close: () => handle.close(),
      readFile: async encoding => { reads++; return handle.readFile(encoding); } };
  } }, h.directory);
  assert.equal((await readTitles()).get("session-1"), "标题");
  assert.equal((await readTitles()).get("session-1"), "标题");
  assert.equal(reads, 1);
  const inaccessible = createSessionTitleReader({ open: async () => { throw new Error("permission denied"); } },
    h.directory, { warn: value => h.warnings.push(value) });
  assert.equal((await inaccessible()).size, 0);
  assert.ok(h.warnings.some(value => value.includes("会话标题读取失败")));
});
