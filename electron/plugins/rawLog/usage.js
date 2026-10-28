function tokenCount(...values) {
  return values.find((value) => Number.isSafeInteger(value) && value >= 0) ?? null;
}

/** Preserve missing counters as unknown; output/reasoning and cache/write are overlapping totals. */
function normalizeUsage(usage) {
  if (typeof usage === "string") {
    try { usage = JSON.parse(usage); } catch { return null; }
  }
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const inputTokens = tokenCount(usage.prompt_tokens, usage.input_tokens);
  const outputTokens = tokenCount(usage.completion_tokens, usage.output_tokens);
  const cachedTokens = tokenCount(usage.prompt_tokens_details?.cached_tokens,
    usage.input_tokens_details?.cached_tokens, usage.prompt_cache_hit_tokens);
  const explicitMiss = tokenCount(usage.prompt_cache_miss_tokens);
  const uncachedTokens = explicitMiss ?? (inputTokens !== null && cachedTokens !== null && cachedTokens <= inputTokens ? inputTokens - cachedTokens : null);
  const totalTokens = tokenCount(usage.total_tokens, inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null);
  const cacheWriteTokens = tokenCount(usage.prompt_tokens_details?.cache_write_tokens, usage.input_tokens_details?.cache_write_tokens);
  const reasoningTokens = tokenCount(usage.completion_tokens_details?.reasoning_tokens, usage.output_tokens_details?.reasoning_tokens);
  const result = { inputTokens, outputTokens, totalTokens, cachedTokens, uncachedTokens, cacheWriteTokens, reasoningTokens };
  return Object.values(result).some((value) => value !== null) ? result : null;
}

function responseUsage(response) {
  if (typeof response === "string") {
    try { response = JSON.parse(response); } catch { return null; }
  }
  return normalizeUsage(response?.usage);
}

module.exports = { normalizeUsage, responseUsage };
