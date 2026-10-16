const { nativeImage, net, session } = require("electron");
const { loadConfig } = require("./config");
const { buildSystemPrompt } = require("./prompt");
const { loadExpressionNames } = require("./live2dCatalog");
const { extractChatPayload } = require("./parseChatText");
const path = require("path");
const { captureFullscreenToJpg } = require("./screenshot");
const { compareWithPrevious } = require("./screenChange");
const memory = require("./memory");
const fs = require("fs");

function normalizeEndpoint(endpoint) {
  const base = String(endpoint || "").replace(/\/+$/, "");
  if (base.endsWith("/chat/completions")) return base;
  return `${base}/chat/completions`;
}

function imageToBase64Jpeg(filePath, maxWidth = 1920, quality = 25) {
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

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 800;
const OPENAI_LOG_PATH = path.join(__dirname, "../logs/openai.jsonl");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function appendOpenAiLog(entry) {
  try {
    fs.mkdirSync(path.dirname(OPENAI_LOG_PATH), { recursive: true });
    fs.appendFileSync(
      OPENAI_LOG_PATH,
      `${JSON.stringify(entry)}\n`,
      "utf8",
    );
  } catch (err) {
    console.warn(
      "[ai:log] write failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

function isRetryableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

function isRetryableError(err) {
  if (!err) return false;
  const msg = String(err.message || err);
  if (/非 JSON|ERR_|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket|network|fetch failed/i.test(msg)) {
    return true;
  }
  if (typeof err.status === "number") return isRetryableStatus(err.status);
  return false;
}

/**
 * @param {string} url
 * @param {RequestInit} init
 * @param {{ maxRetries?: number, label?: string }} [opts]
 */
async function fetchChatJson(url, init, opts = {}) {
  const maxRetries =
    Number.isFinite(opts.maxRetries) && opts.maxRetries >= 0
      ? Math.floor(opts.maxRetries)
      : MAX_RETRIES;
  const label = opts.label || "api";
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await net.fetch(url, init);
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        appendOpenAiLog({
          t: new Date().toISOString(),
          label,
          ok: false,
          status: res.status,
          body: text.slice(0, 4000),
        });
        const err = new Error(
          `API 返回非 JSON (${res.status}): ${text.slice(0, 200)}`,
        );
        err.status = res.status;
        throw err;
      }
      if (!res.ok) {
        appendOpenAiLog({
          t: new Date().toISOString(),
          label,
          ok: false,
          status: res.status,
          body: data,
        });
        const err = new Error(
          `API ${res.status}: ${data?.error?.message || text.slice(0, 200)}`,
        );
        err.status = res.status;
        throw err;
      }
      appendOpenAiLog({
        t: new Date().toISOString(),
        label,
        ok: true,
        status: res.status,
        content: messageContentToText(
          data?.choices?.[0]?.message?.content,
        ).trim(),
        body: data,
      });
      return data;
    } catch (err) {
      lastError = err;
      const canRetry = attempt < maxRetries && isRetryableError(err);
      if (!canRetry) throw err;
      const delay = RETRY_BASE_MS * (attempt + 1);
      console.warn(
        `[${label}] attempt ${attempt + 1}/${maxRetries + 1} failed, retry in ${delay}ms:`,
        err instanceof Error ? err.message : err,
      );
      await sleep(delay);
    }
  }

  throw lastError;
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

  const data = await fetchChatJson(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${ai.apiKey}`,
      },
      body: JSON.stringify(body),
    },
    { label: "ai:text" },
  );

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

function buildRequestBody(ai, systemPrompt, base64, opts = {}) {
  const maxTokens = Number(ai.max_tokens) > 0 ? Number(ai.max_tokens) : 1024;
  const nowStamp = formatNowStamp();
  const tip =
    opts.kind === "region"
      ? "这是前辈框选的屏幕区域截图"
      : "这是前辈现在的桌面截图";
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
            text: `[当前时间 ${nowStamp}] ${tip}。请只返回 JSON：{"expression":"...","response":"...","screenSummary":"..."}`,
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
 * @param {{ trigger?: string, afterScreenshot?: () => void, imagePath?: string }} [options]
 */
async function chatAboutScreen(options = {}) {
  const config = loadConfig();
  const { ai, character } = config;
  if (!ai?.endpoint || !ai?.apiKey || !ai?.model) {
    throw new Error("config.ai 缺少 endpoint / apiKey / model");
  }

  const expressions = loadExpressionNames({ includeInternal: false });
  await applyProxy(ai.proxy);

  const trigger = options.trigger || "";
  const isRegion = Boolean(options.imagePath) || trigger === "region";
  let shot;
  let change = { distance: -1, threshold: 0 };

  if (options.imagePath) {
    const imagePath = options.imagePath;
    if (!fs.existsSync(imagePath)) {
      throw new Error(`截图不存在: ${imagePath}`);
    }
    shot = {
      path: imagePath,
      filename: path.basename(imagePath),
    };
    // 框选强制送模，仍更新哈希避免下一轮 interval 误判
    change = compareWithPrevious(shot.path, { force: true, config });
  } else {
    shot = await captureFullscreenToJpg();
    // interval 轮询才判变；点击 / 启动等强制反应
    const force = trigger !== "interval";
    change = compareWithPrevious(shot.path, { force, config });
    if (!change.changed) {
      try {
        fs.unlinkSync(shot.path);
      } catch {
        // ignore
      }
      return {
        skipped: true,
        reason: "screen_unchanged",
        distance: change.distance,
        threshold: change.threshold,
        screenshotPath: shot.path,
        screenshotFilename: shot.filename,
      };
    }
  }

  // 仅截图成功且确认要聊时，才让头顶出现气泡
  if (typeof options.afterScreenshot === "function") {
    options.afterScreenshot();
  }

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

  const body = buildRequestBody(ai, systemPrompt, base64, {
    kind: isRegion ? "region" : "fullscreen",
  });
  let response = "";
  let expression = "neutral";
  let screenSummary = "";
  let raw = "";
  let lastParseError = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const data = await fetchChatJson(
        url,
        {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        },
        { maxRetries: 0, label: "ai:vision" },
      );

      raw = messageContentToText(data?.choices?.[0]?.message?.content).trim();
      const parsed = extractChatPayload(raw, expressions);
      response = (parsed.response || "").trim();
      expression = parsed.expression || "neutral";
      screenSummary = (parsed.screenSummary || "").trim();

      if (!response && raw.trim()) {
        const lines = raw.trim().split(/\r?\n/);
        if (
          lines.length === 1 &&
          !isLikelyExpressionOnly(lines[0], expressions)
        ) {
          response = lines[0].trim();
          expression = "neutral";
        }
      }

      if (!response) {
        throw new Error(
          'API 未返回有效台词（需要 JSON：{"expression":"...","response":"...","screenSummary":"..."}）',
        );
      }
      lastParseError = null;
      break;
    } catch (err) {
      lastParseError = err;
      const canRetry =
        attempt < MAX_RETRIES &&
        (isRetryableError(err) ||
          /未返回有效台词/.test(String(err?.message || "")));
      if (!canRetry) throw err;
      const delay = RETRY_BASE_MS * (attempt + 1);
      console.warn(
        `[ai:vision] attempt ${attempt + 1}/${MAX_RETRIES + 1} failed, retry in ${delay}ms:`,
        err instanceof Error ? err.message : err,
      );
      await sleep(delay);
    }
  }

  if (!response) {
    throw (
      lastParseError ||
      new Error(
        'API 未返回有效台词（需要 JSON：{"expression":"...","response":"...","screenSummary":"..."}）',
      )
    );
  }

  // Short-term is sync so the next chat sees this turn immediately.
  memory.recordTurn(
    {
      reply: response,
      expression,
      screenSummary,
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
    skipped: false,
    reply: response,
    expression,
    screenSummary,
    raw,
    distance: change.distance,
    threshold: change.threshold,
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
