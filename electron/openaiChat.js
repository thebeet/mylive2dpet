const { nativeImage, net, session } = require("electron");
const { loadConfig } = require("./config");
const { buildSystemPrompt } = require("./prompt");
const { loadExpressionNames } = require("./live2dCatalog");
const { extractChatPayload } = require("./parseChatText");
const { captureFullscreenToJpg } = require("./screenshot");
const memory = require("./memory");

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

function messageContentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part.text === "string") return part.text;
        return "";
      })
      .join("");
  }
  return "";
}

/**
 * Lightweight text-only chat/completions call (memory summary / extract).
 * Uses current config endpoint; does not touch short-term memory.
 * @param {object[]} messages
 * @param {{ max_tokens?: number, temperature?: number }} [opts]
 */
async function callChatCompletions(messages, opts = {}) {
  const config = loadConfig();
  const { ai } = config;
  if (!ai?.endpoint || !ai?.apiKey || !ai?.model) {
    throw new Error("config.ai 缺少 endpoint / apiKey / model");
  }

  await applyProxy(ai.proxy);
  const url = normalizeEndpoint(ai.endpoint);
  const maxTokens =
    Number(opts.max_tokens) > 0
      ? Number(opts.max_tokens)
      : Number(ai.max_tokens) > 0
        ? Number(ai.max_tokens)
        : 256;

  const body = {
    model: ai.model,
    temperature:
      typeof opts.temperature === "number" ? opts.temperature : 0.3,
    max_tokens: maxTokens,
    stream: false,
    messages,
  };

  const res = await net.fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${ai.apiKey}`,
    },
    body: JSON.stringify(body),
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

  return messageContentToText(data?.choices?.[0]?.message?.content).trim();
}

function formatNowStamp(date = new Date()) {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const h = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  const s = String(date.getSeconds()).padStart(2, "0");
  const weekdays = ["日", "一", "二", "三", "四", "五", "六"];
  const w = weekdays[date.getDay()];
  return `${y}-${mo}-${d} 周${w} ${h}:${mi}:${s}`;
}

function buildRequestBody(ai, systemPrompt, base64) {
  const maxTokens = Number(ai.max_tokens) > 0 ? Number(ai.max_tokens) : 1024;
  const nowStamp = formatNowStamp();
  return {
    model: ai.model,
    temperature: 0.8,
    max_tokens: maxTokens,
    stream: false,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `[当前时间 ${nowStamp}] 这是前辈现在的桌面截图。请只返回 JSON：{"expression":"...","response":"..."}`,
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

/**
 * @param {{ trigger?: string }} [options]
 */
async function chatAboutScreen(options = {}) {
  const config = loadConfig();
  const { ai, character } = config;
  if (!ai?.endpoint || !ai?.apiKey || !ai?.model) {
    throw new Error("config.ai 缺少 endpoint / apiKey / model");
  }

  const expressions = loadExpressionNames({ includeInternal: false });
  await applyProxy(ai.proxy);

  const shot = await captureFullscreenToJpg();
  const base64 = imageToBase64Jpeg(shot.path);
  const memorySections = memory.buildPromptSections(config);
  const systemPrompt = buildSystemPrompt(character, {
    expressions,
    memory: memorySections,
  });
  const url = normalizeEndpoint(ai.endpoint);
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    Authorization: `Bearer ${ai.apiKey}`,
  };

  const body = buildRequestBody(ai, systemPrompt, base64);
  const res = await net.fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
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

  const raw = messageContentToText(data?.choices?.[0]?.message?.content).trim();
  const parsed = extractChatPayload(raw, expressions);
  let response = (parsed.response || "").trim();
  let expression = parsed.expression || "neutral";

  if (!response && raw.trim()) {
    const lines = raw.trim().split(/\r?\n/);
    if (lines.length === 1 && !isLikelyExpressionOnly(lines[0], expressions)) {
      response = lines[0].trim();
      expression = "neutral";
    }
  }

  if (!response) {
    throw new Error(
      'API 未返回有效台词（需要 JSON：{"expression":"...","response":"..."}）',
    );
  }

  // Short-term is sync so the next chat sees this turn immediately.
  memory.recordTurn(
    {
      reply: response,
      expression,
      trigger: options.trigger || "",
    },
    config,
  );
  // Summary / long-term extract are async and must not block TTS.
  void memory
    .maintain({ config, callChat: callChatCompletions })
    .catch((err) => {
      console.warn(
        "[memory] maintain failed:",
        err instanceof Error ? err.message : err,
      );
    });

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

module.exports = { chatAboutScreen, callChatCompletions };
