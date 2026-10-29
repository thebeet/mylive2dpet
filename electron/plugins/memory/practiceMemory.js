const { createPracticeStore } = require('./practiceStore');
const { planPractice } = require('./practicePlanner');

function createPracticeMemory(context, { options, now = Date.now, isAvailable }) {
  let store = null;
  let database = null;
  const available = () => isAvailable() && options().enabled && options().practice.enabled;
  function repository() {
    const storage = context.services.get(options().storageService);
    if (!storage) throw new Error('项目与经验记忆存储不可用');
    if (!store || database !== storage) { store = createPracticeStore(storage, { now }); database = storage; }
    return store;
  }
  function ingestObservation(observation) {
    if (!available()) return;
    const source = observation.role === 'user' ? 'user' : observation.source;
    const text = (observation.content || []).filter(p => p.type === 'text').map(p => p.text).join('\n');
    repository().ingest({ id: observation.id, source, text, capturedAt: observation.capturedAt,
      metadata: { ...observation.metadata, role: observation.role } });
  }
  function ingestDecision(event) {
    if (!available()) return;
    for (const [i, observation] of (event.observations || []).entries()) {
      ingestObservation({ ...observation, id: observation.id || `${event.id || 'decision'}:input:${i}` });
    }
    const screen = event.result?.summaries?.work || event.result?.summaries?.screen;
    const shots = (event.observations || []).filter(o => o.content.some(p => p.type === 'image'));
    if (screen && shots.length) repository().ingest({ id: `screen:${event.id}`, source: 'screen', text: screen,
      capturedAt: shots.at(-1).capturedAt || event.completedAt || now(),
      metadata: { decisionId: event.id, observationIds: shots.map(o=>o.id) } });
  }
  function due() {
    if (!available()) return false;
    const sources = repository().sources();
    return sources.length > 0 && (sources.length >= options().practice.extractEveryNObservations ||
      now() - Math.min(...sources.map(s=>s.capturedAt)) >= options().practice.flushAfterMs);
  }
  async function maintain({ callChat, valid }) {
    if (!due()) return;
    const repo = repository(), storage = database;
    const snapshot = repo.snapshot(), sources = repo.sources();
    const plan = await planPractice({ snapshot, sources, callChat, maxTokens: options().practice.maxTokens });
    if (!valid() || !available() || context.services.get(options().storageService) !== storage) return;
    return repo.apply(plan, snapshot, sources);
  }
  return { ingestObservation, ingestDecision, due, maintain,
    organizationSnapshot: () => options().practice.enabled ? { ...repository().snapshot(), sources: repository().sources() } : undefined,
    organize: (plan, snapshot) => repository().apply(plan, { projects: snapshot.projects, lessons: snapshot.lessons }, snapshot.sources),
    context: query => available() ? repository().context(query, options().practice) : [],
    snapshot() {
      const storage = context.services.get(options().storageService);
      if (!options().practice.enabled && (typeof storage?.prepare !== "function" || !storage.prepare("SELECT 1 FROM sqlite_master WHERE name='memory_practice_entries'").get())) {
        return { enabled: false, projects: [], lessons: [], sources: [], history: [], pending: 0 };
      }
      const repo = repository();
      return { enabled: options().practice.enabled, ...repo.snapshot(), sources: repo.sources(false), history: repo.history(),
        pending: repo.sources().length, staleAfterMs: options().practice.staleAfterMs };
    },
    clear() {
      const storage = context.services.get(options().storageService);
      if (typeof storage?.prepare === "function" && storage.prepare("SELECT 1 FROM sqlite_master WHERE name='memory_practice_entries'").get()) repository().clear();
    },
  };
}
module.exports = { createPracticeMemory };
