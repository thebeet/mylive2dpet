const REQUIRED_FIELDS = ["shouldSpeak", "expression", "response", "screenSummary", "audioSummary", "workSummary"];

function resolveExpressions(expressions = []) {
  const names = [...new Set(expressions.filter((name) => typeof name === "string" && name.trim()))];
  return names.length ? names : ["neutral", "smile", "thinking"];
}

function createResponseFormat(mode, expressions) {
  if (mode === "prompt") return undefined;
  if (mode === "json_object") return { type: "json_object" };
  return { type: "json_schema", json_schema: {
    name: "pet_dialogue", strict: true,
    schema: { type: "object", additionalProperties: false, required: [...REQUIRED_FIELDS], properties: {
      shouldSpeak: { type: "boolean" },
      expression: { type: "string", enum: resolveExpressions(expressions) },
      response: { type: "string" }, screenSummary: { type: "string" },
      audioSummary: { type: "string" }, workSummary: { type: "string" },
    } },
  } };
}

function invalidOutput(message) {
  return Object.assign(new Error(`AI 回复 JSON 不符合约定：${message}`), { code: "AI_INVALID_OUTPUT", retryable: true });
}

function validatePayload(payload, expressions, { hasImages, hasAudio, hasUserInput } = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw invalidOutput("必须返回一个 JSON 对象");
  for (const key of REQUIRED_FIELDS) {
    if (!Object.hasOwn(payload, key)) throw invalidOutput(`缺少字段 ${key}`);
    const type = key === "shouldSpeak" ? "boolean" : "string";
    if (typeof payload[key] !== type) throw invalidOutput(`${key} 必须是 ${type}`);
  }
  const extra = Object.keys(payload).filter((key) => !REQUIRED_FIELDS.includes(key));
  if (extra.length) throw invalidOutput(`包含未约定字段 ${extra.join(", ")}`);
  if (!resolveExpressions(expressions).includes(payload.expression)) throw invalidOutput("expression 不在允许的表情列表中（区分大小写）");
  if (payload.shouldSpeak && !payload.response.trim()) throw invalidOutput("shouldSpeak=true 时 response 不能为空");
  if (!payload.shouldSpeak && payload.response !== "") throw invalidOutput("shouldSpeak=false 时 response 必须为空字符串");
  if (hasUserInput && !payload.shouldSpeak) throw invalidOutput("用户直接输入时 shouldSpeak 必须为 true");
  if (hasImages === false && (payload.screenSummary !== "" || payload.workSummary !== "")) {
    throw invalidOutput("没有图片时 screenSummary 和 workSummary 必须为空字符串");
  }
  if (hasAudio === false && payload.audioSummary !== "") throw invalidOutput("没有音频时 audioSummary 必须为空字符串");
  return payload;
}

function unsupportedResponseFormat(error) {
  return [400, 422].includes(error?.status) &&
    /response_format|json_schema|structured.?outputs?|strict/i.test(error.message) &&
    /not support|unsupported|not available|unknown parameter|unrecognized|不支持|未知参数/i.test(error.message);
}

module.exports = { REQUIRED_FIELDS, resolveExpressions, createResponseFormat, validatePayload, invalidOutput, unsupportedResponseFormat };
