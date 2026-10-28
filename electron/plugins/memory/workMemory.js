const { createWorkStore } = require("./workStore");
const { extractWork } = require("./workExtractor");
const EVENTS = require("../../architecture/events");

function createWorkMemory(context, { options, now = Date.now, isAvailable }) {
  let store = null;
  const available = () => isAvailable() && options().enabled && options().work.enabled;
  function repository() {
    if (!options().work.enabled) throw new Error("人物记忆已关闭");
    if (!store) {
      const storage = context.services.get(options().storageService);
      if (!storage) throw new Error("人物记忆存储不可用");
      store = createWorkStore(storage, { now });
    }
    return store;
  }
  function ingestObservation(observation) {
    if (!available()) return;
    const text = observation.content.filter((p) => p.type === "text").map((p) => p.text).join("\n");
    if (!text) return;
    const repo = repository();
    repo.addEvidence({ id: observation.id, source: observation.role === "user" ? "user" : observation.source,
      text, capturedAt: observation.capturedAt, metadata: { ...observation.metadata, role: observation.role } });
    if (observation.source === "audio-output") {
      repo.setState("audioUntil", now() + 45000);
      if (/会议|开会|议程|联调|评审|汇报|同步进度/.test(text)) repo.setState("meetingUntil", now() + 180000);
    }
  }
  function ingestDecision(event) {
    if (!available()) return;
    const repo = repository();
    // Raw text is normally saved on ingress; this also supports alternate providers.
    for (const observation of event.observations) ingestObservation(observation);
    const screen = event.result.summaries?.work || event.result.summaries?.screen;
    if (screen) {
      const shots = event.observations.filter((o) => o.content.some((p) => p.type === "image"));
      repo.addEvidence({ id: `screen:${event.id}`, source: "screen", text: screen,
        capturedAt: shots.at(-1)?.capturedAt || event.completedAt || now(),
        metadata: { decisionId: event.id, observationIds: shots.map((o) => o.id),
          observedFrom: shots[0]?.capturedAt, observedUntil: shots.at(-1)?.capturedAt } });
      if (/飞书会议|腾讯会议|会议进行中|正在开会|Zoom|Microsoft Teams/i.test(screen)) repo.setState("meetingUntil", now() + 180000);
    }
  }
  function due() {
    if (!available()) return false;
    const evidence = repository().pending(options().work.batchSize);
    return evidence.length > 0 && (evidence.length >= options().work.extractEveryNObservations || now() - evidence[0].capturedAt >= options().work.flushAfterMs);
  }
  async function maintain({ callChat, valid, applyMemory }) {
    if (!due()) return;
    const repo = repository(), config = options().work;
    const evidence = repo.pending(config.batchSize);
    const result = await extractWork({ evidence, profiles: repo.profiles(), callChat, maxTokens: config.maxTokens });
    if (!valid() || !available()) return;
    const allowed = new Set(evidence.map((e) => e.id));
    if ((result.facts || []).some((fact) => !Array.isArray(fact.evidenceIds) || !fact.evidenceIds.length || fact.evidenceIds.some((id) => !allowed.has(id)))) throw new Error("长期人物记忆缺少本批来源证据");
    repo.applyExtraction(result, evidence, config, (memory) => applyMemory?.(memory, evidence));
    await context.bus.notify(EVENTS.WORK_MEMORY_UPDATED, {});
    return result;
  }
  const requireAvailable = () => { if (!available()) throw new Error("人物记忆已停止或关闭"); return repository(); };
  const api = {
    snapshot: () => requireAvailable().snapshot(),
    nextQuestion: (config) => requireAvailable().nextQuestion(config),
    getQuestion: (id) => requireAvailable().getQuestion(id),
    markShown: (id) => requireAvailable().markShown(id),
    answer: (id, answer, config) => {
      const result = requireAvailable().answer(id, answer, config);
      void context.bus.notify(EVENTS.WORK_MEMORY_UPDATED, {});
      return result;
    },
    deleteQuestion: (id) => {
      const result = requireAvailable().deleteQuestion(id);
      void context.bus.notify(EVENTS.WORK_MEMORY_UPDATED, {});
      return result;
    },
    deleteAnswer: (questionId, answerId) => {
      const result = requireAvailable().deleteAnswer(questionId, answerId);
      void context.bus.notify(EVENTS.WORK_MEMORY_UPDATED, {});
      return result;
    },
    correctProfile: (id, text) => {
      const result = requireAvailable().correctProfile(id, text);
      void context.bus.notify(EVENTS.WORK_MEMORY_UPDATED, {});
      return result;
    },
    attention: () => {
      const repo = requireAvailable();
      return { audioUntil: repo.getState("audioUntil", 0), meetingUntil: repo.getState("meetingUntil", 0), questionsPausedUntil: repo.getState("questionsPausedUntil", 0) };
    },
    pauseQuestions: (until) => {
      if (!Number.isFinite(until) || until < 0) throw new Error("暂停时间无效");
      requireAvailable().setState("questionsPausedUntil", until);
    },
  };
  return { api, ingestObservation, ingestDecision, due, maintain,
    organizationSnapshot: () => requireAvailable().profiles(),
    organize: (plan, profiles) => requireAvailable().organize(plan, profiles),
    migrateWorkDetails: (longTerm) => requireAvailable().migrateWorkDetails(longTerm),
    context: (query) => available() ? repository().context(query, options().work) : "",
    snapshot: () => options().work.enabled ? { enabled: true, ...repository().snapshot() } : { enabled: false, profiles: [], questions: [], recentEvidence: [], pending: 0 },
    clear: () => {
      if (store) store.clear();
      else {
        const storage = context.services.get(options().storageService);
        if (storage?.prepare("SELECT 1 FROM sqlite_master WHERE name = 'work_evidence'").get()) createWorkStore(storage, { now }).clear();
      }
    },
  };
}

module.exports = { createWorkMemory };
