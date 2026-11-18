const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { pathToFileURL } = require("node:url");
const { MessageBus } = require("../electron/architecture/messageBus");
const EVENTS = require("../electron/architecture/events");
const { createPerceptionService } = require("../electron/architecture/perceptionService");
const { createCameraPerceptionPlugin } = require("../electron/plugins/cameraPerception");
const { createCameraBackend } = require("../electron/plugins/cameraPerception/cameraWindow");
const { normalizeConfig } = require("../electron/config");
const { getPlugin } = require("../electron/plugins/registry");
const { workStorage } = require("./helpers/workStorage");
const settle = () => new Promise(resolve => setImmediate(resolve));

function harness(t, { enabled = true, capture, options = {}, detector, devices = [{ deviceId: "test-id", label: "test camera", devicePath: options.devicePath || "" }] } = {}) {
  const stored = workStorage();
  const bus = new MessageBus();
  const perception = createPerceptionService(bus);
  const timers = new Set();
  let menu, deviceUpdate, captures = 0, stops = 0;
  const cameras = new Map();
  const plugin = createCameraPerceptionPlugin({
    bus, perception, storage: stored.storage,
    config: { get: () => ({ plugins: [{ name: "camera-perception", enabled, maxPendingObservations: 2, ...options }] }) },
    menu: { register: provider => { menu = provider; return () => { menu = null; }; }, refresh() {} },
  }, {
    createDetector: () => detector || { reset() {}, compareWithPrevious: () => ({ changed: true, distance: 5, threshold: 4 }) },
    setInterval: callback => { timers.add(callback); return callback; }, clearInterval: callback => timers.delete(callback),
    createBackend: (_context, callbacks) => {
      deviceUpdate = callbacks.onDevices;
      return {
        listDevices: async () => devices,
        createCamera(device, controls) {
          const camera = {
            shown: false, enabled: false,
            show() { camera.shown = true; },
            closePreview() { camera.shown = false; },
            toggle: controls.onToggle,
            setEnabled(value) { camera.enabled = value; },
            capture(options) {
              captures++;
              return capture ? capture(options) : Promise.resolve({ data: Buffer.from("jpeg"),
                width: 640, height: 480, device: device.label, capturedAt: new Date().toISOString() });
            },
            stop() { stops++; }, dispose() {},
          };
          cameras.set(device.deviceId, camera);
          return camera;
        },
        dispose() {},
      };
    },
  });
  t.after(async () => { await plugin.dispose(); stored.db.close(); });
  return { ...stored, plugin, bus, perception, timers, menu: () => menu()[0].submenu,
    cameras, deviceUpdate: next => deviceUpdate(next), captures: () => captures, stops: () => stops };
}

test("camera frames are persisted, bounded, and wait in the shared observation queue", async t => {
  const h = harness(t);
  let decisions = 0;
  h.bus.subscribe(EVENTS.DECISION_REQUESTED, () => decisions++);
  h.plugin.start();
  await settle();
  assert.equal(h.timers.size, 1);
  for (let i = 0; i < 3; i++) await h.perception.capture("camera");
  assert.equal(h.perception.pendingCount(), 2);
  const batch = await h.perception.takeBatch();
  assert.equal(batch[0].source, "camera");
  assert.equal(batch[0].role, "context");
  assert.equal(batch[0].metadata.device, "test camera");
  assert.ok(batch[0].expiresAt > Date.now());
  assert.equal(decisions, 0);
  const id = batch[0].metadata.screenshotId;
  assert.equal(h.storage.blobs("screenshots").get(id).data.toString(), "jpeg");
  await h.perception.release(batch, "completed");
  assert.ok(h.storage.blobs("screenshots").get(id));
});

test("disabled camera opens preview without enabling, and closing preview preserves enabled capture", async t => {
  const h = harness(t, { enabled: false });
  await h.plugin.start();
  assert.equal(h.captures(), 0);
  assert.equal(h.timers.size, 0);
  await assert.rejects(h.perception.capture("camera"), /未开启/);
  h.menu()[0].click();
  const camera = h.cameras.get("test-id");
  assert.equal(camera.shown, true);
  assert.equal(camera.enabled, false);
  camera.toggle();
  await settle();
  assert.equal(h.captures(), 1);
  assert.equal(h.perception.pendingCount(), 1);
  camera.closePreview();
  assert.equal(camera.enabled, true);
  assert.equal(h.menu()[0].label.startsWith("● "), true);
  assert.equal(h.menu().at(-1).label, "关闭所有");
  await h.perception.capture("camera");
  assert.equal(h.captures(), 2);
  await h.menu().at(-1).click();
  assert.equal(h.timers.size, 0);
  assert.equal(h.perception.pendingCount(), 0);
  assert.equal(camera.enabled, false);
  await h.plugin.dispose();
  assert.equal(h.perception.hasSource("camera"), false);
});

