const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { normalizeConfig, createConfigStore } = require("../electron/config");
const { getPlugin } = require("../electron/plugins/registry");
const manifest = require("../electron/plugins/manifest");

test("current example is valid, immutable and does not change when normalized again", () => {
  const input = JSON.parse(fs.readFileSync(path.join(__dirname, "../config.example.json"), "utf8"));
  const config = normalizeConfig(input);
  assert.deepEqual(normalizeConfig(config), config);
  assert.ok(Object.isFrozen(getPlugin(config, "memory").longTerm));
  assert.equal(config.conversation.ai.timeoutMs, 120000);
  assert.equal(config.conversation.ai.retryBudgetMs, 360000);
  assert.equal(getPlugin(config, "screen-perception").enabled, true);
  assert.equal(input.plugins.find(({ name }) => name === "screen-perception").intervalMs, undefined);
});

test("removed memory configuration fields are rejected", () => {
  for (const key of ["summary", "textService"]) {
    assert.throws(() => normalizeConfig({ plugins: [{ name: "memory", [key]: {} }] }), /不支持的记忆配置字段/);
  }
});

test("configuration rejects root feature options and flat memory parameters", () => {
  for (const key of ["ai", "character", "chat", "perception", "tts", "memory"]) {
    assert.throws(() => normalizeConfig({ [key]: {} }), /不支持的配置根字段/);
  }
  for (const key of ["path", "maxInject", "extractEveryNTurns", "maxTokens", "maxEntries"]) {
    assert.throws(() => normalizeConfig({ plugins: [{ name: "memory", [key]: 1 }] }), /不支持的记忆配置字段/);
  }
  for (const key of ["path", "legacyPath"]) {
    assert.throws(() => normalizeConfig({ plugins: [{ name: "memory", longTerm: { [key]: "old.jsonl" } }] }), /不支持的长期记忆配置字段/);
  }
  assert.throws(() => normalizeConfig({ plugins: [{ name: "dialogue-history", legacyPath: "old.jsonl" }] }), /不支持的历史对话配置字段/);
});

test("optional plugins are explicit and memory enabled controls the entire plugin", () => {
  const config = normalizeConfig({ plugins: [{ name: "memory", enabled: false, longTerm: { enabled: true } }] });
  for (const name of ["tts", "memory", "audio-output-perception"]) {
    assert.equal(manifest.find((plugin) => plugin.name === name).shouldLoad(config), false);
  }
  assert.equal(getPlugin(config, "memory").enabled, false);
  assert.equal(getPlugin(normalizeConfig({}), "memory"), null);
});

test("invalid configuration preserves the last valid snapshot and recovers after correction", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pet-config-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "config.json");
  const store = createConfigStore(file, { logger: { warn() {} } });
  fs.writeFileSync(file, JSON.stringify({ decision: { interval_ms: 1234 } }));
  const original = store.load();
  fs.writeFileSync(file, JSON.stringify({ chat: { interval_ms: 4567 } }));
  assert.equal(store.load({ force: true }), original);
  assert.match(store.getStatus().error, /不支持的配置根字段/);
  fs.writeFileSync(file, JSON.stringify({ decision: { interval_ms: 4567 } }));
  assert.equal(store.load({ force: true }).decision.interval_ms, 4567);
  assert.equal(store.getStatus().error, null);
});

