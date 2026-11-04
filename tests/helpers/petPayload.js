function petPayload(overrides = {}, summaryDefaults = {}) {
  const summaries = overrides.summaries;
  const payload = { shouldSpeak: true, expression: "neutral", response: "reply",
    summaries: { ...summaryDefaults }, effects: [], ...overrides };
  if (summaries && typeof summaries === "object" && !Array.isArray(summaries)) {
    payload.summaries = { ...summaryDefaults, ...summaries };
  }
  return payload;
}

module.exports = { petPayload };