test("stop drops an unfinished camera frame and concurrent requests share capture", async t => {
  let resolveCapture;
  const h = harness(t, { enabled: false, capture: () => new Promise(resolve => { resolveCapture = resolve; }) });
  await h.plugin.start();
  h.menu()[0].click();
  h.cameras.get("test-id").toggle();
  const one = h.perception.capture("camera"), two = h.perception.capture("camera");
  assert.equal(h.captures(), 1);
  const stopped = h.plugin.stop();
  resolveCapture({ data: Buffer.from("old"), capturedAt: new Date().toISOString() });
  assert.equal(await one, null);
  assert.equal(await two, null);
  await stopped;
  assert.equal(h.storage.blobs("screenshots").list().entries.length, 0);
  assert.equal(h.perception.pendingCount(), 0);
});

test("multiple cameras sort active devices first, keep separate comparisons and stop independently", async t => {
  const devices = [
    { deviceId: "front", label: "Front Camera" },
    { deviceId: "phone", label: "Android Screen", devicePath: "/dev/video10" },
    { deviceId: "rear", label: "Rear Camera" },
  ];
  const h = harness(t, { devices, options: { devicePath: "/dev/video10", label: "手机屏幕" } });
  await h.plugin.start();
  await settle();
  assert.match(h.menu()[0].label, /^● 手机屏幕/);
  assert.equal(h.cameras.get("phone").shown, false);
  assert.equal(h.menu().at(-1).label, "关闭所有");
  h.menu().find(item => item.label === "Front Camera").click();
  assert.equal(h.cameras.get("front").enabled, false);
  h.cameras.get("front").toggle();
  await settle();
  assert.match(h.menu()[0].label, /^● Front Camera/);
  assert.match(h.menu()[1].label, /^● 手机屏幕/);
  assert.equal(h.timers.size, 2);
  await h.cameras.get("phone").toggle();
  assert.equal(h.cameras.get("front").enabled, true);
  assert.equal(h.timers.size, 1);
  const remaining = await h.perception.takeBatch();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].metadata.deviceId, "front");
  assert.equal(remaining[0].metadata.label, "Front Camera");
  await h.menu().at(-1).click();
  assert.equal(h.timers.size, 0);
  assert.equal(h.menu().some(item => item.label === "关闭所有"), false);
  h.deviceUpdate([devices[2]]);
  await settle();
  assert.deepEqual(h.menu().map(item => item.label), ["Rear Camera"]);
});

test("stop during enumeration cannot open a late configured camera", async t => {
  const h = harness(t);
  const started = h.plugin.start();
  await h.plugin.stop();
  await started;
  assert.equal(h.captures(), 0);
  assert.equal(h.timers.size, 0);
});

test("raw log clearing invalidates a camera capture that was already in progress", async t => {
  let resolveCapture;
  const h = harness(t, { capture: () => new Promise(resolve => { resolveCapture = resolve; }) });
  await h.plugin.start();
  const pending = h.perception.capture("camera");
  const { createRawLogRepository } = require("../electron/plugins/rawLog/repository");
  const { clearRawLog } = require("../electron/plugins/rawLog/clear");
  await clearRawLog({ bus: h.bus, perception: h.perception }, createRawLogRepository(h.storage), h.storage);
  resolveCapture({ data: Buffer.from("old"), capturedAt: new Date().toISOString() });
  assert.equal(await pending, null);
  assert.equal(h.storage.blobs("screenshots").list().entries.length, 0);
});

