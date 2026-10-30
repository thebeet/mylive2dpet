const { observationError } = require("../architecture/failures");
const { createResponseFormat } = require("./output");

function formatNowStamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  const weekday = "日一二三四五六"[date.getDay()];
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} 周${weekday} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Convert generic observations into this provider's supported text/image inputs. */
function prepareObservations(observations, encodeImage) {
  return observations.map((observation) => ({
    ...observation,
    content: observation.content.map((part) => {
      if (part.type === "text") return part;
      if (part.type !== "image") {
        throw observationError(`AI 对话插件不支持内容类型: ${part.type}`, observation.id);
      }
      if (part.uri && /^(https?:|data:image\/)/i.test(part.uri)) return part;
      if (!part.path) throw observationError("图片观察缺少本地路径或图片 URL", observation.id);
      try {
        return { ...part, uri: `data:image/jpeg;base64,${encodeImage(part.path)}` };
      } catch (error) {
        throw observationError(`无法读取图片观察: ${part.path}`, observation.id, error);
      }
    }),
  }));
}

function formatContext(context) {
  return `# 补充上下文\n\n${context.map(({ title, text }) => `## ${title}\n${text}`).join("\n\n")}`;
}

function buildRequestBody(ai, systemPrompt, observations, context = [], history = {}, expressions = []) {
  const content = [{
    type: "text",
    text: `[当前时间 ${formatNowStamp()}；本轮输入 ${observations.length} 条]`,
  }];

  if (context.length) {
    content.push({ type: "text", text: formatContext(context) });
  }
  content.push({ type: "text", text: "# 本次输入" });

  observations.forEach((observation, index) => {
    const stamp = observation.capturedAt
      ? formatNowStamp(new Date(observation.capturedAt)) : "时间未知";
    content.push({
      type: "text",
      text: `[观察 ${index + 1}/${observations.length}；${stamp}；source=${observation.source}；role=${observation.role || "context"}]\n${JSON.stringify({ metadata: observation.metadata || {} })}`,
    });
    for (const part of observation.content) {
      if (part.type === "text") {
        content.push({ type: "text", text: JSON.stringify({ text: part.text }) });
      } else if (part.type === "image") {
        if (!part.uri) throw new Error("图片观察尚未编码");
        content.push({ type: "image_url", image_url: { url: part.uri } });
      } else {
        throw new Error(`AI 对话插件不支持内容类型: ${part.type}`);
      }
    }
  });

  return {
    model: ai.model,
    temperature: 0.8,
    max_tokens: Number(ai.max_tokens) > 0 ? Number(ai.max_tokens) : 1024,
    stream: false,
    ...(ai.outputFormat === "prompt" ? {} : { response_format: createResponseFormat(ai.outputFormat, expressions) }),
    messages: [{ role: "system", content: systemPrompt },
      ...(history.prefix || []), ...(history.messages || []), { role: "user", content }],
  };
}

module.exports = { buildRequestBody, prepareObservations, formatContext };

