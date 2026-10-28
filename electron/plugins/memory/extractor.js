/**
 * Extract durable facts from recent pet lines for long-term JSONL storage.
 */

function getDefaults() {
  return {
    extractEveryNTurns: 3,
    maxTokens: 256,
  };
}

/**
 * @param {object} cfg
 */
function shouldExtract(cfg = {}, pendingTurns = 0) {
  const every = Math.max(
    1,
    Number(cfg.extractEveryNTurns) || getDefaults().extractEveryNTurns,
  );
  return pendingTurns >= every;
}

/**
 * @param {string} raw
 * @returns {{ type: string, text: string, tags: string[], importance: number }[]}
 */
function parseFactsJson(raw) {
  const text = String(raw || "").trim();
  if (!text) throw new Error("事实提取返回空内容");

  let jsonText = text;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) jsonText = fenced[1].trim();

  const start = jsonText.indexOf("[");
  const end = jsonText.lastIndexOf("]");
  if (start >= 0 && end > start) {
    jsonText = jsonText.slice(start, end + 1);
  }

  let arr;
  try {
    arr = JSON.parse(jsonText);
  } catch {
    throw new Error("事实提取返回无效 JSON");
  }
  if (!Array.isArray(arr)) throw new Error("事实提取必须返回 JSON 数组");

  /** @type {{ type: string, text: string, tags: string[], importance: number }[]} */
  const out = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const factText = String(item.text || "").trim();
    if (!factText || factText.length < 4) continue;
    const type = ["fact", "preference", "event"].includes(item.type)
      ? item.type
      : "fact";
    const tags = Array.isArray(item.tags)
      ? item.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 6)
      : [];
    let importance = Number(item.importance);
    if (!Number.isFinite(importance)) importance = 2;
    importance = Math.min(5, Math.max(1, Math.round(importance)));
    out.push({ type, text: factText, tags, importance });
  }
  return out.slice(0, 5);
}

/**
 * @param {{
 *   turnsText: string,
 *   callChat: (messages: object[], opts?: object) => Promise<string>,
 *   maxTokens?: number,
 * }} args
 */
async function extractWithLlm(args) {
  const { turnsText, callChat, maxTokens } = args;
  if (!turnsText.trim()) return [];

  const messages = [
    {
      role: "system",
      content:
        "你从桌面宠物的近期独白中抽取值得长期记住的信息。" +
        "只输出 JSON 数组，不要其它文字。每项：" +
        '{"type":"fact|preference|event","text":"简洁中文事实","tags":["关键词"],"importance":1-5}。' +
        "规则：只记跨会话仍有用的偏好、习惯、身份、进行中的事；" +
        "不要记一次性吐槽、纯画面描写、不确定猜测；" +
        "设备音频是外部应用播放的内容，禁止把其中的第一人称、身份或偏好归到用户身上；最多 5 条；无则 []。",
    },
    {
      role: "user",
      content: `【近期独白】\n${turnsText}\n\n请输出 JSON 数组：`,
    },
  ];

  const raw = await callChat(messages, {
    max_tokens: maxTokens || getDefaults().maxTokens,
    temperature: 0.2,
  });
  return parseFactsJson(raw);
}

module.exports = {
  getDefaults,
  shouldExtract,
  parseFactsJson,
  extractWithLlm,
};
