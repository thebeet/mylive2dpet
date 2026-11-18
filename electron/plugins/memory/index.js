const { randomUUID } = require("node:crypto");
const EVENTS = require("../../architecture/events");
const { getOptions } = require("./options");
const { createShortTermStore } = require("./shortTerm");
const { formatRecentDialogue } = require("./context");
const { migrateLegacy, clearLegacy } = require("./migration");
const { planMemory } = require("./planner");
const { normalize, contentHash, indexText } = require("./records");
const { retrieve, budgetEntries } = require("./retrieval");
const { createEmbeddingClient } = require("./embedding");
const { createMemoryViewer } = require("./viewer");
const { createQuestionService } = require("./questions");
const { promptExtension } = require("./prompt");

function createMemoryPlugin(context, dependencies = {}) {
  const now = dependencies.now || Date.now;
  const options = () => getOptions(context.config.get());
  const recent = createShortTermStore({ now });
  const embedding = dependencies.embedding || createEmbeddingClient(() => options().embedding, dependencies);
  let running = true, disposed = false, generation = 0, store, owner, ownerRevision;
  let task = null, requested = false, controller = null, clearing = null, organizing = false, timer = null;
  let retryAt = 0, failures = 0, totalTurns = 0, confirmation = null, confirmationController = null;
  let lastError = null, lastRetrieval = null;
  const inFlight = new Set(), ignored = new Set(), queryCache = new Map(), queries = new Set(), toolTasks = new Set(), toolSeen = new Set();
  const ingress = new Map();
  const available = () => running && !disposed && !clearing && options().enabled;
  const durableAvailable = () => available() && options().store.enabled;
  function repository() {
    const storage = context.services.get(options().storageService);
    if (!storage || storage.isAvailable?.() === false) throw new Error("记忆存储不可用");
    const revision = storage.getRevision?.();
    if (!store || storage !== owner || revision !== ownerRevision) {
      const next = dependencies.store || storage.repository("adaptive-memory", { now });
      migrateLegacy(storage, next, now);
      store = next; owner = storage; ownerRevision = revision;
    }
    return store;
  }
  function invalidate(reason) {
    generation++; controller?.abort(new Error(reason));
    for (const q of queries) q.abort(new Error(reason));
    queryCache.clear();
  }
  function token() { return { generation, storage: owner, storageRevision: ownerRevision, modelRevision: context.model?.getRevision?.(), generate: context.model?.generateText }; }
  function valid(t) { return durableAvailable() && t.generation === generation && context.services.get(options().storageService) === t.storage &&
    t.storage?.getRevision?.() === t.storageRevision && t.modelRevision === context.model?.getRevision?.() && t.generate === context.model?.generateText; }
  const notify = () => { void context.bus.notify(EVENTS.WORK_MEMORY_UPDATED, {}); context.menu?.refresh(); };
  function flushIngress() {
    const repo = repository();
    for (const [id, source] of ingress) { repo.ingest(source); ingress.delete(id); }
    return repo;
  }
  function ingest(observation) {
    if (!durableAvailable() || !observation || observation.source === "memory") return;
    const body = (observation.content || []).filter(p => p.type === "text").map(p => p.text).join("\n");
    if (!body.trim()) return;
    const id = observation.id || randomUUID();
    ingress.set(id, { id, source: observation.source || "unknown", role: observation.role, text: body,
      capturedAt: observation.capturedAt, metadata: observation.metadata });
    try { const repo = flushIngress(); if (observation.source === "audio-output") repo.setState("audioUntil", now() + 45000); }
    catch (error) { lastError = error.message; context.logger.warn("memory persistence deferred; source buffered:", error.message); }
    request();
  }
  function selectEntries(repo, pending, ordered) {
    const config = options().maintenance, all = repo.list();
    const relevant = repo.candidates(pending.map(s => s.text).join("\n"), config.candidateLimit);
    const entries = ordered || [...relevant, ...all.filter(e => e.pinned), ...all];
    const selected = [], ids = new Set(); let size = 0;
    for (const e of entries) {
      if (ids.has(e.id) || selected.length >= config.candidateLimit) continue;
      const cost = JSON.stringify(e).length;
      if (selected.length && size + cost > config.maxContextChars) continue;
      selected.push(e); ids.add(e.id); size += cost;
    }
    return selected;
  }
  function due(repo, force = false) {
    const config = options().maintenance, pending = repo.events({ pending: true, limit: config.batchSize });
    return pending.length && (force || pending.some(s => s.role === "user") || pending.length >= config.extractEveryNEvents ||
      now() - Math.min(...pending.map(s => s.capturedAt)) >= config.flushAfterMs);
  }
  async function indexVectors(repo, t, signal) {
    if (!options().embedding.enabled) return;
    const provider = embedding.provider(), known = repo.vectors(provider);
    // Index incrementally so restoring a large library cannot hold up new user memories.
    const entries = repo.list().filter(e => !known.has(e.id)).slice(0, options().embedding.batchSize);
    for (let i = 0; i < entries.length; i += options().embedding.batchSize) {
      const batch = entries.slice(i, i + options().embedding.batchSize);
      const vectors = await embedding.embed(batch.map(e => indexText(e)), { signal });
      if (!valid(t) || signal.aborted) return;
      if (vectors) batch.forEach((e, j) => repo.saveVector(e.id, provider, contentHash(e), vectors[j]));
    }
  }
  async function maintain({ organize = false, entries } = {}) {
    if (!durableAvailable()) return;
    const repo = flushIngress(), config = options(), generate = context.model?.generateText;
    repo.pruneEvents(now() - config.store.eventRetentionDays * 86400000);
    const t = token(), abort = new AbortController(); controller = abort;
    try {
      if (!due(repo, organize) && !organize) {
        try { await indexVectors(repo, t, abort.signal); }
        catch (error) { if (valid(t)) context.logger.warn("memory embedding indexing deferred:", error.message); }
        return;
      }
      if (typeof generate !== "function" || context.model?.isAvailable?.() === false) return;
      const pending = repo.snapshot(config.maintenance).pending;
      const selected = entries || selectEntries(repo, pending);
      if (!pending.length && !selected.length) return { before: 0, after: 0, added: 0, updated: 0, archived: 0, deleted: 0, processed: 0 };
      const snapshot = repo.snapshot({ ...config.maintenance, entries: selected, pending });
      const topics = [...new Set(repo.list().flatMap(e => e.topics))].slice(0, 256);
      const plan = await planMemory({ snapshot, topics, questions: config.questions.enabled, organize, now: now(),
        maxTokens: config.maintenance.maxTokens, callChat: (messages, settings) => generate(messages, { ...settings, signal: abort.signal }) });
      if (!valid(t) || abort.signal.aborted) { if (organize) throw new Error("记忆整理已取消"); return; }
      const result = owner.transaction(() => {
        const result = repo.apply(plan, snapshot, { ...config.store, ...config.questions }, { organize });
        if (result.deleted || result.discarded) clearLegacy(owner);
        return result;
      });
      failures = 0; retryAt = 0; lastError = null; notify();
      if (result.deleted || result.discarded) { recent.clear(); lastRetrieval = null; void context.bus.notify(EVENTS.MEMORY_CLEARED, {}); }
      context.logger.info(`memory maintained: added=${result.added}, updated=${result.updated}, archived=${result.archived}, processed=${result.processed}`);
      if (!organize) {
        try { await indexVectors(repo, t, abort.signal); }
        catch (error) { if (valid(t)) context.logger.warn("memory embedding indexing deferred:", error.message); }
      }
      if (repo.stats().pending) requested = true;
      return result;
    } catch (error) {
      if (abort.signal.aborted || !valid(t)) { if (organize) throw new Error("记忆整理已取消"); return; }
      throw error;
    } finally { if (controller === abort) controller = null; }
  }
  function request() {
    if (!durableAvailable()) return;
    requested = true;
    if (task || organizing) return;
    task = Promise.resolve().then(async () => {
      while (requested && durableAvailable()) {
        requested = false;
        if (now() < retryAt) break;
        try { await maintain(); }
        catch (error) {
          if (durableAvailable()) {
            lastError = error.message; retryAt = now() + Math.min(300000, 15000 * 2 ** Math.min(++failures, 5));
            context.logger.warn("memory maintenance deferred; sources retained:", error.message);
          }
          break;
        }
      }
    }).finally(() => { task = null; if (requested && durableAvailable() && now() >= retryAt) request(); });
  }
  async function search(query, { signal, includeArchived = false, limit = options().retrieval.maxInject } = {}) {
    if (!durableAvailable() || typeof query !== "string" || !query.trim() || signal?.aborted) return [];
    const repo = repository(), t = token(), rev = repo.stats().revision, config = options().retrieval;
    const lexical = repo.candidates(query, 128);
    let vector, vectors;
    if (options().embedding.enabled) {
      const key = `${embedding.provider()}:${query}`, abort = new AbortController(); queries.add(abort);
      const requestSignal = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
      try {
        vector = queryCache.get(key);
        if (!vector) {
          vector = (await embedding.embed([query.slice(0, 6000)], { signal: requestSignal }))?.[0];
          if (vector && valid(t) && repo.stats().revision === rev) { queryCache.set(key, vector); if (queryCache.size > 128) queryCache.delete(queryCache.keys().next().value); }
        }
        vectors = repo.vectors(embedding.provider());
      } catch (error) { if (!requestSignal.aborted) context.logger.warn("memory semantic search unavailable; using lexical search:", error.message); }
      finally { queries.delete(abort); }
    }
    if (signal?.aborted || !valid(t) || repo.stats().revision !== rev) return [];
    const all = vector ? repo.list({ includeArchived }) : lexical;
    const result = retrieve(all, query, { vector, vectors, now: now(), limit, minSimilarity: config.minSimilarity, includeArchived });
    lastRetrieval = { query, at: now(), mode: vector ? "hybrid" : "lexical", entries: result.map(r => ({ id: r.entry.id, lexical: r.lexical, semantic: r.semantic })) };
    return result;
  }
  async function provideContext({ observations = [], conversationHistory = false, signal } = {}) {
    if (!available()) return [];
    const blocks = [];
    if (options().shortTerm.enabled && !conversationHistory) {
      const text = formatRecentDialogue(recent.list(options().shortTerm));
      if (text) blocks.push({ id: "recent-dialogue", title: "近期交流", text });
    }
    if (!options().store.enabled) return blocks;
    try {
      const repo = repository(), t = token();
      const direct = observations.filter(o => o.role === "user").flatMap(o => (o.content || []).filter(p => p.type === "text").map(p => p.text)).join("\n");
      const current = direct || observations.flatMap(o => (o.content || []).filter(p => p.type === "text").map(p => p.text)).join("\n");
      const query = current || recent.list(options().shortTerm).at(-1)?.userMessage || "";
      const results = await search(query, { signal });
      if (!valid(t) || signal?.aborted) return blocks;
      const config = options().retrieval;
      const pinned = repo.list().filter(e => e.pinned && (e.expiresAt == null || e.expiresAt > now()))
        .sort((a, b) => b.importance - a.importance || b.updatedAt - a.updatedAt).slice(0, config.maxPinned);
      const selected = [...pinned, ...results.map(r => r.entry)].filter((e, i, a) => a.findIndex(x => x.id === e.id) === i);
      const formatted = budgetEntries(selected, config.maxContextChars, now());
      if (formatted.text) blocks.push({ id: "recalled-memory", title: "本轮记忆（以来源和时间为准）", scope: "turn", text: formatted.text });
    } catch (error) { context.logger.warn("memory retrieval failed:", error.message); }
    return blocks;
  }
  function read(id) {
    if (!durableAvailable()) throw new Error("记忆服务已停止或关闭");
    const repo = repository(), entry = repo.get(id);
    if (!entry) throw new Error("记忆不存在或已删除");
    return { ...entry, sources: repo.events({ ids: repo.provenance(id).map(r => r.sourceId) }).filter(s => !s.forgotten), history: repo.history(id) };
  }
  function getSnapshot(input = {}) {
    const config = options(), base = { enabled: config.enabled, maintaining: Boolean(task), organizing, clearing: Boolean(clearing), totalTurns,
      shortTerm: { ...config.shortTerm, turns: recent.list(config.shortTerm) }, lastError, lastRetrieval, bufferedSources: ingress.size };
    try {
      const repo = repository(), all = repo.list({ includeArchived: Boolean(input.includeArchived) });
      const topics = [...new Set(all.flatMap(e => e.topics))].sort();
      const query = normalize(input.query), filtered = all.filter(e => (!input.topic || e.topics.includes(input.topic)) && (!query || normalize(indexText(e)).includes(query)));
      const offset = Math.max(0, Math.floor(Number(input.offset) || 0)), limit = Math.max(1, Math.min(100, Math.floor(Number(input.limit) || 50)));
      return { ...base, store: { enabled: config.store.enabled, ...repo.stats(), topics, total: filtered.length, offset, limit,
        entries: filtered.slice(offset, offset + limit), events: repo.events({ limit: 50 }).filter(e => !e.forgotten), questions: repo.state("questions", []) },
        embedding: { enabled: config.embedding.enabled, indexed: config.embedding.enabled ? repo.vectors(embedding.provider()).size : 0 } };
    } catch (error) { return { ...base, store: { enabled: config.store.enabled, error: error.message, entries: [], topics: [], events: [], questions: [], total: 0 } }; }
  }
  async function organize() {
    if (!durableAvailable()) throw new Error("记忆已停止或持久记忆已关闭");
    if (organizing) throw new Error("正在整理记忆");
    organizing = true; context.menu?.refresh();
    try {
      if (task) await task;
      if (!durableAvailable()) throw new Error("记忆整理已取消");
      const repo = repository();
      if (!repo.list().length && !repo.stats().pending) return { before: 0, after: 0, added: 0, updated: 0, archived: 0, deleted: 0 };
      if (typeof context.model?.generateText !== "function" || context.model?.isAvailable?.() === false) throw new Error("AI 文本服务不可用");
      const ids = repo.list().map(e => e.id), result = { before: ids.length, added: 0, updated: 0, archived: 0, deleted: 0, processed: 0 };
      let cursor = 0;
      while (cursor < ids.length || cursor === 0 && repo.stats().pending) {
        const chunk = [], maxChars = options().maintenance.maxContextChars; let size = 0;
        while (cursor < ids.length) {
          const e = repo.get(ids[cursor]);
          if (!e || e.status !== "active") { cursor++; continue; }
          const cost = JSON.stringify(e).length;
          if (chunk.length && (size + cost > maxChars || chunk.length >= options().maintenance.candidateLimit)) break;
          chunk.push(e); size += cost; cursor++;
        }
        const applied = await maintain({ organize: true, entries: chunk });
        if (!applied) throw new Error("记忆整理已取消");
        for (const key of ["added", "updated", "archived", "deleted", "processed"]) result[key] += applied[key];
        if (!ids.length) break;
      }
      result.after = repo.list().length; notify(); return result;
    } finally { organizing = false; context.menu?.refresh(); if (requested) request(); }
  }
  async function clear() {
    if (clearing) return clearing;
    if (!available()) throw new Error("记忆插件已停止");
    const repo = repository(), storage = owner;
    invalidate("记忆已清空"); requested = false; recent.clear(); ingress.clear(); lastRetrieval = null;
    for (const id of inFlight) ignored.add(id);
    void context.bus.notify(EVENTS.MEMORY_CLEARED, {});
    clearing = Promise.resolve().then(() => storage.transaction(() => { const result = repo.clear(); clearLegacy(storage); return result; }))
      .finally(() => { clearing = null; totalTurns = 0; lastError = null; retryAt = 0; failures = 0; notify(); });
    return clearing;
  }
  function correct(id, text, settings) {
    if (!durableAvailable()) throw new Error("记忆已停止");
    const repo = repository(); invalidate("记忆已手动修正"); const result = repo.correct(id, text, settings); notify(); return result;
  }
  function forget(id) {
    if (!durableAvailable()) throw new Error("记忆已停止");
    const repo = repository(); invalidate("记忆已删除");
    const result = owner.transaction(() => { const result = repo.forget(id); clearLegacy(owner); return result; });
    recent.clear(); lastRetrieval = null; void context.bus.notify(EVENTS.MEMORY_CLEARED, {}); notify(); return result;
  }
  const questionService = createQuestionService({ repository, available: () => durableAvailable() && options().questions.enabled, request, now, notify });
  const viewer = createMemoryViewer(context, { getSnapshot, isAvailable: available, readMemory: read, correctMemory: correct,
    forgetMemory: forget, deleteQuestion: questionService.deleteQuestion, deleteAnswer: questionService.deleteAnswer });
  async function tools(event) {
    const effects = (event.result.effects || []).filter(e => ["memory.search", "memory.read"].includes(e.type));
    if (!effects.length || !durableAvailable() || !context.perception?.submit || !context.decisions?.request) return;
    const direct = (event.observations || []).some(o => o.role === "user"), previous = (event.observations || []).find(o => o.source === "memory");
    const depth = direct ? 0 : Number(previous?.metadata?.memoryDepth || 0);
    if (depth >= 2) return;
    const key = event.id || randomUUID(); if (toolSeen.has(key)) return;
    toolSeen.add(key); if (toolSeen.size > 1000) toolSeen.delete(toolSeen.values().next().value);
    let t; const abort = new AbortController(); queries.add(abort);
    try {
      repository(); t = token();
      const effect = effects[0]; let result;
      if (effect.type === "memory.search") {
        if (typeof effect.query !== "string" || !effect.query.trim() || effect.query.length > 1000) throw new Error("记忆查询无效");
        const matches = await search(effect.query, { signal: abort.signal, includeArchived: true });
        result = { query: effect.query, memories: budgetEntries(matches.map(r => r.entry), options().retrieval.maxContextChars, now()).text };
      } else {
        if (!Array.isArray(effect.ids) || !effect.ids.length || effect.ids.length > 4 || effect.ids.some(id => typeof id !== "string")) throw new Error("记忆读取 ID 无效");
        result = { memories: effect.ids.map(id => { const entry = read(id); return { id: entry.id, title: entry.title, text: entry.text,
          basis: entry.basis, status: entry.status, observedAt: entry.observedAt, expiresAt: entry.expiresAt,
          sources: entry.sources.slice(0, 4).map(s => ({ id: s.id, source: s.source, role: s.role, capturedAt: s.capturedAt,
            quotes: entry.evidence.filter(r => r.sourceId === s.id).map(r => r.quote.slice(0, 1000)).slice(0, 2) })) }; }) };
      }
      if (!valid(t) || abort.signal.aborted) return;
      if (result.memories && Array.isArray(result.memories)) {
        while (JSON.stringify(result).length > 24000 && result.memories.length > 1) result.memories.pop();
      }
      await context.perception.submit({ id: `memory:${key}`, source: "memory", role: "context", trigger: "memory-result", capturedAt: new Date(now()).toISOString(),
        content: [{ type: "text", text: JSON.stringify(result) }], metadata: { memoryDepth: depth + 1, decisionId: key } });
      if (!valid(t) || abort.signal.aborted) return;
      const followup = Promise.resolve().then(() => context.decisions.request({ trigger: "memory-result", signal: abort.signal }))
        .catch(error => { if (available() && !abort.signal.aborted) context.logger.warn("memory follow-up failed:", error.message); });
      toolTasks.add(followup); void followup.finally(() => { toolTasks.delete(followup); queries.delete(abort); });
      return await followup;
    } catch (error) { if (available() && !abort.signal.aborted) context.logger.warn("memory tool failed:", error.message); }
    finally { queries.delete(abort); }
  }
  const releases = [
    context.decisionContext.register(provideContext),
    context.bus.subscribe(EVENTS.PERCEPTION_OBSERVATION_QUEUED, ({ observation }) => ingest(observation)),
    context.bus.subscribe(EVENTS.DECISION_STARTED, ({ id }) => inFlight.add(id)),
    context.bus.subscribe(EVENTS.PIPELINE_FAILED, event => { if (event.stage === "decision") { inFlight.delete(event.id); ignored.delete(event.id); } }),
    context.bus.subscribe(EVENTS.DECISION_COMPLETED, event => {
      inFlight.delete(event.id); if (ignored.delete(event.id) || !available()) return;
      const observations = event.observations || [], userMessage = observations.filter(o => o.role === "user").flatMap(o => (o.content || []).filter(p => p.type === "text").map(p => p.text)).join("\n");
      recent.append({ decisionId: event.id, sessionId: event.sessionId, reply: event.result.reply, speak: event.result.speak,
        summaries: event.result.summaries, expression: event.result.expression, userMessage }, options().shortTerm); totalTurns++;
      for (const [i, o] of observations.entries()) ingest({ ...o, id: o.id || `${event.id || randomUUID()}:input:${i}` });
      const imageSources = observations.filter(o => (o.content || []).some(p => p.type === "image"));
      if (imageSources.length) {
        const text = [...new Set([event.result.summaries?.screen, event.result.summaries?.work].filter(Boolean))].join("\n");
        if (text) ingest({ id: `visual:${event.id || randomUUID()}`, source: "screen-summary", role: "context", capturedAt: imageSources.at(-1).capturedAt,
          content: [{ type: "text", text }], metadata: { observationIds: imageSources.map(o => o.id), decisionId: event.id,
            resources: imageSources.flatMap(o => o.content.filter(p => p.type === "image").map(p => ({ uri: p.uri?.startsWith("storage://") ? p.uri : undefined, path: p.path }))) } });
      }
      const job = tools(event); toolTasks.add(job); void job.finally(() => toolTasks.delete(job));
    }, { allowWhileStopped: true }),
    options().store.enabled ? context.systemPrompt?.register(promptExtension, { isActive: durableAvailable }) || (() => {}) : () => {},
    context.services.register?.("clear", clear) || (() => {}), context.services.register?.("organize", organize) || (() => {}),
    context.services.register?.("search", search) || (() => {}), context.services.register?.("read", read) || (() => {}),
    context.services.register?.("work", questionService) || (() => {}),
    context.services.subscribe?.(({ name }) => { if (name === options().storageService) { invalidate("记忆存储已更新"); store = null; retryAt = 0; request(); } }) || (() => {}),
    context.model?.subscribe?.(() => { invalidate("核心模型已更新"); retryAt = 0; request(); }) || (() => {}),
  ];
  function confirmClear() {
    if (confirmation || !available()) return confirmation;
    const t = generation; confirmationController = new AbortController();
    confirmation = Promise.resolve().then(async () => {
      const { response } = await context.dialogs.showMessageBox({ type: "warning", title: "清空全部记忆", message: "确定要清空全部记忆吗？",
        detail: "将清除记忆、来源、版本、索引与提问记录；保留历史对话。", buttons: ["取消", "清空全部记忆"], defaultId: 0, cancelId: 0,
        signal: confirmationController.signal });
      if (response === 1 && available() && t === generation) return clear();
    }).finally(() => { confirmation = null; confirmationController = null; });
    return confirmation;
  }
  const releaseMenu = context.menu?.register(() => [{ label: "记忆", submenu: [
    { label: "查看当前记忆…", enabled: available(), click: () => viewer.show("memories") },
    { label: "查看提问记录…", enabled: available(), click: () => viewer.show("questions") },
    { label: organizing ? "正在整理记忆…" : "整理", enabled: durableAvailable() && !organizing && !confirmation, click: async () => {
      const t = generation;
      try { const result = await organize(); if (available() && t === generation) await context.bus.notify(EVENTS.BUBBLE_OUTPUT_REQUESTED,
        { text: `记忆整理完成：新增 ${result.added} 条，更新 ${result.updated} 条，归档 ${result.archived} 条。` }); }
      catch (error) { if (available() && t === generation) await context.bus.notify(EVENTS.BUBBLE_OUTPUT_REQUESTED, { type: "error", text: `记忆整理未完成：${error.message}` }); }
    } }, { type: "separator" }, { label: "清空全部记忆", enabled: available() && !confirmation, click: confirmClear },
  ] }]) || (() => {});
  function start() { if (disposed) return; running = true; if (!timer && options().store.enabled) { timer = setInterval(request, options().maintenance.pollMs); timer.unref?.(); } request(); }
  function stop() { running = false; requested = false; invalidate("记忆插件已停止"); confirmationController?.abort(); viewer.close(); if (timer) clearInterval(timer); timer = null; return Promise.resolve(); }
  return { start, stop, clear, organize, search, read, correct, forget, getSnapshot,
    getState: () => ({ turns: recent.list(options().shortTerm), ...getSnapshot().store }),
    async whenIdle() { while (task || clearing || toolTasks.size) await Promise.allSettled([task, clearing, ...toolTasks].filter(Boolean)); },
    dispose() { const done = stop(); disposed = true; releases.forEach(release => release()); releaseMenu(); viewer.dispose(); recent.clear(); return done; },
  };
}
module.exports = { createMemoryPlugin, getOptions, activate: createMemoryPlugin };
