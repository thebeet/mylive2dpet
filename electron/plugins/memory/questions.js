const { randomUUID } = require("node:crypto");
const { fingerprint } = require("./records");

// The popup consumes free-form topics, never predefined profile fields.
function createQuestionService({ repository, available, request, now = Date.now, notify = () => {} }) {
  const repo = () => { if (!available()) throw new Error("记忆服务已停止或关闭"); return repository(); };
  const all = () => repo().state("questions", []);
  function getQuestion(id) { const q = all().find(q => q.id === id); if (!q) throw new Error("问题已删除"); return q; }
  function mutate(id, operation) {
    const r = repo(), questions = r.state("questions", []), q = questions.find(q => q.id === id);
    if (!q) throw new Error("问题已删除");
    operation(q); r.setState("questions", questions); notify(); return { ok: true };
  }
  function deleteQuestion(id) {
    const q = getQuestion(id), r = repo();
    r.setState("dismissedQuestions", [...new Set([...r.state("dismissedQuestions", []), fingerprint(q.prompt)])]);
    r.setState("questions", all().filter(q => q.id !== id)); notify(); return { ok: true };
  }
  return {
    snapshot: () => ({ questions: all() }), getQuestion,
    nextQuestion(config = {}) {
      const r = repo(), questions = all(), today = new Date(now()).toDateString();
      const shown = questions.flatMap(q => q.answers || []).filter(a => a.outcome === "shown" && new Date(a.createdAt).toDateString() === today).length;
      const lastShown = Math.max(0, ...questions.map(q => q.lastShownAt || 0));
      if (!config.manual && (config.dailyLimit > 0 && shown >= config.dailyLimit || now() - lastShown < (config.cooldownMs || 0) || now() < r.state("questionsPausedUntil", 0))) return null;
      return questions.find(q => q.status === "pending" && q.nextAt <= now()) || null;
    },
    markShown: id => mutate(id, q => { q.lastShownAt = now(); q.answers.push({ id: randomUUID(), outcome: "shown", value: "", createdAt: now() }); }),
    answer(id, input = {}, config = {}) {
      const q = getQuestion(id);
      if (q.status !== "pending") throw new Error("问题已处理");
      const action = input.action || "answer";
      if (!["answer", "unknown", "skip", "defer", "remove"].includes(action)) throw new Error("回答操作无效");
      if (action === "remove") return deleteQuestion(id);
      const value = input.text ?? q.options[input.optionIndex]?.value;
      if (action === "answer" && (typeof value !== "string" || !value.trim() || value.length > 600)) throw new Error("回答内容无效");
      const r = repo(), answerSourceId = randomUUID();
      if (action === "answer") r.ingest({ id: answerSourceId, source: "user-answer", role: "user", text: value.trim(), metadata: { questionId: id, question: q.prompt, topic: q.topic } });
      const result = mutate(id, q => {
        q.answers.push({ id: randomUUID(), value: action === "answer" ? value.trim() : "", outcome: action, createdAt: now() });
        if (action === "answer") { q.status = "answered"; q.evidence = [...(q.evidence || []), { sourceId: answerSourceId, quote: value.trim() }]; }
        else if (action === "remove") q.status = "dismissed";
        else { q.skips += action === "defer" ? 0 : 1; q.status = q.skips >= (config.maxSkips || 3) ? "dismissed" : "pending"; q.nextAt = now() + (config.deferMs || 1800000) * 2 ** q.skips; }
      });
      request(); return result;
    },
    deleteQuestion,
    deleteAnswer(questionId, answerId) { return mutate(questionId, q => { q.answers = q.answers.filter(a => a.id !== answerId); }); },
    attention() { const r = repo(); return { audioUntil: r.state("audioUntil", 0), meetingUntil: r.state("meetingUntil", 0), questionsPausedUntil: r.state("questionsPausedUntil", 0) }; },
    pauseQuestions(until) { if (!Number.isFinite(until) || until < 0) throw new Error("暂停时间无效"); repo().setState("questionsPausedUntil", until); },
  };
}
module.exports = { createQuestionService };
