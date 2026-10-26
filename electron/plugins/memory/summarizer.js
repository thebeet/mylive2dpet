/**
 * Rolling session summary — compresses older short-term turns into one paragraph.
 */

function getDefaults() {
  return {
    enabled: true,
    everyNTurns: 6,
    keepTurnsAfterSummary: 3,
    maxTokens: 256,
  };
}

/**
 * @param {object} cfg
 * @param {number} pendingTurns
 * @param {number} shortTermLen
 */
function shouldSummarize(cfg, pendingTurns, shortTermLen) {
  const merged = { ...getDefaults(), ...cfg };
  if (merged.enabled === false) return false;
  const every = Math.max(2, Number(merged.everyNTurns) || 6);
  if (pendingTurns >= every) return true;
  // Buffer nearly full — fold early so we don't lose context on prune.
  if (shortTermLen >= every + Number(merged.keepTurnsAfterSummary)) {
    return true;
  }
  return false;
}

/**
 * @param {{
 *   previousSummary: string,
 *   turnsText: string,
 *   callChat: (messages: object[], opts?: object) => Promise<string>,
 *   maxTokens?: number,
 * }} args
 */
async function summarizeWithLlm(args) {
  const { previousSummary, turnsText, callChat, maxTokens } = args;
  if (!turnsText.trim()) return previousSummary;

  const messages = [
    {
      role: "system",
      content:
        "你是桌面宠物的记忆整理助手。把近期独白压成简洁会话摘要，供后续对话保持连贯。" +
        "只输出摘要正文，不要标题、不要列表符号、不要 JSON。2～4 句中文。" +
        "保留：用户在做什么、宠物提过的具体事实/偏好、未完结的话题线索。" +
        "丢掉：纯寒暄、重复吐槽、过时且已被新内容取代的画面细节。" +
        "设备音频来自外部应用播放，不代表用户本人说的话；摘要必须保留这个来源，不得据此推断用户身份或偏好。",
    },
    {
      role: "user",
      content: [
        previousSummary
          ? `【已有摘要】\n${previousSummary}\n`
          : "【已有摘要】\n（无）\n",
        `【近期独白】\n${turnsText}\n`,
        "请输出更新后的会话摘要：",
      ].join("\n"),
    },
  ];

  const raw = await callChat(messages, {
    max_tokens: maxTokens || getDefaults().maxTokens,
    temperature: 0.3,
  });
  return String(raw || "")
    .trim()
    .replace(/^["']|["']$/g, "");
}

function createSummarizer() {
  let summary = "";
  return {
    get: () => summary,
    set: (text) => { summary = String(text || "").trim(); },
    clear: () => { summary = ""; },
    shouldSummarize,
    summarizeWithLlm,
  };
}

module.exports = { getDefaults, createSummarizer };
