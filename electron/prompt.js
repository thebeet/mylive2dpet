/**
 * 根据 config.character 拼出发给多模态模型的 system prompt。
 */
function fillTemplate(text, vars) {
  return String(text || "").replace(/\{\{(\w+)\}\}/g, (_, key) =>
    vars[key] != null ? String(vars[key]) : "",
  );
}

/**
 * @param {{ longTermMemory?: string, sessionSummary?: string, recentDialogue?: string }} memory
 */
function formatMemorySections(memory = {}) {
  const blocks = [];
  if (memory.longTermMemory) {
    blocks.push(`# 长期记忆\n${memory.longTermMemory}`);
  }
  if (memory.sessionSummary) {
    blocks.push(`# 会话摘要\n${memory.sessionSummary}`);
  }
  if (memory.recentDialogue) {
    blocks.push(`# 近期对话\n${memory.recentDialogue}`);
  }
  if (blocks.length === 0) return "";
  blocks.push(
    `# 记忆使用说明\n可参考以上记忆保持话题连贯，但必须以当前截图为准；不要复述已过时的画面细节，不要为了呼应记忆而编造截图中没有的内容。`,
  );
  return blocks.join("\n\n");
}

/**
 * @param {object} character
 * @param {{ expressions?: string[], memory?: { longTermMemory?: string, sessionSummary?: string, recentDialogue?: string } }} [extras]
 */
function buildSystemPrompt(character = {}, extras = {}) {
  const petName = character.name || "Setsuna";
  const userIdentity = character.userIdentity || "后辈";
  const userTerm = character.userTerm || "前辈";
  const language = character.language || "中文";
  const expressions =
    Array.isArray(extras.expressions) && extras.expressions.length > 0
      ? extras.expressions
      : ["neutral", "smile", "thinking"];

  const vars = { petName, userIdentity, userTerm };

  const description = fillTemplate(character.description, vars);
  const personality = fillTemplate(character.personality, vars);
  const scenario = fillTemplate(character.scenario, vars);
  const rules = fillTemplate(character.rules, vars);
  const memoryBlock = formatMemorySections(extras.memory || {});

  return [
    `# 角色`,
    `名字：${petName}`,
    `身份卡：${character.cardName || userIdentity}`,
    `对用户称呼：${userTerm}`,
    `语言：${language}`,
    ``,
    `# 设定`,
    description.trim(),
    ``,
    `# 性格`,
    personality.trim(),
    ``,
    `# 场景`,
    scenario.trim(),
    ``,
    rules.trim(),
    ``,
    memoryBlock,
    ``,
    `# Live2D Expressions`,
    `你说话时会驱动 Live2D 表情。expression 必须是下列之一（精确匹配、区分大小写）：`,
    expressions.join(", "),
    `若不确定，expression 用 neutral。`,
    ``,
    `# 输入说明`,
    `用户消息会附带当前本地时间，以及一张当前桌面截图（JPG）。请根据截图内容，用设定中的语气说 1～2 句；需要时可自然参考时间（昼夜、周末等），不要机械报时。`,
    ``,
    `# 输出格式（必须严格遵守）`,
    `只输出一个 JSON 对象，不要 Markdown、不要代码块、不要其它说明文字。`,
    `字段：`,
    `- expression: string，表情名`,
    `- response: string，要对用户说的中文台词（1～2 句）`,
    ``,
    `正确示例：`,
    `{"expression":"smile","response":"前辈还在写代码呢，终端比人还忙。"}`,
  ]
    .filter((line, i, arr) => !(line === "" && arr[i - 1] === ""))
    .join("\n");
}

module.exports = { buildSystemPrompt, fillTemplate, formatMemorySections };
