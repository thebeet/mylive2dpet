const promptExtension = {
  text: [
    "视觉摘要字段：summaries.screen 与 summaries.work，均为字符串。只总结本轮图片，不复述历史画面，不对用户说出摘要。",
    "summaries.screen：当前截图内容的简短客观总结（1～2 句），不要写成台词语气。",
    "summaries.work：仅描述当前截图中可见的工作信息。飞书聊天保留可辨认的会话、作者、被引用者和分工；文档保留项目、人物、职责、决策、任务、日期和上下文。",
    "work 最多 6 句；看不清或没有工作信息则为空。区分聊天作者、文档作者与查看者，不把截图里的‘我’直接归给用户；不加入人物猜测。",
    "本轮没有图片时，省略 summaries.screen 和 summaries.work，不返回空字符串或 null 占位。",
  ].join("\n"),
  summarySchemas: { screen: { type: "string" }, work: { type: "string" } },
  selectSummaryFields({ observations }) {
    return observations.some(({ content }) => content.some(({ type }) => type === "image")) ? ["screen", "work"] : [];
  },
  validateSummaries(summaries, { observations }) {
    const hasImages = observations.some(({ content }) => content.some(({ type }) => type === "image"));
    if (!hasImages && (Object.hasOwn(summaries, "screen") || Object.hasOwn(summaries, "work"))) {
      throw new Error("没有图片时必须省略 summaries.screen 和 summaries.work");
    }
  },
};

module.exports = { promptExtension };
