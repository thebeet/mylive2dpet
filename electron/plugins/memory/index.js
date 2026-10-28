const path = require("path");
const EVENTS = require("../../architecture/events");
const { getOptions } = require("./options");
const { createShortTermStore } = require("./shortTerm");
const { createSummarizer } = require("./summarizer");
const extractor = require("./extractor");
const longTerm = require("./longTerm");
const { formatRecentDialogue, buildContextBlocks } = require("./context");
const { createMemoryViewer } = require("./viewer");
const { createWorkMemory } = require("./workMemory");

/** Owns all memory state and reacts to successful, validated decisions. */
function createMemoryPlugin(context, dependencies = {}) {
  const buffer = createShortTermStore({ now: dependencies.now || Date.now });
  // Facts awaiting extraction survive compression of the visible recent buffer.
  const extractionBuffer = createShortTermStore({ now: dependencies.now || Date.now });
  const summarizer = createSummarizer();
  let durable = dependencies.longTerm || null;
  let totalTurns = 0;
  let summarizedThrough = 0;
  let extractedThrough = 0;
  let generation = 0;
  let active = true;
  let disposed = false;
  let requested = false;
  let task = null;
  let controller = null;
  let warnedService = null;
  let clearing = null;
  let confirmation = null;
  let confirmationController = null;
  const inFlightDecisions = new Set();
  const ignoredDecisions = new Set();

  const options = () => getOptions(context.config.get());
  const work = createWorkMemory(context, { options, now: dependencies.now || Date.now,
    isAvailable: () => active && !disposed && !clearing });
  if (options().work.enabled) {
    try { summarizer.set(work.restoreSummary()); } catch (error) { context.logger.warn("work memory initialization failed:", error); }
  }
  function getDurable() {
    if (durable) return durable;
    const config = options();
    const storage = context.services.get(config.storageService);
    if (!storage) throw new Error(`memory storage service unavailable: ${config.storageService}`);
    const store = longTerm.createLongTermStore(storage);
    const projectRoot = context.paths?.projectRoot || path.resolve(__dirname, "../../..");
    store.importLegacy(path.resolve(projectRoot, config.longTerm.legacyPath), config.longTerm, context.logger);
    durable = store;
    return durable;
  }

  if (options().enabled && options().longTerm.enabled) {
    try { getDurable(); } catch (error) { context.logger.warn("long-term storage initialization deferred:", error); }
  }

  function valid(snapshot) {
    return active && !disposed && !clearing && snapshot.generation === generation && options().enabled &&
      context.services.get(snapshot.options.textService) === snapshot.generate;
  }

  async function maintainSnapshot() {
    const config = options();
    if (!active || disposed || !config.enabled) return;
    const turns = buffer.list(config.shortTerm);
    const turnsText = formatRecentDialogue(turns);
    const extractionTurns = extractionBuffer.list(config.shortTerm);
    const extractionText = formatRecentDialogue(extractionTurns);
    const summarize = Boolean(turnsText) && config.summary.enabled &&
      summarizer.shouldSummarize(config.summary, totalTurns - summarizedThrough, turns.length);
    const extract = Boolean(extractionText) && config.longTerm.enabled &&
      extractor.shouldExtract(config.longTerm, totalTurns - extractedThrough);
    const extractWork = work.due();
    if (!summarize && !extract && !extractWork) return;

    const generate = context.services.get(config.textService);
    if (typeof generate !== "function") {
      if (warnedService !== config.textService) {
        context.logger.warn(`text service unavailable: ${config.textService}; maintenance deferred`);
        warnedService = config.textService;
      }
      return;
    }
    warnedService = null;
    const snapshot = { turns, extractionTurns, through: totalTurns, generation, options: config, generate };
    const abortController = new AbortController();
    controller = abortController;
    const callChat = (messages, settings) => generate(messages, {
      ...settings, signal: abortController.signal,
    });
    try {
      if (summarize) {
        try {
          const next = await summarizer.summarizeWithLlm({
            previousSummary: summarizer.get(), turnsText, callChat,
            maxTokens: config.summary.maxTokens,
          });
          if (next && valid(snapshot) && options().summary.enabled) {
            summarizer.set(next);
            work.saveSummary(next);
            summarizedThrough = snapshot.through;
            buffer.foldSnapshot(snapshot.turns, config.summary.keepTurnsAfterSummary, config.shortTerm);
            context.logger.info("session summary updated:", next.slice(0, 120));
          }
        } catch (error) {
          if (valid(snapshot)) context.logger.warn("summary failed:", error);
        }
      }
      if (!valid(snapshot)) return;
      if (extract && options().longTerm.enabled) {
        try {
          // Failed extraction keeps these originals for a later attempt.
          const facts = await extractor.extractWithLlm({
            turnsText: extractionText, callChat, maxTokens: config.longTerm.maxTokens,
          });
          if (!valid(snapshot) || !options().longTerm.enabled) return;
          const store = getDurable();
          let added = 0;
          if (typeof store.appendBatch === "function") {
            added = store.appendBatch(facts, config.longTerm, {
              sourceDecisionIds: [...new Set(snapshot.extractionTurns.map((turn) => turn.decisionId).filter(Boolean))],
              sourceSessionIds: [...new Set(snapshot.extractionTurns.map((turn) => turn.sessionId).filter(Boolean))],
            });
          } else {
            // Injected repositories may implement the simpler per-fact interface.
            for (const fact of facts) {
              if (store.isDuplicate(fact.text, config.longTerm)) continue;
              store.append(fact, config.longTerm);
              added += 1;
            }
          }
          extractedThrough = snapshot.through;
          extractionBuffer.foldSnapshot(snapshot.extractionTurns, 0, config.shortTerm);
          if (added) context.logger.info(`long-term +${added} fact(s)`);
        } catch (error) {
          if (valid(snapshot)) context.logger.warn("extraction failed:", error);
        }
      }
      if (extractWork && valid(snapshot)) {
        try { await work.maintain({ callChat, valid: () => valid(snapshot) }); }
        catch (error) { if (valid(snapshot)) context.logger.warn("work extraction failed:", error); }
      }
    } finally {
      if (controller === abortController) controller = null;
    }
  }

  function scheduleMaintenance() {
    if (!active || disposed || clearing) return;
    requested = true;
    if (task) return;
    task = Promise.resolve().then(async () => {
      while (requested && active && !disposed) {
        requested = false;
        await maintainSnapshot();
      }
    }).catch((error) => {
      if (active && !disposed) context.logger.warn("maintenance failed:", error);
    }).finally(() => {
      task = null;
      if (requested && active && !disposed) scheduleMaintenance();
    });
  }

  function recordDecision({ id, sessionId, observations, result, trigger }) {
    inFlightDecisions.delete(id);
    if (ignoredDecisions.delete(id) || clearing) return;
    try { work.ingestDecision({ id, sessionId, observations, result, trigger }); }
    catch (error) { context.logger.warn("work observation record failed:", error); }
    try {
      const config = options();
      if (!active || disposed || !config.enabled ||
          !(config.shortTerm.enabled || config.summary.enabled || config.longTerm.enabled || config.work.enabled)) return;
      const userMessage = observations.filter(({ role }) => role === "user")
        .flatMap(({ content }) => content.filter(({ type }) => type === "text"))
        .map(({ text }) => text.trim()).filter(Boolean).join("\n");
      const turn = buffer.append({
        decisionId: id, sessionId,
        reply: result.reply,
        speak: result.speak,
        expression: result.expression,
        summaries: result.summaries,
        userMessage,
        trigger: trigger || observations.map((item) => item.trigger).filter(Boolean).join(","),
      }, { ...config.shortTerm, enabled: true });
      if (!turn) { if (config.work.enabled) scheduleMaintenance(); return; }
      if (config.longTerm.enabled) extractionBuffer.append(turn, { ...config.shortTerm, enabled: true });
      totalTurns += 1;
      scheduleMaintenance();
    } catch (error) {
      // Optional memory failures must not turn a successful reply into a failure.
      context.logger.warn("record failed:", error);
    }
  }

  function provideContext({ observations = [] } = {}) {
    const config = options();
    if (!active || disposed || clearing || !config.enabled) return [];
    const turnsText = formatRecentDialogue(buffer.list(config.shortTerm));
    const sessionSummary = config.summary.enabled ? summarizer.get() : "";
    let longTermMemory = "";
    if (config.longTerm.enabled) {
      try {
        const query = [...observations
          .flatMap(({ content }) => content.filter(({ type }) => type === "text"))
          .map(({ text }) => text), sessionSummary, turnsText].filter(Boolean).join("\n");
        const store = getDurable();
        longTermMemory = store.formatForPrompt(store.retrieve(query, config.longTerm));
      } catch (error) {
        context.logger.warn("retrieval failed:", error);
      }
    }
    if (totalTurns || config.work.enabled) scheduleMaintenance();
    const blocks = buildContextBlocks({
      longTermMemory, sessionSummary,
      recentDialogue: config.shortTerm.enabled ? turnsText : "",
    });
    try {
      const query = [...observations.flatMap((o) => o.content.filter((p) => p.type === "text").map((p) => p.text)),
        ...buffer.list(config.shortTerm).slice(-2).map((t) => t.summaries.work || t.summaries.screen || "")].join("\n");
      const text = work.context(query);
      if (text) blocks.unshift({ id: "work-profiles", title: "人物与项目画像（猜测可修正）", text });
    } catch (error) { context.logger.warn("work context failed:", error); }
    return blocks;
  }

  const unsubscribeObservation = context.bus.subscribe(EVENTS.PERCEPTION_OBSERVATION_QUEUED, ({ observation }) => {
    try { work.ingestObservation(observation); if (options().work.enabled) scheduleMaintenance(); }
    catch (error) { context.logger.warn("work evidence record failed:", error); }
  });
  let maintenanceTimer = null;
  const unregisterContext = context.decisionContext.register(provideContext);
  const unsubscribeStarted = context.bus.subscribe(EVENTS.DECISION_STARTED, ({ id }) => {
    inFlightDecisions.add(id);
  });
  const unsubscribeDecision = context.bus.subscribe(EVENTS.DECISION_COMPLETED, recordDecision, { allowWhileStopped: true });
  const unsubscribeFailed = context.bus.subscribe(EVENTS.PIPELINE_FAILED, (event) => {
    if (event.stage === "decision" && event.id) { inFlightDecisions.delete(event.id); ignoredDecisions.delete(event.id); }
  }, { allowWhileStopped: true });

  function clear() {
    if (clearing) return clearing;
    if (disposed || !active) return Promise.reject(new Error("记忆插件已停止"));
    if (!durable && !context.services.get(options().storageService)) return Promise.reject(new Error("长期记忆存储不可用，无法清空全部记忆"));
    generation += 1;
    requested = false;
    controller?.abort();
    for (const id of inFlightDecisions) ignoredDecisions.add(id);
    buffer.clear();
    extractionBuffer.clear();
    summarizer.clear();
    void context.bus.notify(EVENTS.MEMORY_CLEARED, {});
    totalTurns = summarizedThrough = extractedThrough = 0;
    const maintenance = task;
    clearing = Promise.resolve().then(async () => {
      if (maintenance) await maintenance;
      work.clear();
      const config = options();
      const legacyPath = path.resolve(context.paths?.projectRoot || path.resolve(__dirname, "../../.."), config.longTerm.legacyPath);
      if (durable || context.services.get(config.storageService)) {
        const store = getDurable();
        if (typeof store.clear !== "function") throw new Error("记忆存储未提供清空能力");
        const deleted = store.clear(legacyPath);
        context.logger.info(`all memory cleared; long-term removed=${deleted}`);
        return { deleted };
      }
      throw new Error("长期记忆存储不可用，无法清空全部记忆");
    }).finally(() => { clearing = null; context.menu?.refresh(); });
    context.menu?.refresh();
    return clearing;
  }
  function confirmClear() {
    if (confirmation || clearing) return confirmation || clearing;
    if (!active || disposed) return Promise.reject(new Error("记忆插件已停止"));
    const currentGeneration = generation;
    confirmationController = new AbortController();
    const signal = confirmationController.signal;
    confirmation = Promise.resolve().then(async () => {
      if (signal.aborted) return;
      const { response } = await context.dialogs.showMessageBox({
        type: "warning", title: "清空全部记忆", message: "确定要清空全部记忆吗？",
        detail: "近期对话、会话摘要、长期记忆、工作画像、观察证据和提问记录将被永久清除；保留历史对话。此操作无法撤销。",
        buttons: ["取消", "清空全部记忆"], defaultId: 0, cancelId: 0, noLink: true, signal,
      });
      if (response === 1 && !signal.aborted && active && !disposed && generation === currentGeneration) {
        return clear();
      }
    }).finally(() => {
      confirmation = null;
      confirmationController = null;
      context.menu?.refresh();
    });
    context.menu?.refresh();
    return confirmation;
  }

  function getSnapshot() {
    const config = options();
    let entries = [];
    let error = null;
    try {
      if (durable?.list) entries = durable.list();
      else {
        const storage = context.services.get(config.storageService);
        if (!storage) throw new Error("长期记忆存储不可用");
        entries = longTerm.listEntries(storage);
      }
    } catch (cause) { error = String(cause.message || cause); }
    let workSnapshot;
    try { workSnapshot = work.snapshot(); }
    catch (cause) { workSnapshot = { enabled: options().work.enabled, error: String(cause.message || cause), profiles: [], questions: [], recentEvidence: [], pending: 0 }; }
    return {
      enabled: config.enabled, totalTurns, maintaining: Boolean(task), clearing: Boolean(clearing),
      shortTerm: { enabled: config.shortTerm.enabled, maxTurns: config.shortTerm.maxTurns,
        ttlMs: config.shortTerm.ttlMs, turns: buffer.list(config.shortTerm) },
      summary: { enabled: config.summary.enabled, text: summarizer.get() },
      longTerm: { enabled: config.longTerm.enabled, maxEntries: config.longTerm.maxEntries,
        entries, error },
      pendingFacts: extractionBuffer.list(config.shortTerm).length,
      work: workSnapshot,
    };
  }
  const viewer = createMemoryViewer(context, { getSnapshot, isAvailable: () => active && !disposed && !clearing,
    correctProfile: (id, text) => work.api.correctProfile(id, text) });
  const unregisterClear = context.services.register?.("clear", clear) || (() => {});
  const unregisterWork = context.services.register?.("work", work.api) || (() => {});
  const unregisterMenu = context.menu?.register(() => [{ label: "记忆", submenu: [
    { label: "查看当前记忆…", enabled: active && !disposed, click: viewer.show },
    { label: "查看提问记录…", enabled: active && !disposed, click: () => viewer.show("question-history") },
    { type: "separator" },
    {
      label: clearing ? "正在清空记忆…" : "清空全部记忆",
      enabled: active && !clearing && !confirmation && !disposed && Boolean(durable || context.services.get(options().storageService)),
      click: confirmClear,
    },
  ] }]) || (() => {});

  function stop() {
    active = false;
    confirmationController?.abort();
    viewer.close();
    requested = false;
    generation += 1;
    controller?.abort();
    controller = null;
    if (maintenanceTimer) clearInterval(maintenanceTimer);
    maintenanceTimer = null;
    return Promise.allSettled([task, clearing].filter(Boolean));
  }

  return {
    start() {
      if (disposed) return;
      active = true;
      if (options().work.enabled && !maintenanceTimer) {
        maintenanceTimer = setInterval(() => scheduleMaintenance(), 30000);
        maintenanceTimer.unref?.();
      }
      if (totalTurns || options().work.enabled) scheduleMaintenance();
    },
    stop,
    dispose() {
      const done = stop();
      disposed = true;
      unregisterContext();
      unsubscribeStarted();
      unsubscribeDecision();
      unsubscribeFailed();
      unsubscribeObservation();
      if (maintenanceTimer) clearInterval(maintenanceTimer);
      unregisterClear();
      unregisterWork();
      unregisterMenu();
      viewer.dispose();
      buffer.clear();
      extractionBuffer.clear();
      summarizer.clear();
      inFlightDecisions.clear();
      ignoredDecisions.clear();
      return done;
    },
    getState: () => ({
      turns: buffer.list(options().shortTerm),
      pendingFacts: extractionBuffer.list(options().shortTerm),
      sessionSummary: summarizer.get(),
      totalTurns, summarizedThrough, extractedThrough,
    }),
    clear,
    getSnapshot,
    async whenIdle() { while (task || clearing) await Promise.all([task, clearing].filter(Boolean)); },
  };
}

function activate(context) {
  return createMemoryPlugin(context);
}

module.exports = { activate, createMemoryPlugin, getOptions };
