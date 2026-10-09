/**
 * 根据 config.character 拼出发给多模态模型的 system prompt。
 */
function fillTemplate(text, vars) {
  return String(text || "").replace(/\{\{(\w+)\}\}/g, (_, key) =>
    vars[key] != null ? String(vars[key]) : "",
  );
}

/**
 * @param {object} character
 * @param {{ expressions?: string[] }} [extras]
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
    `# Live2D Expressions`,
    `你说话时会驱动 Live2D 表情。第一行必须是下列表情名之一（精确匹配、区分大小写）：`,
    expressions.join(", "),
    `若不确定，第一行写 neutral。`,
    ``,
    `# 输入说明`,
    `用户消息会附带一张当前桌面截图（JPG）。请根据截图内容，用设定中的语气说 1～2 句。`,
    ``,
    `# 输出格式（必须严格遵守，便于流式显示）`,
    `不要输出 JSON、不要 Markdown、不要代码块、不要前缀说明。`,
    `一共两段，用一个换行隔开：`,
    `第 1 行：表情名（仅一行，不要其它字符）`,
    `第 2 行起：要对用户说的中文台词（1～2 句）`,
    ``,
    `正确示例：`,
    `smile`,
    `前辈还在写代码呢，终端比人还忙。`,
    ``,
    `错误示例：用 JSON、把表情和台词写在同一行、先说话再写表情。`,
  ]
    .filter((line, i, arr) => !(line === "" && arr[i - 1] === ""))
    .join("\n");
}

module.exports = { buildSystemPrompt, fillTemplate };
