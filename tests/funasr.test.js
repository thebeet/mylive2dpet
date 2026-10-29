const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { WebSocketServer } = require('ws');
const { createFunAsrStream } = require('../electron/plugins/audioOutputPerception/funasr');
const { getAudioOutputOptions } = require('../electron/plugins/audioOutputPerception/options');
const { AudioSegmenter } = require('../electron/plugins/audioOutputPerception/segmenter');
const { registerAudioOutputPerceptionPlugin } = require('../electron/plugins/audioOutputPerception');
const { MessageBus } = require('../electron/architecture/messageBus');
const EVENTS = require('../electron/architecture/events');
const settle = () => new Promise(resolve => setImmediate(resolve));
const options = () => getAudioOutputOptions({ plugins: [{ name: 'audio-output-perception',
  asr: { provider: 'funasr', endpoint: 'ws://127.0.0.1:10096', timeoutMs: 1000, language: 'zh' } }] }).asr;
function pcm(ms, amplitude = 4000) {
  const data = Buffer.alloc(ms * 32);
  for (let i = 0; i < data.length; i += 2) data.writeInt16LE(amplitude, i);
  return data;
}
class Socket extends EventEmitter {
  constructor() { super(); this.sent = []; this.bufferedAmount = 0; this.closed = false; }
  send(data, callback) { this.sent.push(typeof data === 'string' ? JSON.parse(data) : Buffer.from(data)); callback?.(); }
  terminate() { this.closed = true; this.emit('close'); }
  message(data) { this.emit('message', Buffer.from(JSON.stringify(data))); }
}
function streamHarness(overrides = {}) {
  const socket = new Socket();
  const partials = [];
  const stream = createFunAsrStream({ ...options(), ...overrides }, {
    socketFactory: () => socket, onPartial: p => partials.push(p),
  });
  return { socket, stream, partials };
}

test('2-pass WebSocket sends ordered PCM before end, replaces online deltas, and retains multiple corrected sentences', async t => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  let header;
  const audio = [];
  let resolveAudio;
  const receivedAudio = new Promise(resolve => { resolveAudio = resolve; });
  server.on('connection', socket => socket.on('message', (data, binary) => {
    if (binary) {
      audio.push(Buffer.from(data));
      if (audio.length === 1) {
        socket.send(JSON.stringify({ mode: '2pass-online', text: '天气', wav_name: header.wav_name }));
        socket.send(JSON.stringify({ mode: '2pass-online', text: '好', wav_name: header.wav_name }));
        socket.send(JSON.stringify({ mode: '2pass-offline', text: '天气很好。', is_final: false }));
        resolveAudio();
      }
    } else {
      const message = JSON.parse(data);
      if (message.mode) header = message;
      else {
        assert.equal(message.is_speaking, false);
        socket.send(JSON.stringify({ mode: '2pass-online', text: '剩余', is_final: true }));
        socket.send(JSON.stringify({ mode: '2pass-offline', text: '适合散步。', is_final: true }));
      }
    }
  }));
  const partials = [];
  const stream = createFunAsrStream({ ...options(), endpoint: `ws://127.0.0.1:${server.address().port}` },
    { onPartial: p => partials.push(p.text) });
  t.after(() => stream.cancel());
  const input = pcm(215);
  stream.push(input);
  await receivedAudio;
  assert.equal(header.mode, '2pass');
  assert.equal(header.wav_format, 'pcm');
  assert.equal(header.audio_fs, 16000);
  assert.deepEqual(header.chunk_size, [5, 10, 5]);
  const result = await stream.finish();
  assert.deepEqual(Buffer.concat(audio), input);
  assert.equal(audio[0].length, 60 * 32);
  assert.equal(result.text, '天气很好。适合散步。');
  assert.deepEqual(partials.slice(0, 3), ['天气', '天气好', '天气很好。']);
});

