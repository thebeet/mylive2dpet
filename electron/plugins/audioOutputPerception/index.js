const EVENTS = require("../../architecture/events");
const { createPerceptionService } = require("../../architecture/perceptionService");
const { getAudioOutputOptions } = require("./options");
const { listAudioSources } = require("./capture/linux");
const { createAudioSourceSession } = require("./sourceSession");
const { createLiveWindow } = require("./liveWindow");

function registerAudioOutputPerceptionPlugin(bus, dependencies = {}) {
  const readConfig = dependencies.loadConfig || (() => ({}));
  const platform = dependencies.platform || process.platform;
  const logger = dependencies.logger || console;
  const perception = dependencies.perception || createPerceptionService(bus);
  const enumerate = dependencies.listSources || listAudioSources;
  const live = createLiveWindow({ ...dependencies, logger });
  const sessions = new Map();
  const speechState = { playbacks: new Set(), suppressedUntil: 0 };
  let options = getAudioOutputOptions(readConfig());
  let devices = [], running = false, disposed = false, lifecycle = 0, startup = null, error = "";
  const idFor = device => `${device.type}:${device.source}`;

  function getState() {
    const sources = devices.map(device => {
      const state = sessions.get(idFor(device))?.getState() || { enabled: false, status: "disabled", error: "" };
      return { ...device, ...state, source: device.source, resolvedSource: state.source || "", sourceId: idFor(device) };
    });
    const active = sources.filter(source => source.enabled);
    const failure = sources.find(source => source.status === "error");
    const status = error || failure ? "error" : active.some(source => source.status === "listening") ? "listening"
      : active.some(source => source.status === "starting") || startup ? "starting"
      : active.length ? "suppressed" : "disabled";
    return { enabled: active.length > 0, status, error: error || failure?.error || "",
      source: active.length === 1 ? active[0].resolvedSource : "", sources };
  }

  function refresh() {
    live.setState(getState());
    dependencies.menu?.refresh?.();
  }

  function report(cause) {
    error = cause.message || String(cause);
    refresh();
    void bus.notify(EVENTS.PIPELINE_FAILED, { stage: "audio-perception", trigger: "audio-output", error: cause });
  }

  function configurationFor(device) {
    return options.sources.find(item => item.type === device.type && item.source === device.source)
      || options.sources.find(item => item.type === device.type && item.source === "default" && device.isDefault);
  }

  function sessionFor(device) {
    const sourceId = idFor(device);
    if (sessions.has(sourceId)) return sessions.get(sourceId);
    const configured = configurationFor(device);
    const label = configured?.label || device.label;
    const session = createAudioSourceSession(bus, { ...options, ...device, label, sourceId }, {
      ...dependencies, perception, speechState, onState: refresh,
      liveWindow: {
        setState() {}, stop() { live.removeSource(sourceId); }, dispose() {},
        addTranscript(entry) { live.addTranscript({ ...entry, sourceId, label }); },
        removeTranscript(id) { live.removeTranscript(id); },
      },
    });
    sessions.set(sourceId, session);
    return session;
  }

  async function enableSource(sourceId) {
    if (!running || disposed) return;
    const device = devices.find(item => idFor(item) === sourceId);
    if (device) await sessionFor(device).start({ enabled: true });
    refresh();
  }

  function disableSource(sourceId) {
    const done = sessions.get(sourceId)?.stop();
    refresh();
    return done;
  }

  function closeAll() {
    const pending = [...sessions.values()].map(session => session.stop());
    // Includes observations from the previous single-source implementation.
    pending.push(perception.discard(item => item.source === "audio-output", "source-stopped"));
    live.stop();
    refresh();
    return Promise.allSettled(pending);
  }

  async function discover(token) {
    const next = [...await enumerate()];
    if (!running || disposed || lifecycle !== token) return;
    // Keep missing configured sources visible so their error can be inspected and retried.
    for (const configured of options.sources) {
      if (!next.some(device => device.type === configured.type &&
        (configured.source === "default" ? device.isDefault : device.source === configured.source))) {
        next.push({ ...configured, label: configured.label || configured.source, unavailable: true });
      }
    }
    const present = new Set(next.filter(device => !device.unavailable).map(idFor));
    for (const [id, session] of sessions) if (!present.has(id)) {
      sessions.delete(id);
      void session.dispose();
    }
    devices = next;
    error = "";
    refresh();
  }

  const unsubscribeTts = bus.subscribe(EVENTS.SPEECH_OUTPUT_STATE, ({ playbackId, state }) => {
    if (state === "start") speechState.playbacks.add(playbackId);
    else if (!speechState.playbacks.delete(playbackId)) return;
    speechState.suppressedUntil = Date.now() + options.ttsCooldownMs;
    for (const session of sessions.values()) session.suppress();
  }, { allowWhileStopped: true });

  const plugin = {
    start({ enabled } = {}) {
      if (disposed || running) return startup;
      running = true;
      const token = ++lifecycle;
      startup = Promise.resolve().then(async () => {
        if (!running || disposed || lifecycle !== token) return;
        options = getAudioOutputOptions(readConfig());
        if (platform !== "linux") throw new Error("声音感知目前支持 Linux PipeWire/PulseAudio");
        await discover(token);
        if (!running || disposed || lifecycle !== token || !(enabled ?? options.enabled)) return;
        await Promise.all(devices.filter(device => configurationFor(device)?.enabled)
          .map(device => enableSource(idFor(device))));
      }).catch(cause => { if (running && !disposed && lifecycle === token) report(cause); }).finally(() => {
        if (lifecycle === token) { startup = null; refresh(); }
      });
      refresh();
      return startup;
    },
    stop() { running = false; lifecycle++; startup = null; error = ""; return closeAll(); },
    getState, enableSource, disableSource, closeAll,
    async refreshSources() {
      if (!running || disposed || platform !== "linux") return;
      const token = lifecycle;
      try { await discover(token); }
      catch (cause) { if (running && lifecycle === token) report(cause); }
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      const done = plugin.stop();
      unsubscribeTts(); unregisterMenu(); live.dispose();
      const disposing = [...sessions.values()].map(session => session.dispose());
      sessions.clear(); speechState.playbacks.clear();
      await Promise.allSettled([done, ...disposing]);
    },
  };

  const unregisterMenu = dependencies.menu?.register?.(() => {
    const sorted = [...devices].sort((a, b) => Number(Boolean(sessions.get(idFor(b))?.getState().enabled))
      - Number(Boolean(sessions.get(idFor(a))?.getState().enabled)));
    const submenu = sorted.map(device => {
      const sourceId = idFor(device);
      const state = sessions.get(sourceId)?.getState() || { enabled: false, status: "disabled" };
      const label = configurationFor(device)?.label || device.label;
      return { label: `${state.enabled ? "● " : ""}${device.type === "output" ? "电脑播放" : "麦克风"}：${label}`,
        enabled: running && !disposed,
        submenu: [
          { label: "开启", type: "radio", checked: state.enabled, click: () => enableSource(sourceId) },
          { label: "关闭", type: "radio", checked: !state.enabled, click: () => disableSource(sourceId) },
          { type: "separator" }, { label: device.unavailable && state.status !== "error" ? "设备不可用" : audioStatusLabel(state), enabled: false },
        ] };
    });
    if (!submenu.length || error) submenu.push({ label: error || (startup ? "正在枚举声音源…" : "未发现声音源"), enabled: false });
    submenu.push({ type: "separator" },
      { label: "刷新声音源", enabled: running && platform === "linux", click: plugin.refreshSources },
      { label: "实时显示内容", submenu: [
        { label: "开启", type: "radio", checked: live.isEnabled(), click: () => live.setEnabled(true) },
        { label: "关闭", type: "radio", checked: !live.isEnabled(), click: () => live.setEnabled(false) },
      ] });
    if (getState().enabled) submenu.push({ type: "separator" }, { label: "关闭所有", click: closeAll });
    return [{ label: "声音感知", enabled: platform === "linux", submenu }];
  }) || (() => {});

  return plugin;
}

function activate(context) {
  const unregisterPrompt = context.systemPrompt.register(require("./prompt").promptExtension);
  const plugin = registerAudioOutputPerceptionPlugin(context.bus, {
    loadConfig: () => context.config.get(), platform: context.platform, menu: context.menu,
    logger: context.logger, perception: context.perception, windows: context.windows, screen: context.screen, ipc: context.ipc,
  });
  return { ...plugin, dispose() { unregisterPrompt(); return plugin.dispose(); } };
}

function audioStatusLabel(state) {
  if (state.status === "error") return state.error || "采集异常";
  return { disabled: "未开启", starting: "启动中", listening: "监听中", suppressed: "等待桌宠语音结束" }[state.status] || state.status;
}

module.exports = { activate, registerAudioOutputPerceptionPlugin };
