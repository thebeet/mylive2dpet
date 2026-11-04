const test = require("node:test");
const assert = require("node:assert/strict");
const { workStorage, mockWindows } = require("./helpers/workStorage");
const { createScheduleScheduler, CHECK_INTERVAL_MS } = require("../electron/plugins/schedule/scheduler");
const definition = require("../electron/plugins/schedule/definition");
const { createSchedulePlugin } = require("../electron/plugins/schedule");
const { normalizeConfig } = require("../electron/config");
const { createPluginHost } = require("../electron/pluginHost");
const { MessageBus } = require("../electron/architecture/messageBus");
const { createPerceptionService } = require("../electron/architecture/perceptionService");
const { createServiceRegistry } = require("../electron/architecture/serviceRegistry");
const EVENTS = require("../electron/architecture/events");
const quiet = { info() {}, warn() {}, error() {} };
const settle = () => new Promise((resolve) => setImmediate(resolve));

function clock() {
  let time = Date.parse("2026-11-04T09:00:00+08:00");
  let timer;
  return {
    now: () => time,
    advance: (ms) => { time += ms; },
    setTimer: (callback, ms) => {
      assert.equal(timer, undefined, "only one wakeup may be armed");
      timer = { callback, ms, unref() {} }; return timer;
    },
    clearTimer: (handle) => { if (timer === handle) timer = undefined; },
    timer: () => timer,
    async fire() {
      assert.ok(timer);
      const callback = timer.callback;
      timer = undefined;
      callback();
      await settle();
    },
  };
}

function harness(t, overrides = {}) {
  const stored = workStorage();
  const c = clock();
  const bus = new MessageBus({ logger: quiet });
  const perception = createPerceptionService(bus);
  let calls = 0;
  const scheduler = createScheduleScheduler({ storage: stored.storage,
    submit: (observation) => { calls++; return perception.submit(observation); },
    options: definition.normalizeOptions(), logger: quiet, ...c, ...overrides });
  t.after(async () => { await scheduler.stop(); stored.db.close(); });
  scheduler.start();
  return { scheduler, c, bus, perception, ...stored, calls: () => calls };
}

test("schedule queues one context notification at its target without requesting decisions or output", async (t) => {
  const h = harness(t);
  let decisions = 0, speech = 0;
  h.bus.subscribe(EVENTS.DECISION_REQUESTED, () => decisions++);
  h.bus.subscribe(EVENTS.SPEECH_OUTPUT_REQUESTED, () => speech++);
  const task = h.scheduler.create({ text: "  提醒我开会  ", scheduledAt: h.c.now() + 1000 });
  assert.equal(h.c.timer().ms, 1000);
  h.c.advance(999); await h.c.fire();
  assert.equal(h.calls(), 0);
  assert.equal(h.c.timer().ms, 1);
  h.c.advance(1); await h.c.fire();
  const [observation] = await h.perception.takeBatch();
  assert.equal(observation.source, "schedule");
  assert.equal(observation.role, "context");
  assert.equal(observation.trigger, "scheduled");
  assert.equal(observation.id, `schedule:${task.id}`);
  assert.equal(observation.metadata.taskId, task.id);
  assert.equal(observation.metadata.originalRequest, "提醒我开会");
  assert.match(observation.content[0].text, /提醒我开会/);
  assert.equal(observation.expiresAt, undefined);
  assert.equal(h.scheduler.list()[0].status, "queued");
  await h.c.fire();
  assert.equal(h.calls(), 1);
  assert.equal(decisions, 0);
  assert.equal(speech, 0);
});

test("task validation rejects missing text and ambiguous, past or out-of-range times", (t) => {
  const h = harness(t);
  for (const input of [null, {}, { text: " " }, { text: "a".repeat(4001) },
    { text: "x", scheduledAt: h.c.now() }, { text: "x", scheduledAt: Infinity },
    { text: "x", scheduledAt: 8640000000000001 },
    { text: "x", scheduledAt: "2026-11-05T09:00" }]) {
    assert.throws(() => h.scheduler.create(input));
  }
  const task = h.scheduler.create({ text: "x", scheduledAt: "2026-11-05T09:00:00+08:00" });
  assert.equal(task.scheduledAt, Date.parse("2026-11-05T09:00:00+08:00"));
});

test("cancelling the nearest notification reschedules and never delivers it", async (t) => {
  const h = harness(t);
  const first = h.scheduler.create({ text: "first", scheduledAt: h.c.now() + 1000 });
  h.scheduler.create({ text: "second", scheduledAt: h.c.now() + 5000 });
  assert.equal(h.c.timer().ms, 1000);
  h.scheduler.cancel(first.id);
  assert.equal(h.c.timer().ms, 5000);
  h.c.advance(5000); await h.c.fire();
  assert.equal(h.calls(), 1);
  assert.equal(h.scheduler.list()[0].status, "cancelled");
  const [observation] = await h.perception.takeBatch();
  assert.equal(observation.metadata.originalRequest, "second");
});

