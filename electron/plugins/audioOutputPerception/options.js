const { readPluginOptions } = require("../registry");

function bounded(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function normalizeOptions(plugin) {
  const audio = plugin || {};
  const asr = audio.asr || {};
  return {
    enabled: Boolean(plugin && plugin.enabled !== false),
    source: String(audio.source || "default"),
    sampleRate: 16000,
    frameMs: 20,
    // Energy gate followed by ASR; this is not a music/sound classifier.
    speechThresholdDb: bounded(audio.speechThresholdDb, -40, -80, -10),
    minSpeechMs: bounded(audio.minSpeechMs, 400, 100, 5000),
    silenceMs: bounded(audio.silenceMs, 800, 200, 3000),
    maxSegmentMs: bounded(audio.maxSegmentMs, 15000, 3000, 30000),
    preRollMs: 200,
    ttsCooldownMs: bounded(audio.ttsCooldownMs, 600, 100, 5000),
    maxPendingSegments: 3,
    maxPendingObservations: 20,
    observationTtlMs: 60000,
    duplicateWindowMs: 15000,
    asr: {
      provider: String(asr.provider || "openai").trim(),
      endpoint: String(asr.endpoint || "").trim(),
      apiKey: String(asr.apiKey || "").trim(),
      model: String(asr.model || "").trim(),
      language: String(asr.language || "").trim(),
      vadFilter: asr.vadFilter !== false,
      proxy: String(asr.proxy || "").trim(),
      timeoutMs: bounded(asr.timeoutMs, 30000, 1000, 120000),
      chunkSize: Array.isArray(asr.chunkSize) && asr.chunkSize.length === 3 &&
        asr.chunkSize.every((n, i) => Number.isInteger(n) && n >= (i === 1 ? 1 : 0) && n <= 20)
        ? [...asr.chunkSize] : [5, 10, 5],
      chunkInterval: Math.round(bounded(asr.chunkInterval, 10, 1, 20)),
    },
  };
}

function getAudioOutputOptions(config = {}) {
  return readPluginOptions(config, "audio-output-perception", normalizeOptions);
}

module.exports = { getAudioOutputOptions, normalizeOptions };
