const promptExtension = {
  text: [
    "视觉摘要字段：summaries.screen 与 summaries.work，均为字符串。只总结本轮图片，不复述历史画面，不对用户说出摘要。",
    "summaries.screen：当前截图内容的简短客观总结（1～2 句），不要写成台词语气。",
    "summaries.work（历史字段名）：描述本轮可辨认、可能有助于后续陪伴的活动线索。适用于观看、游戏、学习、社交、工作等场景，不默认用户在开发软件。保留明确名称、可见进度、参与者、时间和必要上下文，不强行套用项目或人物模板。",
    "work 最多 6 句；看不清或没有有用线索则为空。区分内容作者、角色、聊天发言者与查看者，不把画面里的‘我’或角色台词直接归给用户；不猜测偏好、身份、画面之外的进度或后续剧情。",
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