test("camera configuration validates bounds and keeps the source opt-in", () => {
  assert.equal(getPlugin(normalizeConfig({}), "camera-perception"), null);
  for (const invalid of [{ width: 0 }, { deviceId: 42 }, { devicePath: "/tmp/video" }, { devicePath: "/dev/video10", deviceId: "id" }, { label: " " }, { interval_ms: -1 }, { observationTtlMs: 0 }, { maxPendingObservations: 99 }]) {
    assert.throws(() => normalizeConfig({ plugins: [{ name: "camera-perception", ...invalid }] }));
  }
  for (const changeDetect of [[], { enabled: "yes" }, { hashSize: 0 }, { threshold: -1 }, { threshold: "bad" }]) {
    assert.throws(() => normalizeConfig({ plugins: [{ name: "camera-perception", changeDetect }] }));
  }
  assert.deepEqual(getPlugin(normalizeConfig({ plugins: [{ name: "camera-perception" }] }), "camera-perception").changeDetect,
    { enabled: true, hashSize: 8, threshold: 4 });
});

test("camera skips small changes for periodic and manual captures and resets its baseline", async t => {
  let previous = null, next = 0;
  const comparisons = [], skipped = [];
  const h = harness(t, {
    options: { changeDetect: { threshold: 4 } },
    capture: async () => ({ data: Buffer.from([next]), width: 640, height: 480, capturedAt: new Date().toISOString() }),
    detector: {
      reset() { previous = null; },
      compareWithPrevious(data, { options }) {
        const value = data[0];
        comparisons.push({ previous, value, options });
        const distance = previous == null ? -1 : Math.abs(previous - value);
        const changed = previous == null || distance > options.threshold;
        previous = value;
        return { changed, distance, threshold: options.threshold };
      },
    },
  });
  h.bus.subscribe(EVENTS.PERCEPTION_SKIPPED, event => skipped.push(event));
  h.plugin.start();
  await settle();
  assert.equal(h.perception.pendingCount(), 1);
  assert.equal(h.storage.blobs("screenshots").list().entries.length, 1);

  next = 4; // Equal to the threshold: skip, but advance the baseline.
  h.timers.values().next().value();
  await settle();
  next = 8; // Compare against 4, not the last queued frame (0).
  assert.equal(await h.perception.capture("camera", { trigger: "manual-camera" }), null);
  assert.equal(h.perception.pendingCount(), 1);
  assert.equal(h.storage.blobs("screenshots").list().entries.length, 1);
  assert.equal(skipped.length, 2);
  assert.equal(skipped[1].source, "camera");
  assert.equal(skipped[1].trigger, "manual-camera");
  assert.equal(skipped[1].reason, "little-change");
  assert.equal(comparisons[2].previous, 4);

  next = 13;
  const changed = await h.perception.capture("camera");
  assert.ok(changed);
  const batch = await h.perception.takeBatch();
  assert.equal(batch.length, 2);
  assert.equal(batch[1].metadata.distance, 5);
  assert.equal(batch[1].metadata.threshold, 4);

  await h.bus.notify(EVENTS.RAW_LOG_CLEARED, {});
  assert.ok(await h.perception.capture("camera"));
  await h.plugin.stop();
  h.plugin.start();
  await settle();
  assert.equal(comparisons.at(-1).previous, null);
  assert.equal(h.perception.pendingCount(), 1);
});

test("phone screen observations and saved frames carry their configured device path and label", async t => {
  let received;
  const h = harness(t, { options: { devicePath: "/dev/video10", label: "手机屏幕" }, capture: async options => {
    received = options;
    return { data: Buffer.from("phone"), device: "Android Screen", width: 640, height: 480, capturedAt: new Date().toISOString() };
  } });
  h.plugin.start();
  await settle();
  assert.equal(received.devicePath, "/dev/video10");
  const [observation] = await h.perception.takeBatch();
  assert.equal(observation.metadata.label, "手机屏幕");
  assert.equal(observation.metadata.devicePath, "/dev/video10");
  const saved = h.storage.blobs("screenshots").get(observation.metadata.screenshotId);
  assert.equal(saved.metadata.label, "手机屏幕");
  assert.equal(saved.metadata.devicePath, "/dev/video10");
  const { createScreenshotReader } = require("../electron/plugins/rawLog/screenshots");
  const reader = createScreenshotReader(h.storage);
  const page = reader.listScreenshots();
  assert.equal(page.entries[0].id, observation.metadata.screenshotId);
  assert.equal(page.entries[0].metadata.label, "手机屏幕");
  assert.equal(page.entries[0].data, undefined);
  assert.equal(page.entries[0].imageUrl, undefined);
  const preview = reader.getScreenshot(page.entries[0].id);
  assert.equal(preview.imageUrl, `data:image/jpeg;base64,${Buffer.from("phone").toString("base64")}`);
  assert.equal(preview.metadata.devicePath, "/dev/video10");
});