test("restart catches up pending notifications but retains queued and cancelled history", async (t) => {
  const h = harness(t);
  const first = h.scheduler.create({ text: "first", scheduledAt: h.c.now() + 100 });
  const cancelled = h.scheduler.create({ text: "cancelled", scheduledAt: h.c.now() + 200 });
  h.scheduler.cancel(cancelled.id);
  h.c.advance(100); await h.c.fire();
  const pending = h.scheduler.create({ text: "pending", scheduledAt: h.c.now() + 1000 });
  await h.scheduler.stop();
  assert.equal(h.c.timer(), undefined);
  h.c.advance(60000);
  const recovered = createScheduleScheduler({ storage: h.storage, submit: h.perception.submit,
    options: definition.normalizeOptions(), logger: quiet, ...h.c });
  t.after(() => recovered.stop());
  recovered.start(); await h.c.fire();
  assert.equal(recovered.list().find((task) => task.id === first.id).status, "queued");
  assert.equal(recovered.list().find((task) => task.id === pending.id).status, "queued");
  const observations = await h.perception.takeBatch();
  assert.equal(observations.length, 2);
  assert.equal(observations[1].metadata.delayMs, 59000);
});

test("clock changes and long delays use bounded wakeups and recheck the target", async (t) => {
  const h = harness(t);
  h.scheduler.create({ text: "far future", scheduledAt: h.c.now() + 40 * 86400000 });
  assert.equal(h.c.timer().ms, CHECK_INTERVAL_MS);
  h.c.advance(-60000); await h.c.fire();
  assert.equal(h.calls(), 0);
  h.c.advance(41 * 86400000); await h.c.fire();
  assert.equal(h.calls(), 1);
});

test("ingress failure retries with a delay then stops after the configured retry budget", async (t) => {
  let calls = 0;
  const h = harness(t, { submit: async () => { calls++; throw new Error("queue full"); } });
  h.scheduler.create({ text: "retry", scheduledAt: h.c.now() + 100 });
  h.c.advance(100); await h.c.fire();
  assert.equal(h.scheduler.list()[0].status, "pending");
  assert.equal(h.c.timer().ms, 30000);
  h.c.advance(29999); await h.c.fire();
  assert.equal(calls, 1);
  h.c.advance(1); await h.c.fire();
  h.c.advance(30000); await h.c.fire();
  assert.equal(calls, 3);
  assert.equal(h.scheduler.list()[0].status, "failed");
  assert.equal(h.scheduler.list()[0].lastError, "queue full");
  h.c.advance(30000); await h.c.fire();
  assert.equal(calls, 3);
});

test("TTL starts at actual submission time when a notification is overdue", async (t) => {
  const h = harness(t, { options: definition.normalizeOptions({ observationTtlMs: 60000 }) });
  h.scheduler.create({ text: "overdue", scheduledAt: h.c.now() + 100 });
  h.c.advance(3600000); await h.c.fire();
  const observation = h.bus.peek(EVENTS.PERCEPTION_OBSERVATION)[0];
  assert.equal(observation.expiresAt, h.c.now() + 60000);
  assert.equal(Date.parse(observation.capturedAt), h.c.now());
});

test("stop waits for accepted ingress and prevents the next due notification from submitting", async (t) => {
  let release, calls = 0;
  const pending = new Promise((resolve) => { release = resolve; });
  const h = harness(t, { submit: async (observation) => { calls++; await pending; return observation; } });
  h.scheduler.create({ text: "one", scheduledAt: h.c.now() + 100 });
  h.scheduler.create({ text: "two", scheduledAt: h.c.now() + 200 });
  h.c.advance(300); await h.c.fire();
  let stopped = false;
  const stopping = h.scheduler.stop().then(() => { stopped = true; });
  await settle(); assert.equal(stopped, false);
  release(); await stopping;
  assert.equal(calls, 1);
  assert.equal(h.c.timer(), undefined);
  assert.deepEqual(h.scheduler.list().map((task) => task.status), ["queued", "pending"]);
  assert.throws(() => h.scheduler.create({ text: "x", scheduledAt: h.c.now() + 1000 }), /已停止/);
});

test("a failed post-ingress Storage write retries bookkeeping without duplicate ingress", async (t) => {
  const h = harness(t);
  const collection = h.storage.collection("schedule.tasks");
  const schedulerStorage = { ...h.storage, collection: () => ({ ...collection,
    set(key, value) {
      if (value.status === "queued" && failWrite) { failWrite = false; throw new Error("write failed"); }
      return collection.set(key, value);
    },
  }) };
  let calls = 0, failWrite = true;
  await h.scheduler.stop();
  const scheduler = createScheduleScheduler({ storage: schedulerStorage,
    submit: async (observation) => { calls++; return observation; },
    options: definition.normalizeOptions(), logger: quiet, ...h.c });
  t.after(() => scheduler.stop());
  scheduler.start();
  scheduler.create({ text: "once", scheduledAt: h.c.now() + 100 });
  h.c.advance(100); await h.c.fire();
  assert.equal(scheduler.list()[0].status, "submitting");
  assert.equal(h.c.timer().ms, CHECK_INTERVAL_MS);
  h.c.advance(CHECK_INTERVAL_MS); await h.c.fire();
  assert.equal(scheduler.list()[0].status, "queued");
  assert.equal(calls, 1);
});

