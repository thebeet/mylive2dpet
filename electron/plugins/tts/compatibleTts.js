const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { createHash, randomUUID } = require("crypto");
const { resolveProjectPath } = require("./paths");
const { createDockerService } = require("./dockerService");

function createCompatibleTts({ fetchImpl, dockerService, logger = console, onStatus = () => {} } = {}) {
  const fetchLocal = fetchImpl || ((...args) => require("electron").net.fetch(...args));
  const docker = dockerService || createDockerService({ fetchImpl: fetchLocal, logger });
  const controllers = new Set();
  const tasks = new Set();
  let lifetime = new AbortController();
  let active = true;
  let preparation = null;
  let state = { phase: "idle", error: null };

  function setState(phase, error = null) {
    state = { phase, error };
    onStatus(state);
  }

  async function request(url, options, init, signal) {
    const headers = { ...init.headers };
    if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;
    const response = await fetchLocal(url, {
      ...init, headers, signal: AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs)]),
    });
    if (!response.ok) {
      // Avoid echoing vendor responses, which may contain credentials or full request bodies.
      await response.body?.cancel().catch(() => {});
      throw new Error(`TTS API 请求失败：HTTP ${response.status}（${new URL(url).pathname}）`);
    }
    return response;
  }

  async function readReference(options, signal) {
    const audioPath = resolveProjectPath(options.refAudio);
    let audio;
    try { audio = await fs.readFile(audioPath, { signal }); }
    catch (error) {
      signal.throwIfAborted();
      throw new Error(`无法读取 TTS 参考音频：${options.refAudio}（${error.code || error.message}）`);
    }
    if (!audio.length) throw new Error("TTS 参考音频不能为空");
    return { audio, audioPath };
  }

  async function resolveVoice(base, options, signal, reference) {
    if (options.service.type !== "docker") return options.voice;
    if (options.voice) {
      const response = await request(`${base}/voices/${encodeURIComponent(options.voice)}`, options, { method: "GET" }, signal);
      await response.json();
      return options.voice;
    }
    setState("registering-voice");
    const { audio, audioPath } = reference;
    const name = `mylive2dpet-${createHash("sha256").update(audio).update(options.promptText).digest("hex").slice(0, 24)}`;
    const listing = await request(`${base}/voices/custom`, options, { method: "GET" }, signal);
    const existing = (await listing.json()).voices?.find((voice) => voice.name === name);
    if (existing?.id) return existing.id;
    const body = new FormData();
    body.append("name", name);
    body.append("text", options.promptText);
    body.append("audio", new Blob([audio]), path.basename(audioPath));
    const response = await request(`${base}/voices/create`, options, { method: "POST", body }, signal);
    const created = await response.json();
    if (!created.success || !created.voice_id) throw new Error("CosyVoice 未返回有效的克隆音色 ID");
    return created.voice_id;
  }

  function prepare(options) {
    if (!active) return Promise.reject(new Error("TTS 已停止"));
    if (preparation) return preparation;
    const signal = lifetime.signal;
    const task = (async () => {
      setState("connecting");
      // Reject a missing reference before pulling a multi-gigabyte image or allocating GPU memory.
      const reference = options.service.type === "docker" && !options.voice ? await readReference(options, signal) : null;
      const base = options.service.type === "docker"
        ? await docker.ensure(options.service, signal, (phase) => setState(phase))
        : options.apiBase.replace(/\/+$/, "");
      signal.throwIfAborted();
      const voice = await resolveVoice(base, options, signal, reference);
      signal.throwIfAborted();
      setState("ready");
      logger.info("[tts] 语音服务已就绪");
      return { base, voice };
    })().catch((error) => {
      if (!signal.aborted) setState("error", error.message);
      if (preparation === task) preparation = null;
      throw error;
    });
    preparation = task;
    return task;
  }

  // A new utterance may cancel its wait, while image download/model loading continues for later utterances.
  function waitForPreparation(options, signal) {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      prepare(options).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }

  function synthesizeToFile(text, options) {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, lifetime.signal, ...(options.signal ? [options.signal] : [])]);
    controllers.add(controller);
    const task = (async () => {
      const cleaned = String(text || "").trim();
      if (!cleaned) return null;
      const { base, voice } = await waitForPreparation(options, signal);
      signal.throwIfAborted();
      const body = { model: options.model, input: cleaned, voice, response_format: "wav", speed: options.speed };
      if (options.instruct) body.instruct = options.instruct;
      const response = await request(`${base}/audio/speech`, options, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      }, signal);
      const audio = Buffer.from(await response.arrayBuffer());
      signal.throwIfAborted();
      if (audio.length < 44 || !["RIFF", "RF64"].includes(audio.toString("ascii", 0, 4)) || audio.toString("ascii", 8, 12) !== "WAVE") {
        throw new Error("TTS 服务未返回有效 WAV 音频，请确认服务支持 response_format=wav");
      }
      const file = path.join(os.tmpdir(), `mylive2dpet-speech-${randomUUID()}.wav`);
      try {
        await fs.writeFile(file, audio, { signal });
        signal.throwIfAborted();
        return { path: file, deleteAfter: true };
      } catch (error) {
        await fs.unlink(file).catch(() => {});
        throw error;
      }
    })().catch((error) => {
      if (!signal.aborted) {
        preparation = null;
        setState("error", error.message);
      }
      throw error;
    }).finally(() => { controllers.delete(controller); tasks.delete(task); });
    tasks.add(task);
    return task;
  }

  function stop() {
    for (const controller of controllers) controller.abort();
    return Promise.allSettled([...tasks]);
  }

  async function shutdown() {
    active = false;
    lifetime.abort();
    await Promise.allSettled([preparation, stop()]);
    preparation = null;
    try { await docker.stop(); }
    finally { setState("idle"); }
  }

  function start(options) {
    active = true;
    if (lifetime.signal.aborted) lifetime = new AbortController();
    return prepare(options);
  }

  return { start, synthesizeToFile, stop, shutdown, getState: () => ({ ...state }) };
}

module.exports = { createCompatibleTts };
