const { pcmToWav } = require("./segmenter");

function transcriptionEndpoint(endpoint, provider = "openai") {
  if (!["openai", "whisper-asr-webservice"].includes(provider)) throw new Error(`不支持的 ASR provider：${provider}`);
  if (!endpoint) throw new Error("请配置 plugins[name=audio-output-perception].asr.endpoint");
  const url = new URL(endpoint);
  if (!["https:", "http:"].includes(url.protocol)) throw new Error("ASR endpoint 必须是 HTTP(S) 地址");
  const pathname = url.pathname.replace(/\/+$/, "");
  const suffix = provider === "whisper-asr-webservice" ? "/asr" : "/audio/transcriptions";
  url.pathname = pathname.endsWith(suffix) ? pathname : pathname + suffix;
  return url.toString();
}

function validateAsrOptions(options) {
  const endpoint = transcriptionEndpoint(options.endpoint, options.provider);
  if ((options.provider || "openai") === "openai" && !options.model) throw new Error("请配置 plugins[name=audio-output-perception].asr.model");
  return endpoint;
}

function isKnownSubtitleHallucination(text) {
  const normalized = String(text || "").replace(/[\s\p{P}\p{S}]+/gu, "").toLowerCase();
  return /^字幕(?:by|由)?索[兰蘭][娅婭]$/.test(normalized);
}

/** Transcribe in memory; raw PCM is never logged or written to disk. */
async function transcribeAudio(segment, options, { fetchImpl = globalThis.fetch, signal } = {}) {
  let endpoint = validateAsrOptions(options);
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, options.timeoutMs);
  const form = new FormData();
  const whisperService = options.provider === "whisper-asr-webservice";
  form.append(whisperService ? "audio_file" : "file", new Blob([pcmToWav(segment.pcm)], { type: "audio/wav" }), "output.wav");
  if (whisperService) {
    const url = new URL(endpoint);
    url.searchParams.set("task", "transcribe");
    url.searchParams.set("output", "json");
    // We upload a WAV container, so FFmpeg decoding must stay enabled.
    url.searchParams.set("encode", "true");
    url.searchParams.set("vad_filter", String(options.vadFilter !== false));
    if (options.language) url.searchParams.set("language", options.language);
    endpoint = url.toString();
  } else {
    form.append("model", options.model);
    form.append("response_format", "json");
    if (options.language) form.append("language", options.language);
  }
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {},
      body: form,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`音频转写接口返回 HTTP ${response.status}`);
    const data = await response.json();
    if (typeof data?.text !== "string") throw new Error("音频转写接口没有返回 text 字段");
    // Some providers include speech confidence even for the JSON response format.
    const segments = Array.isArray(data.segments) ? data.segments : [];
    const usable = segments.filter((part) =>
      !(typeof part.no_speech_prob === "number" && part.no_speech_prob > 0.8) &&
      !(typeof part.avg_logprob === "number" && part.avg_logprob < -1.5) &&
      !isKnownSubtitleHallucination(part.text),
    );
    const text = (segments.length
      ? usable.map((part) => String(part.text || "")).join("")
      : data.text).trim().slice(0, 6000);
    const logprobs = usable.map((part) => part.avg_logprob).filter(Number.isFinite);
    return {
      text: isKnownSubtitleHallucination(text) ? "" : text,
      language: String(data.language || options.language || ""),
      confidence: logprobs.length
        ? Math.exp(logprobs.reduce((sum, value) => sum + value, 0) / logprobs.length)
        : null,
    };
  } catch (error) {
    if (controller.signal.aborted && !signal?.aborted) throw new Error("音频转写超时，请检查 ASR 服务或调大 timeoutMs");
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

module.exports = { transcribeAudio, transcriptionEndpoint, validateAsrOptions };