test('an empty final acknowledgement retains corrected text; an online final cannot complete recognition', async () => {
  const h = streamHarness();
  h.socket.emit('open');
  h.socket.message({ mode: '2pass-offline', text: '已修正。', is_final: false });
  h.stream.finish();
  h.socket.message({ mode: '2pass-online', text: '错误', is_final: true });
  assert.equal(h.socket.closed, false);
  h.socket.message({ text: '', is_final: true });
  assert.equal((await h.stream.result).text, '已修正。');
});

test('handshake/final timeouts, malformed responses, early closure and send backpressure fail safely', async () => {
  for (const trigger of ['handshake', 'final', 'malformed', 'close', 'backpressure']) {
    const h = streamHarness({ timeoutMs: 15 });
    if (trigger !== 'handshake') h.socket.emit('open');
    if (trigger === 'final') h.stream.finish();
    if (trigger === 'malformed') h.socket.emit('message', Buffer.from('{'));
    if (trigger === 'close') h.socket.emit('close');
    if (trigger === 'backpressure') { h.socket.bufferedAmount = 2 * 1024 * 1024; h.stream.push(pcm(100)); }
    await assert.rejects(h.stream.result);
    assert.equal(h.socket.closed, true);
  }
});

test('segmenter streams accepted speech before silence and preserves odd-byte chunks without duplicating pre-roll', () => {
  const config = getAudioOutputOptions();
  const audio = Buffer.concat([pcm(300, 0), pcm(600), pcm(800, 0)]);
  const chunks = [];
  const final = [];
  let started = 0;
  let canceled = 0;
  const segmenter = new AudioSegmenter(config, s => final.push(s), {
    onStart() { started++; }, onAudio: chunk => chunks.push(chunk), onCancel() { canceled++; },
  });
  segmenter.push(pcm(100));
  segmenter.reset();
  assert.equal(started, 0);
  for (let i = 0; i < audio.length; i += 333) segmenter.push(audio.subarray(i, i + 333));
  assert.equal(started, 1);
  assert.equal(final.length, 1);
  assert.deepEqual(Buffer.concat(chunks), final[0].pcm);
  segmenter.push(pcm(400));
  assert.equal(started, 2);
  segmenter.reset();
  assert.equal(canceled, 1);
});

function pluginHarness(overrides = {}) {
  const sockets = [];
  const captures = [];
  const bus = new MessageBus();
  const plugin = registerAudioOutputPerceptionPlugin(bus, {
    loadConfig: () => ({ plugins: [{ name: 'audio-output-perception', enabled: true,
      ttsCooldownMs: 100, asr: options() }] }),
    logger: { info() {}, warn() {}, error() {} }, platform: 'linux',
    resolveSource: async () => 'output.monitor',
    capture: (_source, _options, handlers) => { captures.push(handlers); return { stop() {} }; },
    socketFactory: () => { const socket = new Socket(); sockets.push(socket); return socket; },
    ...overrides,
  });
  return { sockets, captures, bus, plugin };
}

test('plugin sends live audio before endpointing; only final corrected text enters observations, with deduplication', async t => {
  const h = pluginHarness();
  t.after(() => h.plugin.dispose());
  await h.plugin.start();
  for (let i = 0; i < 2; i++) {
    h.captures[0].onData(pcm(600));
    const socket = h.sockets[i];
    socket.emit('open');
    assert.ok(socket.sent.some(Buffer.isBuffer));
    assert.equal(socket.sent.some(m => m.is_speaking === false), false);
    socket.message({ mode: '2pass-online', text: '不稳定' });
    assert.equal(h.bus.queueSize(EVENTS.PERCEPTION_OBSERVATION), i);
    h.captures[0].onData(pcm(800, 0));
    socket.message({ mode: '2pass-offline', text: '最终结果。', is_final: true });
    await settle();
  }
  const observations = h.bus.takeAll(EVENTS.PERCEPTION_OBSERVATION);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].content[0].text, '最终结果。');
});

