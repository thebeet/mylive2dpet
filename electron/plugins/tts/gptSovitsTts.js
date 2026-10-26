const fs = require("fs");
const os = require("os");
const path = require("path");
const { randomUUID } = require("crypto");
const { resolveProjectPath } = require("./paths");

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

function createGptSovitsTts({ fetchImpl, logger = console } = {}) {
  const controllers = new Set();
  const tasks = new Set();
  let lastGptWeights = "";
  let lastSovitsWeights = "";
  const fetchLocal = fetchImpl || ((url, init) => require("electron").net.fetch(url, init));

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
        logger.info("[tts:gpt-sovits] assume gpt preloaded:", gptWeights);
      }
      if (sovitsWeights && !lastSovitsWeights) {
        lastSovitsWeights = sovitsWeights;
        logger.info("[tts:gpt-sovits] assume sovits preloaded:", sovitsWeights);
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
      signal.throwIfAborted();
      lastGptWeights = gptWeights;
      logger.info("[tts:gpt-sovits] gpt weights:", gptWeights);
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
      signal.throwIfAborted();
      lastSovitsWeights = sovitsWeights;
      logger.info("[tts:gpt-sovits] sovits weights:", sovitsWeights);
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
    // refAudio is read locally to verify the configured source file. A remote or
    // containerized API may need a different path for the same mounted file.
    const localRefAudio = resolveProjectPath(opts.refAudio);
    if (!localRefAudio || !fs.existsSync(localRefAudio)) {
      throw new Error(`refAudio not found: ${opts.refAudio || "(empty)"}`);
    }
    const apiRefAudio = String(opts.refAudioApiPath || localRefAudio).trim();

    const gptWeights = resolveProjectPath(opts.gptWeights);
    const sovitsWeights = resolveProjectPath(opts.sovitsWeights);
    if (apiVersion === "v2") {
      await ensureWeights(apiBase, gptWeights, sovitsWeights, signal, {
        weightsPreloaded: opts.weightsPreloaded === true,
      });
    }

    const promptText =
      (opts.promptText && String(opts.promptText).trim()) ||
      promptTextFromRefAudio(localRefAudio);
    const textLang = opts.textLang || "zh";
    const promptLang = opts.promptLang || textLang;

    /** @type {string} */
    let url;
    /** @type {Record<string, unknown>} */
    let body;

    if (apiVersion === "v1") {
      url = apiBase;
      body = {
        refer_wav_path: apiRefAudio,
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
        ref_audio_path: apiRefAudio,
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
   * 合成到本地 wav（不播放）。
   * @param {string} text
   * @param {object} [options]
   * @returns {Promise<{ path: string, deleteAfter: boolean } | null>}
   */
  function synthesizeToFile(text, options = {}) {
    const ac = new AbortController();
    const signal = options.signal ? AbortSignal.any([ac.signal, options.signal]) : ac.signal;
    controllers.add(ac);
    const task = Promise.resolve().then(async () => {
      signal.throwIfAborted();
      const cleaned = sanitize(text);
      if (!cleaned) return null;
      logger.info("[tts:gpt-sovits] synthesize:", cleaned.slice(0, 60));
      const wav = await synthesize(options, cleaned, signal);
      signal.throwIfAborted();
      const tmp = path.join(os.tmpdir(), `mylive2dpet-gsv-${randomUUID()}.wav`);
      try {
        fs.writeFileSync(tmp, wav);
        signal.throwIfAborted();
        return { path: tmp, deleteAfter: true };
      } catch (error) {
        try { fs.unlinkSync(tmp); } catch { /* No complete output. */ }
        throw error;
      }
    }).finally(() => { controllers.delete(ac); tasks.delete(task); });
    tasks.add(task);
    return task;
  }

  function stop() {
    for (const controller of controllers) controller.abort();
    return Promise.allSettled([...tasks]);
  }

  return { synthesizeToFile, stop };
}

module.exports = { createGptSovitsTts, promptTextFromRefAudio, resolveProjectPath };
