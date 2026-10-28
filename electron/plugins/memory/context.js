const LABELS = { screen: "画面", audio: "设备音频", work: "工作观察" };

function formatRecentDialogue(turns) {
  return turns.map((turn) => {
    const date = new Date(turn.t);
    const stamp = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    const expression = turn.expression ? ` (${turn.expression})` : "";
    return [
      turn.userMessage ? `[${stamp}] 用户：${turn.userMessage}` : "",
      turn.reply ? `[${stamp}]${expression} ${turn.reply}` : `[${stamp}] 静默观察`,
      ...Object.entries(turn.summaries || {})
        .filter(([, text]) => text.trim())
        .map(([source, text]) => `  ${LABELS[source] || source}：${text}`),
    ].filter(Boolean).join("\n");
  }).join("\n");
}

function buildContextBlocks({ longTermMemory = "", sessionSummary = "", recentDialogue = "" }) {
  return [
    { id: "long-term-memory", title: "长期记忆", text: longTermMemory },
    { id: "session-summary", title: "会话摘要", text: sessionSummary },
    { id: "recent-dialogue", title: "近期对话", text: recentDialogue },
  ].filter(({ text }) => text.trim());
}

module.exports = { formatRecentDialogue, buildContextBlocks };
