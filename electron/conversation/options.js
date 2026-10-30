const { dictionary, number, freeze } = require("../architecture/configValidation");

function normalizeOptions(input = {}) {
  dictionary(input, "conversation");
  dictionary(input.ai, "conversation.ai");
  dictionary(input.character, "conversation.character");
  dictionary(input.history, "conversation.history");
  if (input.enabled != null && typeof input.enabled !== "boolean") throw new Error("conversation.enabled 必须是布尔值");
  const ai = { ...input.ai };
  ai.outputFormat = ai.outputFormat ?? "auto";
  if (!["auto", "json_schema", "json_object", "prompt"].includes(ai.outputFormat)) {
    throw new Error("conversation.ai.outputFormat 必须为 auto、json_schema、json_object 或 prompt");
  }
  for (const key of ["endpoint", "apiKey", "model", "proxy"]) {
    if (ai[key] != null && typeof ai[key] !== "string") throw new Error(`conversation.ai.${key} 必须是字符串`);
  }
  ai.timeoutMs = number(ai.timeoutMs, 120000, 1000, 600000, "conversation.ai.timeoutMs");
  ai.retryBudgetMs = number(ai.retryBudgetMs, 360000, 1000, 1200000, "conversation.ai.retryBudgetMs");
  const history = {};
  for (const [key, fallback, min, max] of [
    ["maxTurns", 32, 2, 200], ["keepTurns", 4, 1, 199],
    ["maxInputTokens", 50000, 1000, 1000000], ["hardInputTokens", 100000, 1000, 1000000],
    ["summaryMaxTokens", 1600, 128, 16384], ["summaryMaxChars", 6000, 256, 64000],
  ]) history[key] = number(input.history?.[key], fallback, min, max, `conversation.history.${key}`);
  if (history.keepTurns >= history.maxTurns) throw new Error("conversation.history.keepTurns 必须小于 maxTurns");
  if (history.hardInputTokens <= history.maxInputTokens) throw new Error("conversation.history.hardInputTokens 必须大于 maxInputTokens");
  return freeze({ enabled: input.enabled !== false, ai, character: { ...input.character }, history });
}

function getOptions(config = {}) {
  return normalizeOptions(config.conversation ?? {});
}

module.exports = { normalizeOptions, getOptions };
