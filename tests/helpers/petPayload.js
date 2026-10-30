function petPayload(overrides = {}) {
  return { shouldSpeak: true, expression: "neutral", response: "reply",
    screenSummary: "", audioSummary: "", workSummary: "", ...overrides };
}

module.exports = { petPayload };
