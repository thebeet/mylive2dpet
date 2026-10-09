/**
 * 解析「第一行 expression，其余为 response」的纯文本协议（适合 SSE 流式）。
 *
 * 示例：
 * smile
 * 前辈还在写代码呢。
 */

/**
 * @param {string} raw
 * @param {string[]} [allowedExpressions]
 */
function extractChatPayload(raw, allowedExpressions = []) {
  const text = String(raw || "").replace(/^\uFEFF/, "");
  if (!text) {
    return { expression: null, response: null, raw: text };
  }

  const nl = text.indexOf("\n");
  let expression = null;
  let response = null;

  if (nl < 0) {
    // 尚未出现换行：若整行已是合法表情名则先记下，否则先当台词流式展示
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
    response = text.slice(nl + 1).replace(/^\r?\n/, "");
    // 去掉结尾多余空白，但流式中保留正在输入的感觉（不 trimEnd 太多）
    expression = normalizeExpression(first, allowedExpressions);
  }

  return {
    expression,
    response: response != null ? String(response) : null,
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