async function waitFor(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= deadline) assert.fail("Timed out waiting for config watch event");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("watch reloads edits and atomic replacements, retains valid config and recovers after deletion", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pet-config-watch-"));
  const file = path.join(dir, "config.json");
  const updates = [];
  const warnings = [];
  const store = createConfigStore(file, {
    changeDebounceMs: 20,
    logger: { info: (message) => updates.push(message), warn: (message) => warnings.push(message) },
  });
  t.after(() => {
    store.stopWatching();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const write = (target, interval) => fs.writeFileSync(target, JSON.stringify({ decision: { interval_ms: interval } }));
  write(file, 1234);
  const stop = store.startWatching();
  assert.equal(store.startWatching(), stop);

  fs.writeFileSync(path.join(dir, "unrelated.json"), "{}");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(updates.length, 0);

  write(file, 2345);
  await waitFor(() => updates.length === 1);
  assert.equal(store.load().decision.interval_ms, 2345);

  const replacement = path.join(dir, "config.tmp");
  write(replacement, 3456);
  fs.renameSync(replacement, file);
  await waitFor(() => updates.length === 2);
  const valid = store.load();
  assert.equal(valid.decision.interval_ms, 3456);

  for (const invalid of ["{", JSON.stringify({ chat: {} })]) {
    fs.writeFileSync(file, invalid);
    const previousWarnings = warnings.length;
    await waitFor(() => warnings.length > previousWarnings);
    assert.equal(store.load(), valid);
    assert.ok(store.getStatus().error);
  }
  fs.unlinkSync(file);
  await waitFor(() => store.getStatus().error === "配置文件无法读取");
  assert.equal(store.load(), valid);

  write(file, 4567);
  await waitFor(() => updates.length === 3);
  assert.equal(store.load().decision.interval_ms, 4567);
  assert.equal(store.getStatus().error, null);

  stop();
  store.stopWatching();
  write(file, 5678);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(updates.length, 3);
  store.startWatching();
  write(file, 6789);
  await waitFor(() => updates.length === 4);
  assert.equal(store.load().decision.interval_ms, 6789);
});

test("stopping the watch cancels a pending reload", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pet-config-watch-stop-"));
  const file = path.join(dir, "config.json");
  const updates = [];
  const store = createConfigStore(file, { changeDebounceMs: 100, logger: { info: (message) => updates.push(message) } });
  t.after(() => {
    store.stopWatching();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  fs.writeFileSync(file, "{}");
  store.startWatching();
  fs.writeFileSync(file, JSON.stringify({ decision: { interval_ms: 2345 } }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  store.stopWatching();
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(updates.length, 0);
});


test("plugin definitions reject malformed sections and preserve each plugin's loading semantics", () => {
  for (const plugin of [
    { name: "screen-perception", changeDetect: [] },
    { name: "screen-perception", changeDetect: { enabled: "yes" } },
    { name: "audio-output-perception", asr: [] },
    { name: "memory", practice: { enabled: "yes" } },
  ]) assert.throws(() => normalizeConfig({ plugins: [plugin] }));
  const config = normalizeConfig({ plugins: [
    { name: "screen-perception", enabled: false },
    { name: "audio-output-perception", enabled: false },
    { name: "tts", enabled: false },
  ] });
  const loads = (name) => manifest.find((definition) => definition.name === name).shouldLoad(config);
  assert.equal(loads("screen-perception"), true);
  assert.equal(loads("audio-output-perception"), true);
  assert.equal(loads("tts"), false);
});

test("runtime options reuse immutable snapshots and read changed raw configurations without stale defaults", () => {
  const { getOptions } = require("../electron/plugins/memory/options");
  const raw = { plugins: [{ name: "memory", shortTerm: { maxTurns: 3 } }] };
  const config = normalizeConfig(raw);
  const options = getOptions(config);
  assert.equal(options.shortTerm.maxTurns, 3);
  assert.equal(getOptions(config), options);
  assert.ok(Object.isFrozen(options.shortTerm));
  raw.plugins[0].shortTerm = { maxTurns: 7 };
  assert.equal(getOptions(raw).shortTerm.maxTurns, 7);
  const next = normalizeConfig(raw);
  assert.equal(getOptions(next).shortTerm.maxTurns, 7);
  assert.equal(options.shortTerm.maxTurns, 3);
});

test("only the core conversation schema is accepted", () => {
  const config = normalizeConfig({ conversation: { enabled: false,
    ai: { endpoint: "https://example/v1", apiKey: "test", model: "test" }, character: { name: "Setsuna" },
  }, plugins: [{ name: "memory" }] });
  assert.equal(config.conversation.enabled, false);
  assert.equal(config.conversation.ai.model, "test");
  assert.ok(Object.isFrozen(config.conversation.ai));
  assert.deepEqual(normalizeConfig(config), config);
});

test("unregistered plugins and removed decision providers are rejected rather than migrated", () => {
  for (const name of ["ai-conversation", "unknown-plugin"]) {
    assert.throws(() => normalizeConfig({ plugins: [{ name }] }), /不支持的插件/);
  }
  for (const provider of ["ai-conversation", "custom", null]) {
    assert.throws(() => normalizeConfig({ decision: { provider } }), /不支持的决策配置字段/);
  }
  for (const textService of ["ai-conversation.text", "custom.text", ""]) {
    assert.throws(() => normalizeConfig({ plugins: [{ name: "memory", textService }] }), /不支持的记忆配置字段/);
  }
});

test("core conversation validates sections, enabled, model strings and timeout ranges", () => {
  for (const conversation of [[], { enabled: "yes" }, { ai: [] }, { character: [] },
    { ai: { endpoint: 42 } }, { ai: { timeoutMs: 999 } }, { ai: { retryBudgetMs: 1200001 } }]) {
    assert.throws(() => normalizeConfig({ conversation }), /conversation/);
  }
});