test('TTS cancels both live speech and pending finalization; stop/restart rejects stale responses', async t => {
  const h = pluginHarness();
  t.after(() => h.plugin.dispose());
  await h.plugin.start();
  h.captures[0].onData(pcm(600));
  h.captures[0].onData(pcm(800, 0));
  h.captures[0].onData(pcm(600));
  assert.equal(h.sockets.length, 2);
  await h.bus.publish(EVENTS.SPEECH_OUTPUT_STATE, { playbackId: 1, state: 'start' });
  assert.ok(h.sockets.every(s => s.closed));
  for (const s of h.sockets) s.message({ mode: '2pass-offline', text: '旧文字', is_final: true });
  await h.plugin.stop();
  await h.bus.publish(EVENTS.SPEECH_OUTPUT_STATE, { playbackId: 1, state: 'end' });
  await new Promise(resolve => setTimeout(resolve, 110));
  await h.plugin.start();
  h.captures[1].onData(pcm(600));
  const fresh = h.sockets[2];
  fresh.emit('open');
  h.captures[1].onData(pcm(800, 0));
  fresh.message({ mode: '2pass-offline', text: '新内容', is_final: true });
  await settle();
  assert.deepEqual(h.bus.takeAll(EVENTS.PERCEPTION_OBSERVATION).map(o => o.content[0].text), ['新内容']);
});

test('slow finalization bounds concurrent streams and a failed service recovers on the next utterance', async t => {
  const h = pluginHarness();
  t.after(() => h.plugin.dispose());
  await h.plugin.start();
  for (let i = 0; i < 5; i++) {
    h.captures[0].onData(pcm(600));
    h.sockets[i].emit('open');
    h.captures[0].onData(pcm(800, 0));
  }
  assert.equal(h.sockets.filter(s => !s.closed).length, 3);
  h.sockets[4].emit('error', new Error('unavailable'));
  await settle();
  assert.equal(h.plugin.getState().status, 'error');
  h.captures[0].onData(pcm(600));
  h.sockets[5].emit('open');
  h.captures[0].onData(pcm(800, 0));
  h.sockets[5].message({ mode: '2pass-offline', text: '服务恢复', is_final: true });
  await settle();
  assert.equal(h.plugin.getState().status, 'listening');
});

test('TTS during asynchronous observation preparation blocks the canceled final without suppressing a later identical utterance', async t => {
  let unblock;
  let first = true;
  const submitted = [];
  const h = pluginHarness({ perception: {
    discard() { if (first) { first = false; return new Promise(resolve => { unblock = resolve; }); } },
    async submit(observation) { submitted.push(observation); },
  } });
  t.after(() => h.plugin.dispose());
  await h.plugin.start();
  h.captures[0].onData(pcm(600));
  h.sockets[0].emit('open');
  h.captures[0].onData(pcm(800, 0));
  h.sockets[0].message({ mode: '2pass-offline', text: '同一句话', is_final: true });
  await settle();
  await h.bus.publish(EVENTS.SPEECH_OUTPUT_STATE, { playbackId: 1, state: 'start' });
  unblock();
  await settle();
  assert.equal(submitted.length, 0);
  await h.bus.publish(EVENTS.SPEECH_OUTPUT_STATE, { playbackId: 1, state: 'end' });
  await new Promise(resolve => setTimeout(resolve, 110));
  h.captures[0].onData(pcm(600));
  h.sockets[1].emit('open');
  h.captures[0].onData(pcm(800, 0));
  h.sockets[1].message({ mode: '2pass-offline', text: '同一句话', is_final: true });
  await settle();
  assert.equal(submitted.length, 1);
});

test('connection refusal explains service readiness for direct and aggregate socket errors', async () => {
  for (const error of [Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    new AggregateError([Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })])]) {
    const h = streamHarness();
    h.socket.emit('error', error);
    await assert.rejects(h.stream.result, /服务未启动或尚未就绪/);
    assert.equal(h.socket.closed, true);
  }
});
