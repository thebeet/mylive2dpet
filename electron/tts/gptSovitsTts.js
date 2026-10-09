const fs = require("fs");
const os = require("os");
const path = require("path");
const { net } = require("electron");
const { resolveProjectPath } = require("./paths");
const playWav = require("./playWav");

/** @type {AbortController | null} */
let abortController = null;
let generation = 0;
let lastGptWeights = "";
let lastSovitsWeights = "";

function sanitize(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

/**
 * 从参考音频文件名推断 prompt_text：去掉扩展名与前导【情感】标签。
 * @param {string} refAudioPath
 */
function promptTextFromRefAudio(refAudioPath) {
  const base = path.basename(refAudioPath, path.extname(refAudioPath));
  return base.replace(/^【[^】]*】/, "").trim();
}

function stop() {
  generation += 1;
  if (abortController) {
    try {
      abortController.abort();
    } catch {
      /* ignore */
    }
    abortController = null;
  }
  playWav.stop();
}

/**
 * @param {string} url
 * @param {RequestInit} [init]
 */
async function fetchLocal(url, init = {}) {
  return net.fetch(url, init);
}

/**
 * @param {string} apiBase
 * @param {string} gptWeights
 * @param {string} sovitsWeights
 * @param {AbortSignal} signal
 * @param {{ weightsPreloaded?: boolean }} [opts]
 */
async function ensureWeights(
  apiBase,
  gptWeights,
  sovitsWeights,
  signal,
  opts = {},
) {
  const base = apiBase.replace(/\/+$/, "");

  // API 已在启动时按 tts_infer.yaml 加载同一套权重时，跳过首次 set_* 往返
  if (opts.weightsPreloaded) {
    if (gptWeights && !lastGptWeights) {
      lastGptWeights = gptWeights;
      console.log("[tts:gpt-sovits] assume gpt preloaded:", gptWeights);
    }
    if (sovitsWeights && !lastSovitsWeights) {
      lastSovitsWeights = sovitsWeights;
      console.log("[tts:gpt-sovits] assume sovits preloaded:", sovitsWeights);
    }
  }

  if (gptWeights && gptWeights !== lastGptWeights) {
    const url = `${base}/set_gpt_weights?weights_path=${encodeURIComponent(gptWeights)}`;
    const res = await fetchLocal(url, { method: "GET", signal });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `set_gpt_weights ${res.status}: ${body.slice(0, 200) || res.statusText}`,
      );
    }
    lastGptWeights = gptWeights;
    console.log("[tts:gpt-sovits] gpt weights:", gptWeights);
  }

  if (sovitsWeights && sovitsWeights !== lastSovitsWeights) {
    const url = `${base}/set_sovits_weights?weights_path=${encodeURIComponent(sovitsWeights)}`;
    const res = await fetchLocal(url, { method: "GET", signal });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `set_sovits_weights ${res.status}: ${body.slice(0, 200) || res.statusText}`,
      );
    }
    lastSovitsWeights = sovitsWeights;
    console.log("[tts:gpt-sovits] sovits weights:", sovitsWeights);
  }
}

/**
 * @param {object} opts
 * @param {string} text
 * @param {AbortSignal} signal
 * @returns {Promise<Buffer>}
 */
