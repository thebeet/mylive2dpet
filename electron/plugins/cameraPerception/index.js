const EVENTS = require("../../architecture/events");
const { getLogGeneration } = require("../../storage/logLifecycle");
const { getOptions } = require("./options");
const { createScreenChangeDetector } = require("../screenPerception/screenChange");

function createCameraPerceptionPlugin(context, dependencies = {}) {
  const sessions = new Map();
  const setTimer = dependencies.setInterval || setInterval;
  const clearTimer = dependencies.clearInterval || clearInterval;
  let running = false, disposed = false, lifecycle = 0, devices = [], enumerationError = "", startup = null;
  const backend = (dependencies.createBackend || require("./cameraWindow").createCameraBackend)(context, {
    onDevices(next) { if (running && !disposed) reconcile(next); },
  });

  function optionsFor(device) {
    const options = getOptions(context.config.get());
    const configured = options.deviceId ? options.deviceId === device.deviceId
      : options.devicePath ? options.devicePath === device.devicePath : devices[0]?.deviceId === device.deviceId;
    return { ...options, deviceId: device.deviceId, devicePath: device.devicePath || "",
      label: configured ? options.label : device.label || "摄像头画面" };
  }
  function sessionFor(device) {
    let session = sessions.get(device.deviceId);
    if (session) { session.device = device; return session; }
    session = { device, enabled: false, generation: 0, pending: null, timer: null,
      detector: dependencies.createDetector?.(device) || createScreenChangeDetector() };
    session.camera = backend.createCamera(device, { onToggle: () => {
      if (disposed || !running) throw new Error("摄像头插件已停止");
      return session.enabled ? disable(session) : enable(session);
    } });
    sessions.set(device.deviceId, session);
    return session;
  }
  function reconcile(next) {
    devices = next;
    enumerationError = "";
    const present = new Set(next.map(device => device.deviceId));
    for (const [id, session] of sessions) if (!present.has(id)) {
      sessions.delete(id);
      void disable(session).finally(() => session.camera.dispose()).catch(report);
    }
    context.menu.refresh();
  }
  function report(error) {
    if (running && !disposed) void context.bus.notify(EVENTS.PIPELINE_FAILED, {
      stage: "perception", source: "camera", trigger: "camera", error,
    });
  }
  async function performCapture(session, request, token) {
    const options = optionsFor(session.device);
    const logGeneration = getLogGeneration(context.storage);
    const captured = await session.camera.capture(options);
    if (disposed || !running || !session.enabled || session.generation !== token || logGeneration !== getLogGeneration(context.storage)) return null;
    const change = session.detector.compareWithPrevious(captured.data, { options: options.changeDetect });
    if (!change.changed) {
      await context.bus.notify(EVENTS.PERCEPTION_SKIPPED, {
        source: "camera", trigger: request.trigger || "camera", reason: "little-change",
        metadata: { ...change, deviceId: session.device.deviceId, label: options.label },
      });
      return null;
    }
    const { data, ...metadata } = captured;
    const saved = context.storage.blobs("screenshots").put(data, {
      ...metadata, source: "camera", label: options.label, deviceId: session.device.deviceId,
      devicePath: options.devicePath, trigger: request.trigger || "camera",
      filename: `camera-${Date.now()}.jpg`, mimeType: "image/jpeg",
    });
    const shot = { ...saved.metadata, id: saved.id, uri: `storage://screenshots/${saved.id}` };
    await context.perception.submit({
      source: "camera", trigger: request.trigger || "camera", capturedAt: shot.capturedAt,
      expiresAt: Date.parse(shot.capturedAt) + options.observationTtlMs,
      content: [{ type: "image", uri: shot.uri, mimeType: "image/jpeg" }],
      metadata: { modality: "camera", label: options.label, deviceId: session.device.deviceId,
        devicePath: options.devicePath, screenshotId: shot.id,
        device: captured.device, width: captured.width, height: captured.height,
        distance: change.distance, threshold: change.threshold },
    }, { maxMatching: options.maxPendingObservations });
    return shot;
  }
  function captureSession(session, request = {}) {
    if (!running || !session?.enabled || disposed) return Promise.reject(new Error("摄像头感知未开启"));
    if (session.pending) return session.pending;
    const task = performCapture(session, request, session.generation);
    session.pending = task;
    void task.finally(() => { if (session.pending === task) session.pending = null; }).catch(() => {});
    return task;
  }
  function periodic(session, trigger = "interval") {
    if (session.pending) return;
    const token = session.generation;
    void captureSession(session, { trigger }).catch(error => {
      if (session.enabled && session.generation === token) report(error);
    });
  }
  function enable(session) {
    if (!running || disposed || session.enabled) return;
    session.enabled = true; session.generation++;
    session.detector.reset();
    const options = optionsFor(session.device);
    session.camera.setEnabled(true, options);
    periodic(session);
    if (options.interval_ms > 0) session.timer = setTimer(() => periodic(session), options.interval_ms);
    context.menu.refresh();
  }
  async function disable(session) {
    session.enabled = false; session.generation++;
    if (session.timer != null) clearTimer(session.timer);
    session.timer = null;
    session.camera.setEnabled(false, optionsFor(session.device));
    const pending = session.pending;
    await context.perception.discard(item => item.source === "camera" && item.metadata?.deviceId === session.device.deviceId, "camera-stopped");
    await pending?.catch(() => {});
    context.menu.refresh();
  }
  async function closeAll() { await Promise.all([...sessions.values()].map(disable)); }
  const unsubscribeClear = context.bus.subscribe(EVENTS.RAW_LOG_CLEARED, () => {
    for (const session of sessions.values()) session.detector.reset();
  }, { allowWhileStopped: true });
  const unregisterSource = context.perception.registerSource("camera", async (request = {}) => {
    if (startup) await startup;
    const session = request.deviceId ? sessions.get(request.deviceId)
      : [...sessions.values()].find(item => item.enabled && (!request.devicePath || item.device.devicePath === request.devicePath));
    return captureSession(session, request);
  });
  const unregisterMenu = context.menu.register(() => {
    const sorted = [...devices].sort((a, b) => Number(Boolean(sessions.get(b.deviceId)?.enabled)) - Number(Boolean(sessions.get(a.deviceId)?.enabled)));
    const submenu = sorted.map(device => {
      const enabled = Boolean(sessions.get(device.deviceId)?.enabled);
      const options = optionsFor(device);
      const name = options.label === "摄像头画面" ? device.label || options.label : options.label;
      return { label: `${enabled ? "● " : ""}${name}${device.devicePath ? ` (${device.devicePath})` : ""}`,
        enabled: running && !disposed, click: () => sessionFor(device).camera.show(optionsFor(device)) };
    });
    if (!submenu.length) submenu.push({ label: enumerationError || (startup ? "正在枚举摄像头…" : "未发现摄像头设备"), enabled: false });
    if ([...sessions.values()].some(session => session.enabled)) submenu.push({ type: "separator" }, {
      label: "关闭所有", enabled: running && !disposed, click: closeAll,
    });
    return [{ label: "摄像头感知", submenu }];
  });

  return {
    start() {
      if (disposed || running) return startup;
      running = true;
      const token = ++lifecycle;
      startup = Promise.resolve().then(() => backend.listDevices()).then(next => {
        if (!running || disposed || token !== lifecycle) return;
        reconcile(next);
        const options = getOptions(context.config.get());
        if (options.enabled) {
          const device = options.deviceId ? devices.find(item => item.deviceId === options.deviceId)
            : options.devicePath ? devices.find(item => item.devicePath === options.devicePath) : devices[0];
          if (device) enable(sessionFor(device));
          else if (options.deviceId || options.devicePath) report(new Error("配置的摄像头设备不可用"));
        }
      }).catch(error => { enumerationError = error.message; report(error); }).finally(() => {
        if (token === lifecycle) { startup = null; context.menu.refresh(); }
      });
      context.menu.refresh();
      return startup;
    },
    async stop() {
      running = false; lifecycle++;
      await closeAll();
      for (const session of sessions.values()) session.camera.stop();
    },
    async dispose() {
      if (disposed) return;
      disposed = true; running = false; lifecycle++;
      unregisterSource(); unregisterMenu(); unsubscribeClear();
      // Cancel capture IPC before waiting for in-flight work.
      backend.dispose();
      await closeAll();
      for (const session of sessions.values()) session.camera.dispose();
      sessions.clear();
    },
  };
}
function activate(context) {
  const unregisterPrompt = context.systemPrompt.register({
    text: "source=camera 的图片来自视频采集设备；根据 metadata.label 区分用途。标记为‘手机屏幕’的画面是手机屏幕内容，不是现实环境或电脑桌面。其他摄像头画面按其标签理解。仅描述可见内容，不猜测人物身份或不可见活动；工作摘要只使用画面中明确可见的工作信息。",
  });
  const plugin = createCameraPerceptionPlugin(context);
  return { ...plugin, async dispose() { unregisterPrompt(); await plugin.dispose(); } };
}
module.exports = { activate, createCameraPerceptionPlugin };
