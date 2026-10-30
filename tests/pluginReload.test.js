const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createPluginHost } = require("../electron/pluginHost");
const { createConfigStore } = require("../electron/config");
const { MessageBus } = require("../electron/architecture/messageBus");
const { createServiceRegistry } = require("../electron/architecture/serviceRegistry");
const { getPlugin } = require("../electron/plugins/registry");
const menuHooks = require("../electron/menuHooks");

const quiet = { info() {}, warn() {}, error() {} };
const config = (...plugins) => ({ plugins });

function harness(t, definitions, initial) {
  const bus = new MessageBus();
  const services = createServiceRegistry();
  const ipc = new Map();
  const events = [];
  const instances = new Map();
  const host = createPluginHost({
    bus, services, getConfig: () => initial, logger: quiet,
    ipc: { handle(channel, handler) {
      assert.equal(ipc.has(channel), false, `duplicate IPC handler: ${channel}`);
      ipc.set(channel, handler);
      return () => ipc.delete(channel);
    } },
    definitions: definitions.map((definition) => ({
      ...definition,
      shouldLoad: definition.shouldLoad || ((snapshot) => getPlugin(snapshot, definition.name)?.enabled === true),
      load: () => ({ activate(context) {
        const name = definition.name;
        const options = context.config.getPluginOptions(name);
        const instance = { context, version: options.version, received: 0, dependencies: [] };
        const list = instances.get(name) || [];
        list.push(instance);
        instances.set(name, list);
        events.push(`activate:${name}:${options.version}`);
        for (const service of definition.provides || []) {
          context.services.register(service.slice(name.length + 1), { version: options.version }, { allowWhileStopped: true });
        }
        const requires = typeof definition.requires === "function" ? definition.requires(context.config.get()) : definition.requires || [];
        instance.dependencies = requires.map((service) => context.services.get(service));
        context.bus.subscribe("reload-test", () => { instance.received++; });
        context.menu.register(() => [{ label: name }]);
        context.ipc.handle("inspect", () => instance.version);
        if (options.fail) throw new Error("activation failed for test");
        return {
          start() { events.push(`start:${name}:${context.config.getPluginOptions(name).version}`); },
          async stop() {
            events.push(`stop:${name}:${context.config.getPluginOptions(name).version}`);
            await definition.onStop?.(instance);
          },
          dispose() {
            events.push(`dispose:${name}:${context.config.getPluginOptions(name).version}`);
            for (const dependency of instance.dependencies) assert.notEqual(dependency.version, undefined);
          },
        };
      } }),
    })),
  });
  t.after(() => host.dispose());
  return { host, bus, services, ipc, events, instances };
}

test("reload replaces only a changed plugin and cleans old registrations", async (t) => {
  const initial = config({ name: "first", enabled: true, version: 1 }, { name: "second", enabled: true, version: 1 });
  const h = harness(t, [{ name: "first", provides: ["first.value"] }, { name: "second" }], initial);
  await h.host.activate();
  await h.host.start();
  h.events.length = 0;
  await h.host.reload(config({ ...initial.plugins[0], version: 2 }, initial.plugins[1]));
  assert.deepEqual(h.events, ["stop:first:1", "dispose:first:1", "activate:first:2", "start:first:2"]);
  assert.equal(h.instances.get("second").length, 1);
  assert.equal(h.services.get("first.value").version, 2);
  assert.equal(h.ipc.get("first:inspect")(), 2);
  assert.equal(menuHooks.getMenuContributions().filter(({ label }) => label === "first").length, 1);
  await h.bus.publish("reload-test", {});
  assert.equal(h.instances.get("first")[0].received, 0);
  assert.equal(h.instances.get("first")[1].received, 1);
  assert.throws(() => h.instances.get("first")[0].context.config.get(), /已卸载/);
});

test("plugin reorder and root-only changes do not reload healthy plugins", async (t) => {
  const initial = config({ name: "first", enabled: true, version: 1 }, { name: "second", enabled: true, version: 1 });
  const h = harness(t, [{ name: "first" }, { name: "second" }], initial);
  await h.host.activate();
  await h.host.start();
  h.events.length = 0;
  await h.host.reload({ ...config(...initial.plugins.toReversed()), decision: { interval_ms: 4567 } });
  assert.deepEqual(h.events, []);
  assert.equal(h.instances.get("first")[0].context.config.get().decision.interval_ms, 4567);
});