test("a failed retry-state write recovers without leaving the task stuck in submitting", async (t) => {
  const h = harness(t);
  await h.scheduler.stop();
  const collection = h.storage.collection("schedule.tasks");
  let failWrite = true, calls = 0;
  const scheduler = createScheduleScheduler({
    storage: { ...h.storage, collection: () => ({ ...collection, set(key, value) {
      if (value.status === "failed" && failWrite) { failWrite = false; throw new Error("write failed"); }
      collection.set(key, value);
    } }) },
    submit: async () => { calls++; throw new Error("queue full"); },
    options: definition.normalizeOptions({ maxRetries: 0 }), logger: quiet, ...h.c,
  });
  t.after(() => scheduler.stop());
  scheduler.start();
  scheduler.create({ text: "failure", scheduledAt: h.c.now() + 100 });
  h.c.advance(100); await h.c.fire();
  assert.equal(scheduler.list()[0].status, "submitting");
  h.c.advance(CHECK_INTERVAL_MS); await h.c.fire();
  assert.equal(scheduler.list()[0].status, "failed");
  assert.equal(calls, 1);
});

test("interrupted submission is recovered with its stable observation ID", async (t) => {
  const h = harness(t);
  const task = h.scheduler.create({ text: "interrupted", scheduledAt: h.c.now() + 100 });
  await h.scheduler.stop();
  h.storage.collection("schedule.tasks").set(task.id, { ...task, status: "submitting", attempts: 1 });
  h.c.advance(200); h.scheduler.start(); await h.c.fire();
  const [observation] = await h.perception.takeBatch();
  assert.equal(observation.id, `schedule:${task.id}`);
  assert.equal(h.scheduler.list()[0].status, "queued");
});

test("schedule window checks IPC ownership and closes and unregisters on disposal", async (t) => {
  const stored = workStorage(), c = clock(), windows = mockWindows(), handlers = new Map();
  let menu, service;
  const plugin = createSchedulePlugin({ storage: stored.storage, config: { get: () => ({}) }, logger: quiet,
    systemPrompt: { register: () => () => {} }, bus: new MessageBus({ logger: quiet }),
    perception: { submit: async (observation) => observation }, windows,
    services: { register: (name, value) => { assert.equal(name, "tasks"); service = value; return () => { service = null; }; } },
    menu: { register: (provider) => { menu = provider; return () => { menu = null; }; } },
    ipc: { handle: (channel, handler) => { handlers.set(channel, handler); return () => handlers.delete(channel); } },
  }, c);
  t.after(async () => { await plugin.dispose(); stored.db.close(); });
  plugin.start(); menu()[0].click();
  const win = windows.windows[0];
  assert.equal(win.options.webPreferences.sandbox, true);
  assert.throws(() => handlers.get("create")({ sender: {} }, {}), /窗口已关闭/);
  handlers.get("create")({ sender: win.webContents }, { text: "x", scheduledAt: c.now() + 100 });
  assert.equal(service.list().length, 1);
  await plugin.stop(); win.emit("ready-to-show");
  assert.equal(win.isDestroyed(), true);
  assert.equal(win.shows, 0);
  assert.throws(() => handlers.get("list")({ sender: win.webContents }), /窗口已关闭/);
  plugin.start();
  assert.equal(service.list().length, 1);
  await plugin.dispose();
  assert.equal(handlers.size, 0);
  assert.equal(menu, null);
  assert.equal(service, null);
  assert.equal(c.timer(), undefined);
});

test("manifest configuration and host dependencies expose schedule.tasks and disable it on reload", async (t) => {
  const stored = workStorage(), services = createServiceRegistry(), bus = new MessageBus({ logger: quiet });
  services.register("storage", stored.storage);
  const config = normalizeConfig({ plugins: [{ name: "schedule", enabled: true }] });
  assert.equal(definition.shouldLoad(normalizeConfig({})), true);
  for (const options of [{ observationTtlMs: -1 }, { maxRetries: 11 }, { retryDelayMs: 0 }, { unknown: 1 }]) {
    assert.throws(() => normalizeConfig({ plugins: [{ name: "schedule", ...options }] }));
  }
  const host = createPluginHost({ bus, services, storage: stored.core, logger: quiet,
    getConfig: () => config, definitions: [definition], perception: createPerceptionService(bus),
    ipc: { handle: () => () => {} },
  });
  t.after(async () => { await host.dispose(); stored.db.close(); });
  await host.activate(); await host.start();
  assert.equal(host.getState().schedule.status, "running");
  const service = services.get("schedule.tasks");
  service.create({ text: "future", scheduledAt: Date.now() + 60000 });
  await host.reload(normalizeConfig({ plugins: [{ name: "schedule", enabled: false }] }));
  assert.equal(host.getState().schedule.status, "disabled");
  assert.equal(services.get("schedule.tasks"), undefined);
  assert.throws(() => service.list(), /卸载/);
  assert.equal(stored.storage.collection("schedule.tasks").list().length, 1);
  await host.reload(config);
  assert.equal(services.get("schedule.tasks").list().length, 1);
});
