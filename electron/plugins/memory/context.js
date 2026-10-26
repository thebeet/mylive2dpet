const LABELS = { screen: "画面", audio: "设备音频" };

function formatRecentDialogue(turns) {
  return turns.map((turn) => {
    const date = new Date(turn.t);
    const stamp = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    const expression = turn.expression ? ` (${turn.expression})` : "";
    return [
      turn.userMessage ? `[${stamp}] 用户：${turn.userMessage}` : "",
      `[${stamp}]${expression} ${turn.reply}`,
      ...Object.entries(turn.summaries || {})
        .filter(([, text]) => text.trim())
        .map(([source, text]) => `  ${LABELS[source] || source}：${text}`),
    ].filter(Boolean).join("\n");
  }).join("\n");
}

function buildContextBlocks({ longTermMemory = "", sessionSummary = "", recentDialogue = "" }) {
  const blocks = [
    { id: "long-term-memory", title: "长期记忆", text: longTermMemory },
    { id: "session-summary", title: "会话摘要", text: sessionSummary },
    { id: "recent-dialogue", title: "近期对话", text: recentDialogue },
  ].filter(({ text }) => text.trim());
  if (blocks.length) blocks.push({
    id: "memory-guidance",
    title: "记忆使用说明",
    text: "近期对话中标记为「用户」的内容是用户手动输入，「画面：」和「设备音频：」是当时的观察摘要。请用近期对话保持连贯，不要复述摘要原文。请结合带时间的画面和声音理解上下文，以最新观察为主。不要复述过时细节，也不要编造输入中没有的内容。设备播放的语音可能来自视频、音乐、游戏或其他应用，不代表用户本人说的话、身份或偏好。",
  });
  return blocks;
}

module.exports = { formatRecentDialogue, buildContextBlocks };
