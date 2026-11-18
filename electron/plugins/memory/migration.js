const { timestamp } = require("./records");

// The old schemas are read only for migration and old question history, never for classification.
function migrateLegacy(storage, repository, now = Date.now) {
  if (repository.stats().legacyImported) return;
  const sources = [], entries = [], questions = [];
  const addSource = (prefix, s, { processed = true } = {}) => {
    const id = `legacy:${prefix}:${s.id}`;
    sources.push({ id, source: s.source || "legacy", role: s.role || (s.source === "user" || s.source === "user-correction" || s.source === "user-answer" ? "user" : "context"),
      capturedAt: timestamp(s.capturedAt || s.createdAt, now()), text: s.text || "", metadata: { ...s.metadata, legacyId: s.id }, processed });
    return id;
  };
  function record(prefix, e, body, topics, basis, refs = [], status = "active", historyFor) {
    const id = `legacy:${prefix}:${e.id}`, stamp = timestamp(e.observedAt || e.updatedAt || e.createdAt, now());
    // Synthetic legacy source is explicitly marked: it is a saved memory, not fresh user testimony.
    const sourceId = addSource(`${prefix}-record`, { id: e.id, text: body, capturedAt: stamp, source: "legacy-memory", metadata: { original: e, importedBasis: basis } });
    entries.push({ id, title: e.title || e.name || body.slice(0, 80), text: body, topics: topics.filter(Boolean),
      tags: e.tags || [], aliases: [], links: [], basis, confidence: e.confidence ?? (basis === "inference" ? 0.4 : 0.8),
      importance: e.importance || 3, pinned: false, protected: basis === "user", expiresAt: null,
      evidence: [{ sourceId, quote: body.slice(0, 2000) }, ...refs], status, version: 1, ...(historyFor ? { historyFor } : {}),
      createdAt: stamp, updatedAt: stamp, observedAt: stamp, legacy: { namespace: prefix, id: e.id } });
  }
  const practiceText = e => e.name ? [e.name, e.scope, e.goal, `最后记录状态：${e.status}`,
    ...(e.completed || []), ...(e.pending || []), ...(e.blockers || []), ...(e.nextSteps || [])].filter(Boolean).join("\n")
    : [e.title, e.scope, e.condition, ...(e.steps || []), e.outcome, `原验证状态：${e.status}`].filter(Boolean).join("\n");
  if (storage.hasRepository("memory")) {
    const repo = storage.repository("memory");
    for (const e of repo.list()) record("fact", e, e.text, [], e.metadata?.basis === "user_answer" ? "user" : "inference");
    for (const [i, h] of repo.history().entries()) for (const e of h.originals || []) {
      record("fact-history", { ...e, id: `${i}:${e.id}` }, e.text, [], e.metadata?.basis === "user_answer" ? "user" : "inference", [], "archived", `legacy:fact:${e.id}`);
    }
  }
  if (storage.hasRepository("work-memory")) {
    const repo = storage.repository("work-memory"), snapshot = repo.snapshot();
    const evidence = new Map();
    for (const s of repo.exportEvidence()) evidence.set(s.id, { s, id: addSource("work-source", s, { processed: s.processed }) });
    for (const p of repo.profiles({ includeHistory: true })) {
      const refs = p.evidenceIds.map(id => evidence.get(id)).filter(Boolean).filter(x => x.s.text)
        .map(x => ({ sourceId: x.id, quote: x.s.text.slice(0, 2000) }));
      record("profile", p, `${p.subject.name}${p.scope ? `【${p.scope}】` : ""}：${p.value}`, [],
        p.basis === "user_answer" ? "user" : p.basis === "observation" ? "observation" : "inference", refs, p.status === "active" ? "active" : "archived");
    }
    for (const q of snapshot.questionHistory) questions.push({ ...q, id: `legacy:question:${q.id}`, topic: q.scope || q.subject.name,
      status: q.status === "pending" ? "dismissed" : q.status, evidence: [...evidence.values()].filter(x => x.s.metadata?.questionId === q.id).map(x => ({ sourceId: x.id, quote: x.s.text.slice(0, 2000) })),
      answers: (q.records || []).map(r => ({ id: r.id, value: r.value || "", outcome: r.action, createdAt: r.createdAt })), legacy: true });
  }
  if (storage.hasRepository("memory-practice")) {
    const repo = storage.repository("memory-practice"), snapshot = repo.snapshot(), evidence = new Map();
    const pendingIds = new Set(repo.sources().map(s => s.id));
    for (const s of repo.sources(false)) evidence.set(s.id, { s, id: addSource("practice-source", s, { processed: !pendingIds.has(s.id) }) });
    for (const e of [...snapshot.projects, ...snapshot.lessons]) {
      const body = practiceText(e);
      const refs = (e.sourceIds || []).map(id => evidence.get(id)).filter(Boolean).filter(x => x.s.text)
        .map(x => ({ sourceId: x.id, quote: x.s.text.slice(0, 2000) }));
      record("practice", e, body, [e.name || e.title], "observation", refs);
    }
    for (const [i, h] of repo.history().entries()) if (h.before) {
      record("practice-history", { ...h.before, id: `${i}:${h.entryId}` }, practiceText(h.before), [], "observation", [], "archived", `legacy:practice:${h.entryId}`);
    }
  }
  if (storage.hasRepository("memory-updates")) {
    const repo = storage.repository("memory-updates");
    for (const t of repo.list()) {
      if (t.userMessage) addSource("dialogue", { id: t.id, source: "user", text: t.userMessage, capturedAt: t.t }, { processed: false });
      for (const [key, value] of Object.entries(t.summaries || {})) if (value) addSource(`summary-${key}`, { id: t.id, source: key, text: value, capturedAt: t.t }, { processed: false });
    }
    for (const s of repo.evidence()) addSource("staged", s, { processed: false });
  }
  repository.importLegacy({ sources, entries, questions });
}
function clearLegacy(storage) {
  for (const name of ["memory", "work-memory", "memory-practice", "memory-updates"]) if (storage.hasRepository(name)) storage.repository(name).clear();
}
module.exports = { migrateLegacy, clearLegacy };
