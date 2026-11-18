const { randomUUID } = require("node:crypto");
const { workStorage, mockWindows } = require("./workStorage");
const { MessageBus } = require("../../electron/architecture/messageBus");
const { createServiceRegistry } = require("../../electron/architecture/serviceRegistry");
const { createContextProviders } = require("../../electron/architecture/contextProviders");
const { createPromptExtensions } = require("../../electron/architecture/promptExtensions");
const { createMemoryPlugin } = require("../../electron/plugins/memory");
const EVENTS = require("../../electron/architecture/events");
const quiet = { info() {}, warn() {}, error() {} };
const emptyPlan = () => ({ upsert: [], archive: [], forget: [], questions: [] });
const candidate = (source, overrides = {}) => ({ id: null, title: "自由主题", text: source.text,
  topics: [], tags: [], aliases: [], links: [], basis: source.role === "user" ? "user" : "observation",
  confidence: 0.9, importance: 3, pinned: false, expiresAt: null, evidence: [{ sourceId: source.id, quote: source.text.slice(0, 2000) }], ...overrides });
function seed(repo, text, overrides = {}) {
  const { capturedAt, ...fields } = overrides;
  const id = randomUUID(); repo.ingest({ id, text, role: "user", source: "manual-input", capturedAt });
  const source = repo.events({ ids: [id] })[0];
  repo.apply({ ...emptyPlan(), upsert: [candidate(source, fields)] }, repo.snapshot());
  return repo.list().find(e => e.text === (overrides.text || text));
}
function harness(t, { generate = async () => JSON.stringify(emptyPlan()), options = {}, now = Date.now, embedding, dialog } = {}) {
  const db = workStorage(), services = createServiceRegistry(), bus = new MessageBus({ logger: quiet }), windows = mockWindows();
  const providers = createContextProviders({ logger: quiet }), extensions = createPromptExtensions(), handlers = new Map();
  services.register("storage", db.storage);
  const config = { plugins: [{ name: "memory", enabled: true, store: { enabled: true }, ...options }] };
  const model = { generateText: generate, getRevision: () => 0, isAvailable: () => true };
  const toolResults = [], decisions = [];
  let menu;
  const plugin = createMemoryPlugin({ bus, logger: quiet, model, config: { get: () => config },
    services: { ...services, register: (name, value) => services.register(`memory.${name}`, value) },
    decisionContext: { register: fn => providers.register("memory", fn) },
    systemPrompt: { register: (ext, opts) => extensions.register("memory", ext, opts) },
    windows, dialogs: { showMessageBox: dialog || (async () => ({ response: 0 })) },
    ipc: { handle: (name, fn) => { handlers.set(name, fn); return () => handlers.delete(name); } },
    menu: { register: fn => { menu = fn; return () => { menu = null; }; }, refresh() {} },
    perception: { submit: async result => toolResults.push(result) }, decisions: { request: async input => decisions.push(input) },
  }, { now, embedding });
  const repo = db.storage.repository("adaptive-memory", { now });
  // Initialize migration before seeding so snapshots use the same library generation.
  plugin.getSnapshot();
  t.after(async () => { await plugin.dispose(); await plugin.whenIdle(); db.db.close(); });
  function observation(text, role = "user", source = "manual-input") { return { id: randomUUID(), source, role, capturedAt: new Date(now()).toISOString(), content: [{ type: "text", text }] }; }
  async function record(text, extra = {}) {
    const observations = extra.observations || [observation(text)];
    await bus.publish(EVENTS.DECISION_COMPLETED, { id: randomUUID(), observations, result: { reply: "陪伴回复", summaries: {}, ...extra.result } });
  }
  return { ...db, repo, plugin, model, services, bus, providers, extensions, handlers, windows, config, toolResults, decisions, record, observation,
    menu: () => menu()[0].submenu };
}
module.exports = { quiet, emptyPlan, candidate, seed, harness };
