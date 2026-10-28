/**
 * 解析模型返回：优先 JSON `{ "expression", "response", "screenSummary", "audioSummary" }`，
 * 兼容旧的「第一行表情 + 换行 + 台词」。
 */

/**
 * @param {string} raw
 * @param {string[]} [allowedExpressions]
 */
function extractChatPayload(raw, allowedExpressions = []) {
  const text = String(raw || "").replace(/^\uFEFF/, "").trim();
  if (!text) {
    return {
      expression: null,
      response: null,
      screenSummary: null,
      audioSummary: null,
      raw: text,
    };
  }

  const fromJson = tryParseModelJson(text);
  if (fromJson) {
    const response = String(
      fromJson.response ?? fromJson.text ?? fromJson.reply ?? "",
    ).trim();
    const screenSummary = String(
      fromJson.screenSummary ??
        fromJson.scene ??
        fromJson.observation ??
        fromJson.summary ??
        "",
    ).trim();
    return {
      expression: normalizeExpression(fromJson.expression, allowedExpressions),
      response: response || null,
      screenSummary: screenSummary || null,
      audioSummary: String(fromJson.audioSummary || "").trim() || null,
      workSummary: String(fromJson.workSummary || "").trim() || null,
      shouldSpeak: fromJson.shouldSpeak !== false,
      structured: true,
      raw: text,
    };
  }

  return extractNewlinePayload(text, allowedExpressions);
}

/**
 * @param {string} text
 * @returns {{ expression?: unknown, response?: unknown, text?: unknown, reply?: unknown, screenSummary?: unknown, audioSummary?: unknown, scene?: unknown, observation?: unknown, summary?: unknown } | null}
 */
function tryParseModelJson(text) {
  const candidates = [text];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.unshift(fenced[1].trim());

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    candidates.push(text.slice(start, end + 1));
  }

  for (const candidate of candidates) {
    try {
      const obj = JSON.parse(candidate);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        if (
          "expression" in obj ||
          "response" in obj ||
          "text" in obj ||
          "reply" in obj ||
          "screenSummary" in obj
        ) {
          return obj;
        }
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

/**
 * @param {string} text
 * @param {string[]} allowedExpressions
 */
function extractNewlinePayload(text, allowedExpressions) {
  const nl = text.indexOf("\n");
  let expression = null;
  let response = null;

  if (nl < 0) {
    const line = text.trim();
    if (line && isKnownExpression(line, allowedExpressions)) {
      expression = normalizeExpression(line, allowedExpressions);
      response = null;
    } else {
      expression = null;
      response = text;
    }
  } else {
    const first = text.slice(0, nl).trim();
    response = text.slice(nl + 1).replace(/^\r?\n/, "").trim();
    expression = normalizeExpression(first, allowedExpressions);
  }

  return {
    expression,
    response: response != null ? String(response) : null,
    screenSummary: null,
    audioSummary: null,
    raw: text,
  };
}

function isKnownExpression(name, allowed) {
  if (!name || /\s/.test(name)) return false;
  if (!allowed.length) return /^[A-Za-z0-9_\-]+$/.test(name);
  return allowed.some((e) => e.toLowerCase() === name.toLowerCase());
}

function normalizeExpression(name, allowed) {
  const s = String(name || "").trim();
  if (!s) return "neutral";
  if (!allowed.length) return s;
  const hit = allowed.find((e) => e.toLowerCase() === s.toLowerCase());
  return hit || "neutral";
}

module.exports = { extractChatPayload };
