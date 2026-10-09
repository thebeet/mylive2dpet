const { nativeImage, net, session } = require("electron");
const { loadConfig } = require("./config");
const { buildSystemPrompt } = require("./prompt");
const { loadExpressionNames } = require("./live2dCatalog");
const { extractChatPayload } = require("./parseChatText");
const { captureFullscreenToJpg } = require("./screenshot");

function normalizeEndpoint(endpoint) {
  const base = String(endpoint || "").replace(/\/+$/, "");
  if (base.endsWith("/chat/completions")) return base;
  return `${base}/chat/completions`;
}

function imageToBase64Jpeg(filePath, maxWidth = 1280, quality = 25) {
  let image = nativeImage.createFromPath(filePath);
  if (image.isEmpty()) {
    throw new Error(`无法读取截图: ${filePath}`);
  }
  const { width } = image.getSize();
  if (width > maxWidth) {
    image = image.resize({ width: maxWidth, quality: "better" });
  }
  return image.toJPEG(quality).toString("base64");
}

async function applyProxy(proxy) {
  if (!proxy) {
    await session.defaultSession.setProxy({ mode: "direct" });
    return;
  }
  await session.defaultSession.setProxy({
    proxyRules: proxy,
    proxyBypassRules: "<local>",
  });
}

function extractDeltaText(delta) {
  if (!delta) return "";
  if (typeof delta.content === "string") return delta.content;
  if (Array.isArray(delta.content)) {
    return delta.content
      .map((part) => (typeof part === "string" ? part : part?.text || ""))
      .join("");
  }
  return "";
}

function buildRequestBody(ai, systemPrompt, base64, stream) {
  const maxTokens = Number(ai.max_tokens) > 0 ? Number(ai.max_tokens) : 1024;
  return {
    model: ai.model,
    temperature: 0.8,
    max_tokens: maxTokens,
    stream,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "这是前辈现在的桌面截图。请按格式输出：第一行表情名，换行后写 1～2 句台词。",
          },
          {
            type: "image_url",
            image_url: {
              url: `data:image/jpeg;base64,${base64}`,
            },
          },
        ],
      },
    ],
  };
}

async function consumeChatStream(res, onRaw) {
  if (!res.body || typeof res.body.getReader !== "function") {
    throw new Error("NO_STREAM_BODY");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let full = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      let line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      line = line.trimEnd();
      if (!line || line.startsWith(":")) continue;
      if (!line.startsWith("data:")) continue;

      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;

      let json;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }

      const piece = extractDeltaText(json?.choices?.[0]?.delta);
      if (piece) {
        full += piece;
        onRaw(full);
      }
    }
  }

  return full.trim();
}

async function chatNonStream(url, headers, body, onRaw) {
  const payload = { ...body, stream: false };
  const res = await net.fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`API 返回非 JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    throw new Error(
      `API ${res.status}: ${data?.error?.message || text.slice(0, 200)}`,
    );
  }
  const content = data?.choices?.[0]?.message?.content;
  const reply = (typeof content === "string" ? content : "").trim();
  if (reply) onRaw(reply);
  return reply;
}

/**
 * @param {{
 *   onDelta?: (info: { response: string|null, expression: string|null, raw: string }) => void
 * }} [hooks]
 */
async function chatAboutScreen(hooks = {}) {
  const config = loadConfig();
  const { ai, character } = config;
  if (!ai?.endpoint || !ai?.apiKey || !ai?.model) {
    throw new Error("config.ai 缺少 endpoint / apiKey / model");
  }

  const expressions = loadExpressionNames({ includeInternal: false });
  await applyProxy(ai.proxy);

  const shot = await captureFullscreenToJpg();
  const base64 = imageToBase64Jpeg(shot.path);
  const systemPrompt = buildSystemPrompt(character, { expressions });
  const url = normalizeEndpoint(ai.endpoint);
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${ai.apiKey}`,
  };

  const onDelta =
    typeof hooks.onDelta === "function" ? hooks.onDelta : () => {};

  const emitParsed = (raw) => {
    const parsed = extractChatPayload(raw, expressions);
    onDelta({
      response: parsed.response,
      expression: parsed.expression,
      raw,
    });
    return parsed;
  };

  const streamBody = buildRequestBody(ai, systemPrompt, base64, true);

  const res = await net.fetch(url, {
    method: "POST",
    headers: { ...headers, Accept: "text/event-stream" },
    body: JSON.stringify(streamBody),
  });

  if (!res.ok) {
    const text = await res.text();
    let msg = text.slice(0, 200);
    try {
      msg = JSON.parse(text)?.error?.message || msg;
    } catch {
      /* keep */
    }
    throw new Error(`API ${res.status}: ${msg}`);
  }

  let raw = "";
  try {
    raw = await consumeChatStream(res, emitParsed);
  } catch (err) {
    console.warn("stream parse failed, fallback:", err?.message || err);
    const body = { ...streamBody, stream: false };
    raw = await chatNonStream(url, headers, body, emitParsed);
  }

  const parsed = extractChatPayload(raw, expressions);
  let response = (parsed.response || "").trim();
  let expression = parsed.expression || "neutral";

  // 模型偶发未换行：整段当台词
  if (!response && raw.trim()) {
    const lines = raw.trim().split(/\r?\n/);
    if (lines.length === 1 && !isLikelyExpressionOnly(lines[0], expressions)) {
      response = lines[0].trim();
      expression = "neutral";
    }
  }

  if (!response) {
    throw new Error("API 未返回有效台词（需要：第一行表情 + 换行 + 台词）");
  }

  return {
    reply: response,
    expression,
    raw,
    screenshotPath: shot.path,
    screenshotFilename: shot.filename,
  };
}

function isLikelyExpressionOnly(line, allowed) {
  const s = String(line || "").trim();
  if (!s || /\s/.test(s)) return false;
  return allowed.some((e) => e.toLowerCase() === s.toLowerCase());
}

module.exports = { chatAboutScreen };