function windowHarness() {
  const handlers = new Map(), windows = [];
  let permissionCheck, permissionRequest;
  const context = {
    ipc: { handle: (channel, handler) => { handlers.set(channel, handler); return () => handlers.delete(channel); } },
    windows: { create(options) {
      const win = new EventEmitter(), contents = new EventEmitter();
      Object.assign(contents, {
        getURL: () => win.url, send: (channel, id) => { win.sent = { channel, id }; },
        setWindowOpenHandler() {},
        session: { setPermissionCheckHandler: cb => { permissionCheck = cb; },
          setPermissionRequestHandler: cb => { permissionRequest = cb; } },
      });
      Object.assign(win, { options, destroyed: false,
        isDestroyed() { return this.destroyed; },
        isMinimized: () => false, show() { this.visible = true; }, hide() { this.visible = false; }, focus() {},
        loadFile: async file => { win.url = pathToFileURL(file).href; },
        destroy() { this.destroyed = true; this.emit("closed"); },
      });
      Object.defineProperty(win, "webContents", { get() {
        if (win.destroyed) throw new TypeError("Object has been destroyed");
        return contents;
      } });
      windows.push(win); return win;
    } },
  };
  return { context, handlers, windows, check: (...args) => permissionCheck(...args), request: (...args) => permissionRequest(...args) };
}

