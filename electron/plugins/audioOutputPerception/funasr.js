const WebSocket = require("ws");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { randomUUID } = require("node:crypto");
const { validateAsrOptions } = require("./transcribe");

/** One bounded utterance per connection; online deltas never become observations. */
function createFunAsrStream(options, { onPartial = () => {}, maxAudioBytes = 1024 * 1024,
  socketFactory = (url, init) => new WebSocket(url, init) } = {}) {
  const id = randomUUID();
  const chunkSize = options.chunkSize || [5, 10, 5];
  const chunkInterval = options.chunkInterval || 10;
  const packetBytes = Math.round(16000 * 0.06 * chunkSize[1] / chunkInterval) * 2;
  const socket = socketFactory(validateAsrOptions(options), {
    headers: options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {},
    agent: options.proxy ? new HttpsProxyAgent(options.proxy) : undefined,
    maxPayload: 1024 * 1024,
  });
  let pending = Buffer.alloc(0);
  let opened = false;
  let ended = false;
  let done = false;
  let online = "";
  let offline = "";
  let totalBytes = 0;
  let resolveResult;
  let rejectResult;
  const result = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
  // A stream may fail while the caller is still feeding audio.
  void result.catch(() => {});
  let timer = setTimeout(() => fail(new Error("FunASR 连接超时")), options.timeoutMs);

  function complete(error) {
    if (done) return;
    done = true;
    clearTimeout(timer);
    pending = Buffer.alloc(0);
    if (error) rejectResult(error);
    else resolveResult({ text: offline.trim().slice(0, 6000), language: options.language || "", confidence: null });
    // terminate also aborts a pending handshake and prevents shutdown hangs.
    socket.terminate();
  }
  function fail(error) { complete(error); }
  function send(data) {
    if (socket.bufferedAmount + data.length > maxAudioBytes) {
      fail(new Error("FunASR 发送积压，已丢弃该语音片段"));
      return;
    }
    socket.send(data, (error) => { if (error) fail(error); });
  }
  function flush() {
    if (!opened || done) return;
    while (!done && pending.length >= packetBytes) {
      const packet = pending.subarray(0, packetBytes);
      pending = pending.subarray(packetBytes);
      send(packet);
    }
    if (ended && !done) {
      if (pending.length) send(pending);
      pending = Buffer.alloc(0);
      if (!done) send(JSON.stringify({ is_speaking: false, is_end: true }));
    }
  }

  socket.on("open", () => {
    if (done) return;
    opened = true;
    clearTimeout(timer);
    if (ended) timer = setTimeout(() => fail(new Error("FunASR 最终转写超时")), options.timeoutMs);
    send(JSON.stringify({ mode: "2pass", wav_name: id, wav_format: "pcm", audio_fs: 16000,
      is_speaking: true, chunk_size: chunkSize, chunk_interval: chunkInterval,
      encoder_chunk_look_back: 4, decoder_chunk_look_back: 0, itn: true }));
    flush();
  });
  socket.on("message", (payload) => {
    if (done) return;
    try {
      const data = JSON.parse(payload.toString());
      if (data.error) throw new Error(`FunASR：${data.error}`);
      if (data.text != null && typeof data.text !== "string") throw new Error("FunASR 返回的 text 字段无效");
      if (data.text?.startsWith("ERROR.")) throw new Error(`FunASR：${data.text}`);
      if (data.wav_name && data.wav_name !== id) return;
      if (data.mode === "2pass-online") online = (online + (data.text || "")).slice(0, 6000);
      else if (data.mode === "2pass-offline") {
        offline = (offline + (data.text || "")).slice(0, 6000);
        online = "";
      }
      if (data.mode === "2pass-online" || data.mode === "2pass-offline") {
        onPartial({ id, text: (offline + online).slice(0, 6000) });
      }
      // C++ servers may send an empty final message without mode. A Python
      // end-of-input acknowledgement uses is_end; online finals are insufficient.
      if (ended && data.is_final === true && data.mode !== "2pass-online") complete();
    } catch (error) { fail(error); }
  });
  socket.on("error", (error) => {
    const refused = error.code === "ECONNREFUSED" ||
      error.errors?.some((item) => item.code === "ECONNREFUSED");
    fail(new Error(refused
      ? "FunASR 服务未启动或尚未就绪，请启动 ASR 容器并等待模型加载完成"
      : `FunASR 连接失败：${error.message}`));
  });
  socket.on("close", () => { if (!done) fail(new Error("FunASR 连接提前关闭")); });

  return {
    id, result,
    push(chunk) {
      if (done || ended) return;
      totalBytes += chunk.length;
      if (totalBytes > maxAudioBytes || pending.length + chunk.length > maxAudioBytes) {
        fail(new Error("FunASR 音频片段超出缓存上限"));
        return;
      }
      pending = Buffer.concat([pending, chunk]);
      flush();
    },
    finish() {
      if (done || ended) return result;
      ended = true;
      if (opened) {
        timer = setTimeout(() => fail(new Error("FunASR 最终转写超时")), options.timeoutMs);
        flush();
      }
      return result;
    },
    cancel() { complete(Object.assign(new Error("FunASR 识别已取消"), { name: "AbortError" })); },
  };
}

module.exports = { createFunAsrStream };
