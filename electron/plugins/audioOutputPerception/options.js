function bounded(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function getAudioOutputOptions(config = {}) {
  const plugin = (Array.isArray(config.plugins) ? config.plugins : [])
    .find((item) => item?.name === "audio-output-perception") || null;
  const audio = plugin ||
    // Transitional support for existing user configs using the old location.
    config.perception?.audioOutput || {};
  const asr = audio.asr || {};
  return {
    enabled: plugin ? plugin.enabled !== false : audio.enabled === true,
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
    },
  };
}

module.exports = { getAudioOutputOptions };
