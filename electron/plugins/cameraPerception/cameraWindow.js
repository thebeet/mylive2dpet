const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");

function devicePaths(devices) {
  if (process.platform !== "linux") return devices;
  let paths = [];
  try {
    paths = fs.readdirSync("/sys/class/video4linux").filter(name => /^video\d+$/.test(name)).map(name => ({
      devicePath: `/dev/${name}`, name: fs.readFileSync(`/sys/class/video4linux/${name}/name`, "utf8").trim(),
    }));
  } catch { /* Chromium enumeration remains available without sysfs. */ }
  return devices.map(device => {
    const matches = paths.filter(item => device.label === item.name || device.label.startsWith(`${item.name} (`));
    const sameName = devices.filter(item => item.label === device.label);
    return { ...device, devicePath: matches.length === 1 && sameName.length === 1 ? matches[0].devicePath : "" };
  });
}

/** Hidden capture windows keep streams alive independently of preview visibility. */
function createCameraBackend(context, { onDevices = () => {} } = {}) {
  const records = new Map();
  const page = path.join(__dirname, "window.html");
  const pageUrl = pathToFileURL(page).href;
  let discovery = null, devices = [], disposed = false, sequence = 0;
  let enumeration = null;

  function recordFor(event) {
    const record = records.get(event.sender);
    if (disposed || !record || record.win.isDestroyed() || event.sender.getURL() !== pageUrl ||
        (event.senderFrame && event.senderFrame !== event.sender.mainFrame)) throw new Error("摄像头请求来源无效");
    return record;
  }
  function finish(record, error, value) {
    const request = record.request;
    if (!request) return;
    record.request = null;
    clearTimeout(request.timer);
    if (error) request.reject(error); else request.resolve(value);
  }
  function sendState(record) {
    if (record.ready) record.win.webContents.send("camera-perception:state", record.state);
  }
  function sendCapture(record) {
    if (record.ready && record.request) record.win.webContents.send("camera-perception:capture", record.request.id);
  }
  const removers = [
    context.ipc.handle("options", event => recordFor(event).state),
    context.ipc.handle("ready", event => {
      const record = recordFor(event);
      record.ready = true; sendState(record); sendCapture(record);
    }),
    context.ipc.handle("devices", (event, input) => {
      const record = recordFor(event);
      if (record !== discovery) throw new Error("设备枚举请求来源无效");
      if (!Array.isArray(input) || input.length > 100 || input.some(device =>
        !device || typeof device.deviceId !== "string" || !device.deviceId || device.deviceId.length > 256 ||
        typeof device.label !== "string" || device.label.length > 500)) throw new Error("无效的摄像头设备列表");
      devices = devicePaths(input.map(({ deviceId, label }) => ({ deviceId, label })));
      if (enumeration) { clearTimeout(enumeration.timer); enumeration.resolve(devices); enumeration = null; }
      onDevices(devices);
    }),
    context.ipc.handle("toggle", event => {
      const record = recordFor(event);
      if (record === discovery) throw new Error("设备枚举窗口不能切换感知");
      return record.onToggle();
    }),
    context.ipc.handle("frame", (event, frame) => {
      const record = recordFor(event);
      if (!record.request || frame?.id !== record.request.id) return;
      if (frame.error) { finish(record, new Error(String(frame.error).slice(0, 500))); return; }
      const options = record.state.options;
      if (!(frame.data instanceof Uint8Array) || frame.data.length < 4 || frame.data.length > 8 * 1024 * 1024 ||
          frame.data[0] !== 0xff || frame.data[1] !== 0xd8 ||
          !Number.isInteger(frame.width) || frame.width < 1 || frame.width > options.width ||
          !Number.isInteger(frame.height) || frame.height < 1 || frame.height > options.height) {
        finish(record, new Error("摄像头返回了无效图片")); return;
      }
      finish(record, null, { data: Buffer.from(frame.data), width: frame.width, height: frame.height,
        capturedAt: new Date().toISOString(), device: String(frame.device || "").slice(0, 200) });
    }),
  ];

  function createRecord(state, onToggle) {
    if (disposed) throw new Error("摄像头插件已卸载");
    const win = context.windows.create({
      width: 460, height: 440, title: `${state.options?.label || "摄像头感知"} · 预览`, show: false,
      autoHideMenuBar: true, backgroundColor: "#11131a",
      webPreferences: { preload: path.join(__dirname, "preload.js"), partition: "camera-perception",
        contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
    });
    const record = { win, state, onToggle, ready: false, request: null };
    records.set(win.webContents, record);
    const valid = contents => records.has(contents) && contents.getURL() === pageUrl;
    const session = win.webContents.session;
    session.setPermissionCheckHandler((contents, permission, _origin, details) =>
      valid(contents) && permission === "media" && details.mediaType === "video");
    session.setPermissionRequestHandler((contents, permission, callback, details) =>
      callback(valid(contents) && permission === "media" && details.mediaTypes?.length === 1 && details.mediaTypes[0] === "video"));
    win.on("close", event => { event.preventDefault(); win.hide(); });
    win.webContents.on("will-navigate", event => event.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("render-process-gone", () => { if (!win.isDestroyed()) win.destroy(); });
    win.once("closed", () => {
      records.delete(win.webContents);
      finish(record, new Error("摄像头采集窗口已关闭"));
      if (discovery === record) discovery = null;
    });
    void win.loadFile(page).catch(error => { finish(record, error); if (!win.isDestroyed()) win.destroy(); });
    return record;
  }
  function destroy(record) {
    if (!record) return;
    finish(record, new Error("摄像头采集已停止"));
    if (!record.win.isDestroyed()) record.win.destroy();
  }

  return {
    listDevices() {
      if (disposed) return Promise.reject(new Error("摄像头插件已卸载"));
      if (enumeration) return enumeration.promise;
      if (discovery?.ready) return Promise.resolve(devices);
      const promise = new Promise((resolve, reject) => {
        enumeration = { resolve, reject, timer: setTimeout(() => {
          enumeration = null; reject(new Error("摄像头设备枚举超时"));
        }, 15000) };
      });
      enumeration.promise = promise;
      try { if (!discovery) discovery = createRecord({ mode: "discovery" }); }
      catch (error) { clearTimeout(enumeration.timer); enumeration = null; return Promise.reject(error); }
      return promise;
    },
    createCamera(device, { onToggle }) {
      let record = null, state = { mode: "capture", enabled: false, options: null };
      function ensure() {
        if (!record || record.win.isDestroyed()) record = createRecord(state, onToggle);
        return record;
      }
      return {
        setEnabled(enabled, options) {
          state = { mode: "capture", enabled, options: { ...options, deviceId: device.deviceId, devicePath: device.devicePath || "" } };
          if (enabled) ensure();
          if (record && !record.win.isDestroyed()) {
            record.state = state;
            if (!enabled) finish(record, new Error("摄像头采集已停止"));
            sendState(record);
          }
        },
        capture(options) {
          if (!state.enabled) return Promise.reject(new Error("摄像头感知未开启"));
          const current = ensure();
          if (current.request) return Promise.reject(new Error("摄像头正在采集"));
          return new Promise((resolve, reject) => {
            current.request = { id: ++sequence, resolve, reject,
              timer: setTimeout(() => finish(current, new Error("摄像头采集超时，请检查设备或系统权限")), 15000) };
            sendCapture(current);
          });
        },
        show(options) {
          if (!state.options) state = { ...state, options: { ...options, deviceId: device.deviceId } };
          const current = ensure();
          if (current.win.isMinimized()) current.win.restore();
          current.win.show(); current.win.focus();
        },
        stop() { state = { ...state, enabled: false }; destroy(record); record = null; },
        dispose() { this.stop(); },
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (enumeration) { clearTimeout(enumeration.timer); enumeration.reject(new Error("摄像头插件已卸载")); enumeration = null; }
      for (const record of [...records.values()]) destroy(record);
      for (const remove of removers) remove();
    },
  };
}
module.exports = { createCameraBackend };