test("provider reload disposes transitive consumers first and restarts in dependency order", async (t) => {
  // Consumers precede their providers in the catalog to exercise dependency sorting.
  const definitions = [
    { name: "leaf", requires: ["middle.value"] },
    { name: "middle", provides: ["middle.value"], requires: ["source.value"] },
    { name: "source", provides: ["source.value"] },
    { name: "unrelated" },
  ];
  const initial = config(...definitions.map(({ name }) => ({ name, enabled: true, version: 1 })));
  const h = harness(t, definitions, initial);
  await h.host.activate();
  await h.host.start();
  h.events.length = 0;
  await h.host.reload(config(...initial.plugins.map((plugin) => plugin.name === "source" ? { ...plugin, version: 2 } : plugin)));
  assert.deepEqual(h.events, [
    "stop:leaf:1", "stop:middle:1", "stop:source:1",
    "dispose:leaf:1", "dispose:middle:1", "dispose:source:1",
    "activate:source:2", "activate:middle:1", "activate:leaf:1",
    "start:source:2", "start:middle:1", "start:leaf:1",
  ]);
  assert.equal(h.instances.get("middle")[1].dependencies[0].version, 2);
  assert.equal(h.instances.get("unrelated").length, 1);
  h.events.length = 0;
  await h.host.dispose();
  const disposals = h.events.filter((entry) => entry.startsWith("dispose:"));
  assert.ok(disposals.includes("dispose:unrelated:1"));
  assert.deepEqual(disposals.filter((entry) => !entry.includes("unrelated")), [
    "dispose:leaf:1", "dispose:middle:1", "dispose:source:2",
  ]);
  assert.equal(h.ipc.size, 0);
});

test("disabling or removing a provider blocks dependents and adding it back recovers them", async (t) => {
  const initial = config({ name: "source", enabled: true, version: 1 }, { name: "consumer", enabled: true, version: 1 });
  const h = harness(t, [{ name: "consumer", requires: ["source.value"] }, { name: "source", provides: ["source.value"] }], initial);
  await h.host.activate();
  await h.host.start();
  await h.host.reload(config({ ...initial.plugins[0], enabled: false }, initial.plugins[1]));
  assert.equal(h.host.getState().source.status, "disabled");
  assert.equal(h.host.getState().consumer.status, "blocked");
  assert.equal(h.services.get("source.value"), undefined);
  assert.equal(h.ipc.size, 0);
  await h.host.reload(config(initial.plugins[1]));
  assert.equal(h.host.getState().consumer.status, "blocked");
  await h.host.reload(config({ ...initial.plugins[0], version: 2 }, initial.plugins[1]));
  assert.equal(h.host.getState().consumer.status, "running");
  assert.equal(h.instances.get("consumer")[1].dependencies[0].version, 2);
});

test("changing a dependency selection reloads the consumer without replacing providers", async (t) => {
  const initial = config(
    { name: "consumer", enabled: true, version: 1, service: "first.value" },
    { name: "first", enabled: true, version: 1 }, { name: "second", enabled: true, version: 2 },
  );
  const h = harness(t, [
    { name: "consumer", requires: (snapshot) => [getPlugin(snapshot, "consumer").service] },
    { name: "first", provides: ["first.value"] }, { name: "second", provides: ["second.value"] },
  ], initial);
  await h.host.activate();
  await h.host.start();
  await h.host.reload(config({ ...initial.plugins[0], service: "second.value" }, ...initial.plugins.slice(1)));
  assert.equal(h.instances.get("consumer")[1].dependencies[0].version, 2);
  assert.equal(h.instances.get("first").length, 1);
  assert.equal(h.instances.get("second").length, 1);
});

test("failed activation cleans registrations and a corrected configuration recovers", async (t) => {
  const initial = config({ name: "source", enabled: true, version: 1 }, { name: "consumer", enabled: true, version: 1 });
  const h = harness(t, [{ name: "source", provides: ["source.value"] }, { name: "consumer", requires: ["source.value"] }], initial);
  await h.host.activate();
  await h.host.start();
  await h.host.reload(config({ ...initial.plugins[0], version: 2, fail: true }, initial.plugins[1]));
  assert.equal(h.host.getState().source.status, "failed");
  assert.equal(h.host.getState().consumer.status, "blocked");
  assert.equal(h.services.get("source.value"), undefined);
  assert.equal(h.ipc.size, 0);
  await h.host.reload(config({ ...initial.plugins[0], version: 3 }, initial.plugins[1]));
  assert.equal(h.host.getState().consumer.status, "running");
  assert.equal(h.instances.get("consumer")[1].dependencies[0].version, 3);
});

test("reloads are serialized and old instances finish against their previous configuration", async (t) => {
  let release;
  let entered;
  const stopping = new Promise((resolve) => { entered = resolve; });
  const hold = new Promise((resolve) => { release = resolve; });
  const initial = config({ name: "first", enabled: true, version: 1 });
  const h = harness(t, [{ name: "first", onStop: async (instance) => {
    if (instance.version === 1) { entered(); await hold; }
  } }], initial);
  await h.host.activate();
  await h.host.start();
  h.events.length = 0;
  const first = h.host.reload(config({ ...initial.plugins[0], version: 2 }));
  await stopping;
  const second = h.host.reload(config({ ...initial.plugins[0], version: 3 }));
  assert.equal(h.instances.get("first").length, 1);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(h.events, [
    "stop:first:1", "dispose:first:1", "activate:first:2", "start:first:2",
    "stop:first:2", "dispose:first:2", "activate:first:3", "start:first:3",
  ]);
});

