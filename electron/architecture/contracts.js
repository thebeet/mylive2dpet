const { randomUUID } = require("crypto");

/**
 * Observation: { id, source, role, capturedAt, expiresAt?, trigger?, content, metadata }.
 * Content parts have a type; text parts carry text, resource parts carry path or uri.
 * Additional content types belong to their producers and decision providers.
 */
function createObservation(input = {}) {
  if (typeof input.source !== "string" || !input.source.trim()) {
    throw new TypeError("observation.source must be a non-empty string");
  }
  const role = input.role ?? "context";
  if (!["user", "context"].includes(role)) {
    throw new TypeError("observation.role must be user or context");
  }
  const capturedAt = input.capturedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(capturedAt))) {
    throw new TypeError("observation.capturedAt must be a valid timestamp");
  }
  if (input.expiresAt != null && !Number.isFinite(input.expiresAt)) {
    throw new TypeError("observation.expiresAt must be a timestamp in milliseconds");
  }
  if (!Array.isArray(input.content) || input.content.length === 0) {
    throw new TypeError("observation.content must contain at least one part");
  }
  const content = input.content.map((part) => {
    if (!part || typeof part.type !== "string" || !part.type.trim()) {
      throw new TypeError("observation content part must have a type");
    }
    if (part.type === "text" && (typeof part.text !== "string" || !part.text.trim())) {
      throw new TypeError("text content must have non-empty text");
    }
    return { ...part };
  });
  return {
    id: input.id ?? randomUUID(),
    source: input.source,
    role,
    capturedAt,
    ...(input.expiresAt != null ? { expiresAt: input.expiresAt } : {}),
    trigger: input.trigger || input.source,
    content,
    metadata: { ...input.metadata },
  };
}

/** Decision providers return { reply, expression?, summaries?, metadata? }. */
function createDecisionResult(result) {
  if (!result || typeof result.reply !== "string" || !result.reply.trim()) {
    throw new TypeError("decision result must have a non-empty reply");
  }
  const summaries = result.summaries ?? {};
  if (!summaries || typeof summaries !== "object" || Array.isArray(summaries) ||
      Object.values(summaries).some((value) => typeof value !== "string")) {
    throw new TypeError("decision summaries must map names to strings");
  }
  return {
    reply: result.reply.trim(),
    expression: typeof result.expression === "string" && result.expression.trim()
      ? result.expression : "neutral",
    summaries: { ...summaries },
    metadata: { ...result.metadata },
  };
}

function createContextBlock(block) {
  if (!block || typeof block.id !== "string" || !block.id.trim() ||
      typeof block.text !== "string" || !block.text.trim()) {
    throw new TypeError("context block requires a non-empty id and text");
  }
  return {
    id: block.id,
    title: typeof block.title === "string" && block.title.trim() ? block.title : block.id,
    text: block.text,
  };
}

module.exports = { createObservation, createDecisionResult, createContextBlock };
