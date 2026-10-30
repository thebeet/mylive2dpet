const { validatePayload, invalidOutput } = require("./output");

/** Accept only a complete JSON object matching the current dialogue contract. */
function extractChatPayload(raw, allowedExpressions = [], input = {}) {
  const text = String(raw || "").trim();
  if (!text) throw invalidOutput("正文为空");
  let payload;
  try { payload = JSON.parse(text); }
  catch { throw invalidOutput("正文不是完整合法的 JSON，不接受代码块或附带说明文字"); }
  return validatePayload(payload, allowedExpressions, input);
}

module.exports = { extractChatPayload };