test("reload while the host is stopped does not restart plugins", async (t) => {
  const initial = config({ name: "first", enabled: true, version: 1 });
  const h = harness(t, [{ name: "first" }], initial);
  await h.host.activate();
  await h.host.start();
  await h.host.stop();
  h.events.length = 0;
  await h.host.reload(config({ ...initial.plugins[0], version: 2 }));
  assert.ok(!h.events.some((entry) => entry.startsWith("start:")));
  await h.host.start();
  assert.equal(h.host.getState().first.status, "running");
});

test("shutdown during reload prevents new instances from starting", async (t) => {
  let release;
  let entered;
  const stopping = new Promise((resolve) => { entered = resolve; });
  const hold = new Promise((resolve) => { release = resolve; });
  const initial = config({ name: "source", enabled: true, version: 1 });
  const h = harness(t, [{ name: "source", provides: ["source.value"], onStop: async () => {
    entered(); await hold;
  } }], initial);
  await h.host.activate();
  await h.host.start();
  const reload = h.host.reload(config({ ...initial.plugins[0], version: 2 }));
  await stopping;
  const shutdown = h.host.dispose();
  release();
  await Promise.all([reload, shutdown]);
  assert.equal(h.instances.get("source").length, 1);
  assert.equal(h.services.get("source.value"), undefined);
  assert.equal(h.ipc.size, 0);
  await h.host.reload(initial);
  assert.equal(h.instances.get("source").length, 1);
});

test("file watch notifications trigger plugin reload only for valid changed configuration", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pet-plugin-reload-"));
  const file = path.join(dir, "config.json");
  const initial = config({ name: "manual-input", enabled: true, version: 1 });
  fs.writeFileSync(file, JSON.stringify(initial));
  const h = harness(t, [{ name: "manual-input" }], initial);
  const store = createConfigStore(file, { changeDebounceMs: 20, logger: quiet });
  const reloads = [];
  const unsubscribe = store.subscribe((snapshot) => {
    const reload = h.host.reload(snapshot);
    reloads.push(reload);
    return reload;
  });
  t.after(() => { unsubscribe(); store.stopWatching(); fs.rmSync(dir, { recursive: true, force: true }); });
  await h.host.activate();
  await h.host.start();
  store.startWatching();
  async function waitFor(predicate) {
    const deadline = Date.now() + 3000;
    while (!predicate()) {
      assert.ok(Date.now() < deadline, "Timed out waiting for watched configuration");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  fs.writeFileSync(file, "{");
  await waitFor(() => store.getStatus().error);
  assert.equal(reloads.length, 0);
  fs.writeFileSync(file, JSON.stringify(config({ ...initial.plugins[0], version: 2 })));
  await waitFor(() => reloads.length === 1);
  await reloads[0];
  assert.equal(h.instances.get("manual-input").at(-1).version, 2);
  // Whitespace alone must not create another lifecycle transition.
  fs.writeFileSync(file, JSON.stringify(config({ ...initial.plugins[0], version: 2 }), null, 2));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(reloads.length, 1);
  unsubscribe();
  fs.writeFileSync(file, JSON.stringify(config({ ...initial.plugins[0], version: 3 })));
  await waitFor(() => store.load().plugins.find(({ name }) => name === "manual-input").version === 3);
  assert.equal(reloads.length, 1);
});


test("service observers pause on stop and are removed when an instance is reloaded or disposed", async (t) => {
  const services = createServiceRegistry();
  const observations = [];
  const initial = config({ name: "observer", version: 1 });
  const host = createPluginHost({ bus: new MessageBus(), services, logger: quiet, getConfig: () => initial,
    definitions: [{ name: "observer", shouldLoad: () => true, load: () => ({ activate(context) {
      const version = context.config.getPluginOptions("observer").version;
      context.services.subscribe(({ name }) => observations.push([version, name]));
      return {};
    } }) }],
  });
  t.after(() => host.dispose());
  await host.activate(); await host.start();
  services.register("first", {});
  await host.stop();
  services.register("stopped", {});
  await host.start();
  services.register("resumed", {});
  await host.reload(config({ name: "observer", version: 2 }));
  services.register("reloaded", {});
  await host.dispose();
  services.register("disposed", {});
  assert.deepEqual(observations, [[1, "first"], [1, "resumed"], [2, "reloaded"]]);
});
