function validateProfilePlan(plan, profiles) {
  if (!plan || !Array.isArray(plan.merge) || !Array.isArray(plan.archive)) throw new Error("人物画像整理结构无效");
  const known = new Map(profiles.map((profile) => [profile.id, profile]));
  const used = new Set();
  const claim = (id) => {
    if (typeof id !== "string" || !known.has(id) || used.has(id)) throw new Error("画像整理引用了未知或重复的记录");
    used.add(id);
    return known.get(id);
  };
  const text = (value, max) => {
    if (typeof value !== "string" || !value.trim() || value.trim().length > max) throw new Error("画像整理内容无效");
    return value.trim();
  };
  const merge = plan.merge.map((item) => {
    if (!item || !Array.isArray(item.sourceIds) || item.sourceIds.length < 2) throw new Error("合并画像至少需要两条原始记录");
    const sources = item.sourceIds.map(claim);
    const first = sources[0];
    if (sources.some((p) => p.entityId !== first.entityId || p.field !== first.field)) throw new Error("不能合并不同对象或字段的画像");
    if (typeof item.scope !== "string" || item.scope.length > 120 || !sources.some((p) => p.scope === item.scope) ||
        sources.some((p) => Boolean(p.scope) !== Boolean(item.scope))) throw new Error("画像合并范围无效，不能混合全局与项目画像");
    const value = text(item.value, 600);
    if (sources.some((p) => p.basis === "user_answer" && (p.value !== value || p.scope !== item.scope))) throw new Error("整理不能改写用户确认的画像");
    if (!sources.some((p) => p.basis === "user_answer") && sources.some((p) => p.basis === "inference") &&
        sources.some((p) => p.basis === "observation" && p.value !== value)) throw new Error("整理不能将猜测升级为已观察的画像");
    return { sourceIds: [...item.sourceIds], scope: item.scope, value, reason: text(item.reason, 300) };
  });
  const archive = plan.archive.map((item) => {
    if (!item) throw new Error("画像归档字段无效");
    const source = claim(item.id);
    if (source.basis === "user_answer") throw new Error("整理不能归档用户确认的画像");
    return { id: item.id, reason: text(item.reason, 300) };
  });
  const targets = new Set();
  for (const item of merge) {
    const first = known.get(item.sourceIds[0]);
    const key = JSON.stringify([first.entityId, first.field, item.scope]);
    if (targets.has(key) || profiles.some((p) => p.entityId === first.entityId && p.field === first.field && p.scope === item.scope && !used.has(p.id))) {
      throw new Error("合并后的画像与其他当前关系冲突");
    }
    targets.add(key);
  }
  return { merge, archive };
}

module.exports = { validateProfilePlan };
