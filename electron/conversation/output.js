const REQUIRED_FIELDS = ["shouldSpeak", "expression", "response", "summaries", "effects"];

function resolveExpressions(expressions = []) {
  const names = [...new Set(expressions.filter((name) => typeof name === "string" && name.trim()))];
  return names.length ? names : ["neutral", "smile", "thinking"];
}

function createResponseFormat(mode, expressions, effectSchemas = [], summarySchemas = {}) {
  if (mode === "prompt") return undefined;
  if (mode === "json_object") return { type: "json_object" };
  return { type: "json_schema", json_schema: {
    name: "pet_dialogue", strict: true,
    schema: { type: "object", additionalProperties: false, required: [...REQUIRED_FIELDS], properties: {
      shouldSpeak: { type: "boolean" },
      expression: { type: "string", enum: resolveExpressions(expressions) },
      response: { type: "string" },
      summaries: { type: "object", additionalProperties: false,
        required: Object.keys(summarySchemas), properties: summarySchemas },
      effects: { type: "array", items: effectSchemas.length ? { anyOf: effectSchemas }
        : { type: "object", properties: {}, required: [], additionalProperties: false } },
    } },
  } };
}

function invalidOutput(message) {
  return Object.assign(new Error(`AI 回复 JSON 不符合约定：${message}`), { code: "AI_INVALID_OUTPUT", retryable: true });
}

function validatePayload(payload, expressions, { hasUserInput, summarySchemas, summaryValidators = [], observations = [] } = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw invalidOutput("必须返回一个 JSON 对象");
  for (const key of REQUIRED_FIELDS) {
    if (!Object.hasOwn(payload, key)) throw invalidOutput(`缺少字段 ${key}`);
    if (key === "effects") {
      if (!Array.isArray(payload.effects) || payload.effects.some((effect) =>
        !effect || typeof effect !== "object" || Array.isArray(effect))) {
        throw invalidOutput("effects 必须是对象数组");
      }
    } else if (key === "summaries") {
      if (!payload.summaries || typeof payload.summaries !== "object" || Array.isArray(payload.summaries) ||
          Object.values(payload.summaries).some((value) => typeof value !== "string")) {
        throw invalidOutput("summaries 必须是值为字符串的对象");
      }
      if (summarySchemas) {
        for (const name of Object.keys(summarySchemas)) {
          if (!Object.hasOwn(payload.summaries, name)) throw invalidOutput(`缺少摘要字段 summaries.${name}`);
        }
        const unknown = Object.keys(payload.summaries).filter((name) => !Object.hasOwn(summarySchemas, name));
        if (unknown.length) throw invalidOutput(`包含未声明摘要字段 ${unknown.join(", ")}`);
      }
      Object.freeze(payload.summaries);
    } else {
      const type = key === "shouldSpeak" ? "boolean" : "string";
      if (typeof payload[key] !== type) throw invalidOutput(`${key} 必须是 ${type}`);
    }
  }
  const extra = Object.keys(payload).filter((key) => !REQUIRED_FIELDS.includes(key));
  if (extra.length) throw invalidOutput(`包含未约定字段 ${extra.join(", ")}`);
  if (!resolveExpressions(expressions).includes(payload.expression)) throw invalidOutput("expression 不在允许的表情列表中（区分大小写）");
  if (payload.shouldSpeak && !payload.response.trim()) throw invalidOutput("shouldSpeak=true 时 response 不能为空");
  if (!payload.shouldSpeak && payload.response !== "") throw invalidOutput("shouldSpeak=false 时 response 必须为空字符串");
  if (hasUserInput && !payload.shouldSpeak) throw invalidOutput("用户直接输入时 shouldSpeak 必须为 true");
  for (const { name, validate } of summaryValidators) {
    try {
      const result = validate(payload.summaries, { observations });
      if (result?.then) throw new TypeError("summary validation must be synchronous");
    } catch (error) { throw invalidOutput(`插件 ${name} 摘要校验失败：${error.message || error}`); }
  }
  return payload;
}

function unsupportedResponseFormat(error) {
  return [400, 422].includes(error?.status) &&
    /response_format|json_schema|structured.?outputs?|strict/i.test(error.message) &&
    /not support|unsupported|not available|unknown parameter|unrecognized|不支持|未知参数/i.test(error.message);
}

module.exports = { REQUIRED_FIELDS, resolveExpressions, createResponseFormat, validatePayload, invalidOutput, unsupportedResponseFormat };
