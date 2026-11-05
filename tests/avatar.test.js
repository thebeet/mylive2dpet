const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAvatarHost } = require("../electron/architecture/avatar");
const { normalizeConfig } = require("../electron/config");
const { getPlugin } = require("../electron/plugins/registry");
const { createPluginHost } = require("../electron/pluginHost");
const { MessageBus } = require("../electron/architecture/messageBus");
const menuHooks = require("../electron/menuHooks");
const live2dDefinition = require("../electron/plugins/avatarLive2d/definition");
const { readCatalog } = require("../electron/plugins/avatarLive2d");
const { modelUrl } = require("../electron/plugins/avatarShared/options");
const descriptor = () => ({ renderer: "test", expressions: ["neutral", "smile"], motions: [{ id: "wave", label: "Wave" }] });

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pet-avatar-"));
  fs.mkdirSync(path.join(dir, "assets"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const model = expression => ({ FileReferences: {
    Expressions: [{ Name: "neutral" }, { Name: expression }, { Name: "_internal" }],
    Motions: {
      Thinking: [{ File: "idle.motion3.json" }],
      ReachStudy: [{ File: "tap.motion3.json" }],
      Extra: [{ File: "_hidden.motion3.json" }, { File: "visible.motion3.json" }],
      _Internal: [{ File: "hidden.motion3.json" }],
    },
  } });
  for (const [file, expression] of [["first", "smile"], ["second", "sad"]]) {
    fs.writeFileSync(path.join(dir, "assets", `${file}.model3.json`), JSON.stringify(model(expression)));
  }
  const config = file => normalizeConfig({ plugins: [{ name: "avatar-live2d", modelPath: `assets/${file}.model3.json`, iconPath: "" }] });
  return { dir, config };
}

test("avatar config migrates old setups, permits explicit 3D and rejects competing providers", () => {
  const old = normalizeConfig({});
  assert.equal(getPlugin(old, "avatar-live2d").enabled, true);
  const explicit = normalizeConfig({ plugins: [{ name: "avatar-3d" }] });
  assert.equal(getPlugin(explicit, "avatar-3d").enabled, true);
  assert.equal(getPlugin(explicit, "avatar-live2d").enabled, false);
  assert.deepEqual(normalizeConfig(explicit), explicit);
  const off = normalizeConfig({ plugins: [{ name: "avatar-live2d", enabled: false }] });
  assert.equal(getPlugin(off, "avatar-live2d").enabled, false);
  assert.throws(() => normalizeConfig({ plugins: [{ name: "avatar-live2d" }, { name: "avatar-3d" }] }), /只能启用一个/);
});

test("avatar options preserve fractional layout and validate formats, paths and motion indexes", () => {
  const config = normalizeConfig({ plugins: [{ name: "avatar-3d", scale: 1.25, rotationY: 12.5, verticalOffset: -2.5 }] });
  assert.equal(getPlugin(config, "avatar-3d").scale, 1.25);
  assert.equal(getPlugin(config, "avatar-3d").verticalOffset, -2.5);
  for (const options of [{ modelPath: "../x.pmx" }, { modelPath: "assets/../x.pmx" }, { modelPath: "assets/x.vrm" }, { scale: 0 }, { scale: "1" }]) {
    assert.throws(() => normalizeConfig({ plugins: [{ name: "avatar-3d", ...options }] }));
  }
  assert.throws(() => normalizeConfig({ plugins: [{ name: "avatar-live2d", idleMotion: { group: "Idle", index: 0.5 } }] }), /整数/);
  assert.equal(modelUrl("assets/【芙宁娜】/file #1.pmx"), "./assets/%E3%80%90%E8%8A%99%E5%AE%81%E5%A8%9C%E3%80%91/file%20%231.pmx");
});

test("3D physics defaults to enabled, accepts an explicit opt-out and rejects non-booleans", () => {
  const options = value => getPlugin(normalizeConfig({ plugins: [{ name: "avatar-3d", ...value }] }), "avatar-3d");
  assert.equal(options({}).physicsEnabled, true);
  assert.equal(options({ physicsEnabled: true }).physicsEnabled, true);
  assert.equal(options({ physicsEnabled: false }).physicsEnabled, false);
  for (const value of ["false", 0, {}, []]) assert.throws(() => options({ physicsEnabled: value }), /physicsEnabled.*布尔值/);
});

test("avatar host ignores stale acknowledgements, validates commands and releases exactly once", () => {
  const changes = [], commands = [];
  const host = createAvatarHost({ onChange: snapshot => changes.push(snapshot), sendCommand: command => commands.push(command) });
  const release = host.register("first", descriptor());
  const first = host.getSnapshot().revision;
  assert.throws(() => host.register("second", descriptor()), /已有启用/);
  assert.equal(host.command("first", { type: "motion", id: "wave" }), false);
  assert.equal(host.setReady(first - 1), false);
  assert.equal(host.setReady(first), true);
  assert.equal(host.command("other", { type: "motion", id: "wave" }), false);
  assert.equal(host.command("first", { type: "motion", id: "missing" }), false);
  assert.equal(host.command("first", { type: "expression", id: "smile" }), true);
  assert.deepEqual(commands, [{ type: "expression", id: "smile", revision: first }]);
  release(); release();
  assert.equal(changes.length, 2);
  host.register("second", descriptor());
  assert.equal(host.setReady(first), false);
  release();
  assert.equal(host.getSnapshot().avatar.plugin, "second");
  host.setReady(host.getSnapshot().revision);
  host.resetReady();
  assert.equal(host.isReady("second"), false);
});

test("Live2D catalog preserves original motion indexes while hiding internal entries", t => {
  const f = fixture(t);
  const catalog = readCatalog(path.join(f.dir, "assets/first.model3.json"));
  assert.deepEqual(catalog.expressions, ["neutral", "smile"]);
  assert.deepEqual(catalog.motions.map(m => m.id), ["Thinking:0", "ReachStudy:0", "Extra:1"]);
});

test("rotation reset menu and commands are limited to a ready provider declaring the control", () => {
  const { activateAvatar } = require("../electron/plugins/avatarShared");
  const commands = [];
  const avatar = createAvatarHost({ sendCommand: command => commands.push(command) });
  let menu;
  const context = name => ({
    menu: { register: getItems => { menu = getItems; } },
    avatar: {
      register: value => avatar.register(name, value),
      isReady: () => avatar.isReady(name),
      command: command => avatar.command(name, command),
    },
  });
  const live2d = activateAvatar(context("live2d"), descriptor());
  live2d.start();
  avatar.setReady(avatar.getSnapshot().revision);
  assert.equal(menu().some(item => item.label === "角度回正"), false);
  assert.equal(avatar.command("live2d", { type: "control", id: "resetRotation" }), false);
  live2d.stop();
  const mmd = activateAvatar(context("mmd"), { ...descriptor(), controls: ["resetRotation"] });
  mmd.start();
  assert.equal(menu().find(item => item.label === "角度回正").enabled, false);
  assert.equal(avatar.command("mmd", { type: "control", id: "resetRotation" }), false);
  const revision = avatar.getSnapshot().revision;
  avatar.setReady(revision);
  const reset = menu().find(item => item.label === "角度回正");
  assert.equal(reset.enabled, true);
  reset.click();
  assert.deepEqual(commands, [{ type: "control", id: "resetRotation", revision }]);
  mmd.stop();
});

test("real avatar plugin lifecycle reloads catalogs and clears menus and provider on unload", async t => {
  const f = fixture(t);
  const avatar = createAvatarHost();
  const host = createPluginHost({
    avatar, bus: new MessageBus(), getConfig: () => f.config("first"),
    paths: { projectRoot: f.dir }, definitions: [live2dDefinition], logger: { info() {}, error() {} },
  });
  t.after(() => host.dispose());
  await host.activate();
  assert.equal(avatar.getSnapshot().avatar, null);
  await host.start();
  const oldRevision = avatar.getSnapshot().revision;
  avatar.setReady(oldRevision);
  assert.deepEqual(avatar.getExpressions(), ["neutral", "smile"]);
  assert.equal(menuHooks.getMenuContributions().find(item => item.label === "切换表情").enabled, true);
  await host.reload(f.config("second"));
  assert.deepEqual(avatar.getExpressions(), ["neutral", "sad"]);
  assert.equal(avatar.setReady(oldRevision), false);
  assert.equal(menuHooks.getMenuContributions().find(item => item.label === "切换表情").enabled, false);
  await host.stop();
  assert.equal(avatar.getSnapshot().avatar, null);
  await host.start();
  assert.deepEqual(avatar.getExpressions(), ["neutral", "sad"]);
  await host.dispose();
  assert.equal(avatar.getSnapshot().avatar, null);
  assert.equal(menuHooks.getMenuContributions().filter(item => ["播放动作", "切换表情"].includes(item.label)).length, 0);
});

test("invalid Live2D default expression fails activation without registering a provider", async t => {
  const f = fixture(t);
  const avatar = createAvatarHost();
  const config = f.config("first");
  const input = JSON.parse(JSON.stringify(config));
  input.plugins.find(p => p.name === "avatar-live2d").defaultExpression = "missing";
  const host = createPluginHost({ avatar, bus: new MessageBus(), getConfig: () => normalizeConfig(input),
    paths: { projectRoot: f.dir }, definitions: [live2dDefinition], logger: { info() {}, error() {} } });
  t.after(() => host.dispose());
  await host.activate();
  await host.start();
  assert.equal(host.getState()["avatar-live2d"].status, "failed");
  assert.equal(avatar.getSnapshot().avatar, null);
});

for (const name of ["【芙宁娜】", "【芙宁娜_荒】"]) {
  const file = path.join(__dirname, `../assets/【芙宁娜】/${name}.pmx`);
  test(`local PMX catalog supports ${name} and its declared expression morphs`, { skip: !fs.existsSync(file) }, () => {
    const catalog = require("../electron/plugins/avatar3d").readCatalog(file);
    for (const name of ["neutral", "smile", "sad", "angry", "surprised", "まばたき"]) assert.ok(catalog.expressions.includes(name));
    assert.deepEqual(catalog.motions.map(m => m.id), ["idle", "wave"]);
    assert.ok(catalog.expressionMorphs.smile["にこり"] > 0);
  });
}