test("camera backend validates senders and frames, and keeps hidden capture alive when preview closes", async t => {
  const h = windowHarness();
  const backend = createCameraBackend(h.context);
  t.after(() => backend.dispose());
  const discovery = backend.listDevices();
  const scanner = h.windows[0];
  h.handlers.get("ready")({ sender: scanner.webContents });
  h.handlers.get("devices")({ sender: scanner.webContents }, [{ deviceId: "test-id", label: "test camera" }]);
  assert.equal((await discovery)[0].deviceId, "test-id");
  let toggles = 0;
  const camera = backend.createCamera({ deviceId: "test-id" }, { onToggle() { toggles++; } });
  const options = { width: 640, height: 480, label: "test camera" };
  camera.setEnabled(true, options);
  const pending = camera.capture(options);
  const win = h.windows[1], event = { sender: win.webContents };
  assert.equal(win.options.show, false);
  assert.equal(win.options.webPreferences.nodeIntegration, false);
  assert.throws(() => h.handlers.get("frame")({ sender: {} }, {}), /来源无效/);
  assert.equal(h.check(win.webContents, "media", "", { mediaType: "video" }), true);
  assert.equal(h.check(scanner.webContents, "media", "", { mediaType: "video" }), true);
  assert.equal(h.check(win.webContents, "media", "", { mediaType: "audio" }), false);
  let allowed;
  h.request(win.webContents, "media", value => { allowed = value; }, { mediaTypes: ["video", "audio"] });
  assert.equal(allowed, false);
  assert.throws(() => h.handlers.get("devices")(event, []), /来源无效/);
  assert.throws(() => h.handlers.get("toggle")({ sender: scanner.webContents }), /不能切换/);
  h.handlers.get("toggle")(event);
  assert.equal(toggles, 1);
  h.handlers.get("ready")(event);
  camera.show(options);
  assert.equal(win.visible, true);
  let prevented = false;
  win.emit("close", { preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(win.visible, false);
  assert.equal(win.destroyed, false);
  const id = win.sent.id;
  h.handlers.get("frame")(event, { id: id - 1, error: "stale" });
  h.handlers.get("frame")(event, { id, data: Uint8Array.from([255, 216, 255, 217]), width: 640, height: 480 });
  assert.ok(Buffer.isBuffer((await pending).data));
  const invalid = camera.capture(options);
  h.handlers.get("frame")(event, { id: win.sent.id, data: Uint8Array.from([0, 0, 0, 0]), width: 640, height: 480 });
  await assert.rejects(invalid, /无效图片/);
  const stopped = camera.capture(options);
  camera.setEnabled(false, options);
  await assert.rejects(stopped, /停止/);
  backend.dispose();
  assert.equal(h.handlers.size, 0);
  assert.equal(win.destroyed, true);
});

test("camera shutdown rejects pending work and releases destroyed windows without reading their webContents", async t => {
  const h = windowHarness();
  const backend = createCameraBackend(h.context);
  t.after(() => backend.dispose());
  const enumeration = assert.rejects(backend.listDevices(), /卸载/);
  const scannerContents = h.windows[0].webContents;
  const cameras = ["front", "rear"].map(deviceId => backend.createCamera({ deviceId }, { onToggle() {} }));
  const pending = cameras.map(camera => {
    camera.setEnabled(true, { width: 640, height: 480 });
    return assert.rejects(camera.capture(), /停止/);
  });
  const contents = h.windows.slice(1).map(win => win.webContents);
  assert.doesNotThrow(() => backend.dispose());
  await Promise.all([enumeration, ...pending]);
  assert.ok(h.windows.every(win => win.isDestroyed()));
  assert.equal(h.handlers.size, 0);
  for (const sender of [scannerContents, ...contents]) {
    assert.equal(h.check(sender, "media", "", { mediaType: "video" }), false);
  }
  assert.doesNotThrow(() => {
    cameras.forEach(camera => { camera.stop(); camera.dispose(); });
    backend.dispose();
  });
});

test("camera renderer crash cancels capture and allows its window to be recreated", async t => {
  const h = windowHarness();
  const backend = createCameraBackend(h.context);
  t.after(() => backend.dispose());
  const camera = backend.createCamera({ deviceId: "front" }, { onToggle() {} });
  camera.setEnabled(true, { width: 640, height: 480 });
  const win = h.windows[0], contents = win.webContents;
  const pending = assert.rejects(camera.capture(), /已关闭/);
  assert.doesNotThrow(() => contents.emit("render-process-gone"));
  await pending;
  assert.ok(win.isDestroyed());
  assert.equal(h.check(contents, "media", "", { mediaType: "video" }), false);
  camera.show();
  assert.equal(h.windows.length, 2);
  assert.equal(h.windows[1].isDestroyed(), false);
  assert.equal(h.windows[1].visible, true);
});

test("renderer accepts immediate consecutive captures, switches streams off and discards a late camera start", async () => {
  const { runInNewContext } = require("node:vm");
  const { readFileSync } = require("node:fs");
  let onCapture, onState, stops = 0, finishStart;
  const frames = [];
  const video = { videoWidth: 640, videoHeight: 480, play: async () => {} };
  const elements = { video, "#status": {}, "#label": {}, "#toggle": { setAttribute() {}, addEventListener() {} } };
  const canvas = { getContext: () => ({ drawImage() {} }),
    toBlob: callback => callback({ arrayBuffer: async () => new ArrayBuffer(4) }) };
  const state = { mode: "capture", enabled: true, options: { width: 640, height: 480, deviceId: "phone-id", label: "手机屏幕" } };
  let starts = 0;
  const makeStream = () => ({ getTracks: () => [{ stop() { stops++; } }],
    getVideoTracks: () => [{ readyState: "live", label: "test" }] });
  runInNewContext(readFileSync(require.resolve("../electron/plugins/cameraPerception/renderer.js"), "utf8"), {
    document: { querySelector: selector => elements[selector], createElement: () => canvas },
    navigator: { mediaDevices: { getUserMedia: async constraints => {
      assert.equal(constraints.audio, false);
      assert.equal(constraints.video.deviceId.exact, "phone-id");
      if (++starts > 1) return new Promise(resolve => { finishStart = () => resolve(makeStream()); });
      return makeStream();
    } } },
    window: { addEventListener() {}, camera: {
      options: async () => state,
      onState: callback => { onState = callback; },
      onCapture: callback => { onCapture = callback; },
      ready: async () => onCapture(1),
      frame: async frame => { frames.push(frame); if (frame.id === 1) await onCapture(2); },
    } },
  });
  await settle();
  assert.deepEqual(frames.map(frame => frame.id), [1, 2]);
  assert.equal(frames[1].error, undefined);
  onState({ ...state, enabled: false });
  assert.equal(stops, 1);
  assert.equal(video.srcObject, null);
  onState(state);
  onState({ ...state, enabled: false });
  finishStart();
  await settle();
  assert.equal(stops, 2);
  assert.equal(video.srcObject, null);
});
