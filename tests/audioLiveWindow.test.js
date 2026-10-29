const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { MessageBus } = require("../electron/architecture/messageBus");
const EVENTS = require("../electron/architecture/events");
const { createLiveWindow } = require("../electron/plugins/audioOutputPerception/liveWindow");
const { registerAudioOutputPerceptionPlugin } = require("../electron/plugins/audioOutputPerception");

const settle = () => new Promise((resolve) => setImmediate(resolve));
function windowServices() {
  const windows = [];
  const handlers = new Map();
  let menu;
  const dependencies = {
    logger: { info() {}, warn() {}, error() {} },
    screen: { getPrimaryDisplay: () => ({ workArea: { x: -1280, y: 40, width: 1280, height: 720 } }) },
    ipc: { handle: (channel, handler) => { handlers.set(channel, handler); return () => handlers.delete(channel); } },
    menu: { register: (provide) => { menu = provide; return () => { menu = null; }; }, refresh() {} },
    windows: { create(options) {
      const win = new EventEmitter();
      const webContents = new EventEmitter();
      Object.assign(webContents, { messages: [], isDestroyed: () => win.destroyed,
        send: (_channel, payload) => webContents.messages.push(structuredClone(payload)) });
      Object.assign(win, { options, webContents, destroyed: false, shows: 0,
        isDestroyed() { return this.destroyed; }, showInactive() { this.shows++; },
        destroy() { this.destroyed = true; this.emit("closed"); }, loadFile: async () => {},
      });
      windows.push(win);
      return win;
    } },
  };
  return { dependencies, windows, handlers, menu: () => menu()[0].submenu };
}

test("live window opens at the top right and keeps a bounded transcript feed", (t) => {
  const h = windowServices();
  const live = createLiveWindow(h.dependencies);
  t.after(() => live.dispose());
  for (let i = 0; i < 25; i++) live.addTranscript({ text: `line ${i}`, capturedAt: "2026-10-27T00:00:00Z" });
  live.setEnabled(true);
  live.setEnabled(true);
  assert.equal(h.windows.length, 1);
  const win = h.windows[0];
  assert.equal(win.options.x, -376);
  assert.equal(win.options.y, 56);
  assert.equal(win.options.width, 360);
  assert.equal(win.options.alwaysOnTop, true);
  assert.equal(win.options.focusable, false);
  win.emit("ready-to-show");
  win.webContents.emit("did-finish-load");
  assert.equal(win.shows, 1);
  const snapshot = win.webContents.messages.at(-1);
  assert.equal(snapshot.entries.length, 20);
  assert.equal(snapshot.entries[0].text, "line 5");
  assert.equal(snapshot.entries.at(-1).text, "line 24");
  live.setState({ status: "error", error: "ASR unavailable" });
  assert.equal(win.webContents.messages.at(-1).state.error, "ASR unavailable");
  assert.throws(() => h.handlers.get("hide-live-content")({ sender: {} }), /来源无效/);
  h.handlers.get("hide-live-content")({ sender: win.webContents });
  assert.equal(live.isEnabled(), false);
  assert.equal(win.destroyed, true);
});

test("stop closes the live window and clears content, including late window readiness", () => {
  const h = windowServices();
  const live = createLiveWindow(h.dependencies);
  live.setEnabled(true);
  const old = h.windows[0];
  live.addTranscript({ text: "previous session", capturedAt: "2026-10-27T00:00:00Z" });
  live.stop();
  old.emit("ready-to-show");
  assert.equal(old.shows, 0);
  live.setEnabled(true);
  const current = h.windows[1];
  current.webContents.emit("did-finish-load");
  assert.deepEqual(current.webContents.messages.at(-1).entries, []);
  live.dispose();
  assert.equal(current.destroyed, true);
  assert.equal(h.handlers.size, 0);
  live.setEnabled(true);
  assert.equal(h.windows.length, 2);
});

test("audio menu streams ASR results immediately even when repeated observations are deduplicated", async (t) => {
  const h = windowServices();
  const bus = new MessageBus();
  let captureHandlers;
  const plugin = registerAudioOutputPerceptionPlugin(bus, {
    ...h.dependencies, platform: "linux", loadConfig: () => ({ plugins: [{ name: "audio-output-perception",
      enabled: true, asr: { endpoint: "https://asr.example/v1", model: "test" } }] }),
    resolveSource: async () => "output.monitor",
    capture: (_source, _options, handlers) => { captureHandlers = handlers; return { stop() {} }; },
    transcribe: async () => ({ text: "正在讨论实时语音显示", language: "zh" }),
  });
  t.after(() => plugin.dispose());
  await plugin.start();
  const display = () => h.menu().find(({ label }) => label === "实时显示内容");
  display().submenu[0].click();
  const win = h.windows[0];
  win.webContents.emit("did-finish-load");
  assert.equal(display().submenu[0].checked, true);
  assert.equal(win.webContents.messages.at(-1).state.status, "listening");
  const utterance = Buffer.alloc(1600 * 32);
  for (let offset = 0; offset < 600 * 32; offset += 2) utterance.writeInt16LE(4000, offset);
  for (let i = 0; i < 2; i++) { captureHandlers.onData(utterance); await settle(); }
  assert.equal(win.webContents.messages.at(-1).entries.length, 2);
  assert.equal(win.webContents.messages.at(-1).entries[0].text, "正在讨论实时语音显示");
  assert.equal(bus.queueSize(EVENTS.PERCEPTION_OBSERVATION), 1);
  display().submenu[1].click();
  assert.equal(win.destroyed, true);
  assert.equal(plugin.getState().enabled, true);
  assert.equal(display().submenu[0].checked, false);
  display().submenu[0].click();
  await plugin.stop();
  assert.equal(h.windows[1].destroyed, true);
});

test('2-pass interim text updates one subtitle, final correction replaces it, and cancellation removes it', t => {
  const h = windowServices();
  const live = createLiveWindow(h.dependencies);
  t.after(() => live.dispose());
  live.setEnabled(true);
  const win = h.windows[0];
  live.addTranscript({ id: 'utterance', text: '天气', final: false });
  live.addTranscript({ id: 'utterance', text: '天气好', final: false });
  assert.equal(win.webContents.messages.at(-1).entries.length, 1);
  assert.equal(win.webContents.messages.at(-1).entries[0].text, '天气好');
  live.addTranscript({ id: 'utterance', text: '天气很好。', final: true });
  assert.deepEqual(win.webContents.messages.at(-1).entries, [{ id: 'utterance', text: '天气很好。', final: true }]);
  live.addTranscript({ id: 'interrupted', text: '尚未完成', final: false });
  live.removeTranscript('interrupted');
  assert.equal(win.webContents.messages.at(-1).entries.length, 1);
});