async function synthesize(opts, text, signal) {
  const apiBase = String(opts.apiBase || "http://127.0.0.1:9880").replace(
    /\/+$/,
    "",
  );
  const apiVersion = opts.apiVersion === "v1" ? "v1" : "v2";
  const refAudio = resolveProjectPath(opts.refAudio);
  if (!refAudio || !fs.existsSync(refAudio)) {
    throw new Error(`refAudio not found: ${opts.refAudio || "(empty)"}`);
  }

  const gptWeights = resolveProjectPath(opts.gptWeights);
  const sovitsWeights = resolveProjectPath(opts.sovitsWeights);
  if (apiVersion === "v2") {
    await ensureWeights(apiBase, gptWeights, sovitsWeights, signal, {
      weightsPreloaded: opts.weightsPreloaded === true,
    });
  }

  const promptText =
    (opts.promptText && String(opts.promptText).trim()) ||
    promptTextFromRefAudio(refAudio);
  const textLang = opts.textLang || "zh";
  const promptLang = opts.promptLang || textLang;

  /** @type {string} */
  let url;
  /** @type {Record<string, unknown>} */
  let body;

  if (apiVersion === "v1") {
    url = apiBase;
    body = {
      refer_wav_path: refAudio,
      prompt_text: promptText,
      prompt_language: promptLang,
      text,
      text_language: textLang,
      top_k: opts.topK ?? 15,
      top_p: opts.topP ?? 1,
      temperature: opts.temperature ?? 1,
      speed: opts.speedFactor ?? 1,
    };
  } else {
    url = `${apiBase}/tts`;
    body = {
      text,
      text_lang: textLang,
      ref_audio_path: refAudio,
      prompt_text: promptText,
      prompt_lang: promptLang,
      top_k: opts.topK ?? 15,
      top_p: opts.topP ?? 1,
      temperature: opts.temperature ?? 1,
      text_split_method: opts.textSplitMethod || "cut5",
      batch_size: opts.batchSize ?? 1,
      speed_factor: opts.speedFactor ?? 1,
      streaming_mode: false,
      media_type: "wav",
    };
  }

  const res = await fetchLocal(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  const buf = Buffer.from(await res.arrayBuffer());
  if (!res.ok) {
    const msg = buf.toString("utf8").slice(0, 300);
    throw new Error(`tts ${res.status}: ${msg || res.statusText}`);
  }

  // 失败时部分实现仍返回 200 + JSON
  if (buf.length >= 2 && buf[0] === 0x7b /* { */) {
    const msg = buf.toString("utf8").slice(0, 300);
    throw new Error(`tts returned json: ${msg}`);
  }

  return buf;
}

/**
 * 调用本机 GPT-SoVITS API 合成并播放。
 * 需事先启动 api_v2.py（默认 http://127.0.0.1:9880）。
 *
 * @param {string} text
 * @param {object} [options]
 * @param {string} [options.apiBase]
 * @param {"v1"|"v2"} [options.apiVersion]
 * @param {string} [options.gptWeights]
 * @param {string} [options.sovitsWeights]
 * @param {boolean} [options.weightsPreloaded] API 启动已加载同套权重时跳过首次切换
 * @param {string} [options.refAudio]
 * @param {string} [options.promptText]
 * @param {string} [options.textLang]
 * @param {string} [options.promptLang]
 * @param {number} [options.topK]
 * @param {number} [options.topP]
 * @param {number} [options.temperature]
 * @param {number} [options.speedFactor]
 * @param {string} [options.textSplitMethod]
 * @param {number} [options.batchSize]
 */
async function speak(text, options = {}) {
  const cleaned = sanitize(text);
  if (!cleaned) return;

  stop();
  const myGen = generation;
  const ac = new AbortController();
  abortController = ac;

  try {
    console.log("[tts:gpt-sovits] synthesize:", cleaned.slice(0, 60));
    const wav = await synthesize(options, cleaned, ac.signal);
    if (myGen !== generation) return;

    const tmp = path.join(
      os.tmpdir(),
      `mylive2dpet-gsv-${process.pid}-${Date.now()}.wav`,
    );
    fs.writeFileSync(tmp, wav);
    if (myGen !== generation) {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
      return;
    }

    await playWav.play(tmp, { deleteAfter: true });
  } catch (err) {
    if (ac.signal.aborted || myGen !== generation) return;
    throw err;
  } finally {
    if (abortController === ac) abortController = null;
  }
}

module.exports = {
  speak,
  stop,
  promptTextFromRefAudio,
  resolveProjectPath,
};
