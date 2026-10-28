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
  assert.equal(getPlugin(config, "ai-conversation").ai.timeoutMs, 30000);
  assert.equal(getPlugin(config, "screen-perception").enabled, true);
  assert.equal(input.plugins.find(({ name }) => name === "screen-perception").intervalMs, undefined);
});

test("configuration rejects root feature options and flat memory parameters", () => {
  for (const key of ["ai", "character", "chat", "perception", "tts", "memory"]) {
    assert.throws(() => normalizeConfig({ [key]: {} }), /不支持的配置根字段/);
  }
  for (const key of ["path", "maxInject", "extractEveryNTurns", "maxTokens", "maxEntries"]) {
    assert.throws(() => normalizeConfig({ plugins: [{ name: "memory", [key]: 1 }] }), /不支持的记忆配置字段/);
  }
  assert.throws(() => normalizeConfig({ plugins: [{ name: "memory", longTerm: { path: "old.jsonl" } }] }), /legacyPath/);
});

test("optional plugins are explicit and memory enabled controls the entire plugin", () => {
  const config = normalizeConfig({ plugins: [{ name: "memory", enabled: false, longTerm: { enabled: true } }] });
  for (const name of ["ai-conversation", "tts", "memory", "audio-output-perception"]) {
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
