const EVENTS = require("../../architecture/events");
const { getOptions } = require("./options");
const { createShortTermStore } = require("./shortTerm");
const { createMaintenanceCoordinator } = require("./maintenanceCoordinator");
const { createUpdateBuffer } = require("./updateBuffer");
const longTerm = require("./longTerm");
const { formatRecentDialogue, buildContextBlocks } = require("./context");
const { createMemoryViewer } = require("./viewer");
const { createWorkMemory } = require("./workMemory");
const { createPracticeMemory } = require("./practiceMemory");

/** Owns all memory state and reacts to successful, validated decisions. */
function createMemoryPlugin(context, dependencies = {}) {
  const buffer = createShortTermStore({ now: dependencies.now || Date.now });
  // Complete dialogues awaiting updates are independent of the visible recent buffer.
  let extractionBuffer = createUpdateBuffer();
  let durable = dependencies.longTerm || null;
  let totalTurns = 0;
  let extractedThrough = 0;
  let confirmation = null;
  let confirmationController = null;
  const inFlightDecisions = new Set();
  const ignoredDecisions = new Set();

  const options = () => getOptions(context.config.get());
  function pendingBuffer() {
    if (!extractionBuffer.durable && options().longTerm.enabled) {
      const storage = context.services.get(options().storageService);
      if (storage) {
        const next = createUpdateBuffer(storage);
        storage.transaction(() => {
          for (const turn of extractionBuffer.list()) next.restoreTurn(turn);
          next.stageEvidence(extractionBuffer.evidence());
        });
        extractionBuffer = next;
      }
    }
    return extractionBuffer;
  }
  const work = createWorkMemory(context, { options, now: dependencies.now || Date.now,
    isAvailable: () => coordinator.isAvailable() });
  const practice = createPracticeMemory(context, { options, now: dependencies.now || Date.now,
    isAvailable: () => coordinator.isAvailable() });
  function getDurable() {
    if (durable) return durable;
    const config = options();
    const storage = context.services.get(config.storageService);
    if (!storage) throw new Error(`memory storage service unavailable: ${config.storageService}`);
    const store = longTerm.createLongTermStore(storage);
    durable = store;
    return durable;
  }

  const coordinator = createMaintenanceCoordinator({
    options, model: context.model, services: context.services, logger: context.logger,
    stores: { pendingBuffer, getDurable, work, practice },
    getTotalTurns: () => totalTurns,
    onUpdated: (through) => { extractedThrough = through; },
    canClear: () => Boolean(durable || context.services.get(options().storageService)),
    onInvalidate() {
      for (const id of inFlightDecisions) ignoredDecisions.add(id);
      buffer.clear();
      pendingBuffer().clear();
      totalTurns = extractedThrough = 0;
      void context.bus.notify(EVENTS.MEMORY_CLEARED, {});
    },
    clearStores,
    refresh: () => context.menu?.refresh(),
    notifyUpdated: () => { void context.bus.notify(EVENTS.WORK_MEMORY_UPDATED, {}); },
  });
  const scheduleMaintenance = coordinator.request;
  const clear = coordinator.clear;
  const state = coordinator.getState;

  if (options().enabled && options().longTerm.enabled) {
    try { getDurable(); } catch (error) { context.logger.warn("long-term storage initialization deferred:", error); }
  }
  function migratePersonProfiles() {
    if (!options().enabled || !options().work.enabled || !options().longTerm.enabled) return;
    try {
      const moved = work.migrateWorkDetails(getDurable()).moved;
      if (moved) context.logger.info(`person profiles cleaned; moved ${moved} work records to long-term memory`);
    } catch (error) { context.logger.warn("person profile migration deferred:", error); }
  }
  migratePersonProfiles();

  function recordDecision({ id, sessionId, observations, result, trigger }) {
    inFlightDecisions.delete(id);
    if (ignoredDecisions.delete(id) || !coordinator.isAvailable()) return;
    try { practice.ingestDecision({ id, sessionId, observations, result, trigger }); }
    catch (error) { context.logger.warn("project/experience record failed:", error); }
    try { work.ingestDecision({ id, sessionId, observations, result, trigger }); }
    catch (error) { context.logger.warn("work observation record failed:", error); }
    try {
      const config = options();
      if (!coordinator.isRunning() || !config.enabled ||
          !(config.shortTerm.enabled || config.longTerm.enabled || config.work.enabled)) return;
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
      if (!turn) { if (config.work.enabled || config.practice.enabled) scheduleMaintenance(); return; }
      if (config.longTerm.enabled && turn.speak !== false) pendingBuffer().append(turn);
      totalTurns += 1;
      scheduleMaintenance();
    } catch (error) {
      // Optional memory failures must not turn a successful reply into a failure.
      context.logger.warn("record failed:", error);
    }
  }

  function provideContext({ observations = [], conversationHistory = false } = {}) {
    const config = options();
    if (!coordinator.isAvailable() || !config.enabled) return [];
    const turnsText = formatRecentDialogue(buffer.list(config.shortTerm));
    let longTermMemory = "";
    if (config.longTerm.enabled) {
      try {
        const query = [...observations
          .flatMap(({ content }) => content.filter(({ type }) => type === "text"))
          .map(({ text }) => text), turnsText].filter(Boolean).join("\n");
        const store = getDurable();
        longTermMemory = store.formatForPrompt(store.retrieve(query, config.longTerm));
      } catch (error) {
        context.logger.warn("retrieval failed:", error);
      }
    }
    const blocks = buildContextBlocks({
      longTermMemory,
      recentDialogue: config.shortTerm.enabled && !conversationHistory ? turnsText : "",
    });
    try {
      const query = [...observations.flatMap((o) => o.content.filter((p) => p.type === "text").map((p) => p.text)),
        ...buffer.list(config.shortTerm).slice(-2).map((t) => t.summaries.work || t.summaries.screen || "")].join("\n");
      const text = work.context(query);
      if (text) blocks.unshift({ id: "work-profiles", title: "人物画像（猜测可修正）", text });
    } catch (error) { context.logger.warn("work context failed:", error); }
    try {
      const query = [...observations.flatMap(o => o.content.filter(p=>p.type === "text").map(p=>p.text)), turnsText].join("\n");
      blocks.unshift(...practice.context(query));
    } catch (error) { context.logger.warn("project/experience context failed:", error); }
    return blocks;
  }

  const unsubscribeObservation = context.bus.subscribe(EVENTS.PERCEPTION_OBSERVATION_QUEUED, ({ observation }) => {
    try { practice.ingestObservation(observation); if (options().practice.enabled) scheduleMaintenance(); }
    catch (error) { context.logger.warn("project/experience source failed:", error); }
    try { work.ingestObservation(observation); if (options().work.enabled) scheduleMaintenance(); }
    catch (error) { context.logger.warn("work evidence record failed:", error); }
  });
  const unregisterContext = context.decisionContext.register(provideContext);
  const unsubscribeStarted = context.bus.subscribe(EVENTS.DECISION_STARTED, ({ id }) => {
    inFlightDecisions.add(id);
  });
  const unsubscribeDecision = context.bus.subscribe(EVENTS.DECISION_COMPLETED, recordDecision, { allowWhileStopped: true });
  const unsubscribeFailed = context.bus.subscribe(EVENTS.PIPELINE_FAILED, (event) => {
    if (event.stage === "decision" && event.id) { inFlightDecisions.delete(event.id); ignoredDecisions.delete(event.id); }
  }, { allowWhileStopped: true });

  function clearStores() {
    work.clear();
    practice.clear();
    const config = options();
    const store = getDurable();
    if (typeof store.clear !== "function") throw new Error("记忆存储未提供清空能力");
    const deleted = store.clear();
    const storage = context.services.get(config.storageService);
    if (storage) createUpdateBuffer(storage).clear();
    context.logger.info(`all memory cleared; long-term removed=${deleted}`);
    return { deleted };
  }

  function organize() {
    if (confirmation) return Promise.reject(new Error("正在清空记忆，请稍后再整理"));
    return coordinator.organize();
  }

  async function organizeFromMenu() {
    const snapshotGeneration = state().generation;
    try {
      const result = await organize();
      if (!coordinator.isAvailable() || state().generation !== snapshotGeneration) return;
      const hasMemory = result.before || result.work?.before || result.practice;
      const details = [`长期事实：整理前 ${result.before} 条，整理后 ${result.after} 条；合并 ${result.merged} 组，归档 ${result.archived} 条。`];
      if (result.work) details.push(`人物画像：整理前 ${result.work.before} 条，整理后 ${result.work.after} 条；合并 ${result.work.merged} 组，归档 ${result.work.archived} 条。`);
      if (result.practice) details.push(`项目与经验：更新 ${result.practice.updated} 条，新增 ${result.practice.added} 条。`);
      details.push("原始记录可在「查看当前记忆」的对应分类页查看。");
      await context.bus.notify(EVENTS.BUBBLE_OUTPUT_REQUESTED, {
        text: hasMemory ? `记忆整理完成。\n${details.join("\n")}` : "暂无记忆可整理。",
      });
    } catch (error) {
      if (!coordinator.isAvailable() || state().generation !== snapshotGeneration) return;
      context.logger.warn("manual memory organization failed:", error);
      await context.bus.notify(EVENTS.BUBBLE_OUTPUT_REQUESTED, {
        type: "error", text: `记忆整理未完成，原始记忆已保留，可以稍后重试。\n${error.message || error}`,
      });
    }
  }
  function confirmClear() {
    if (confirmation) return confirmation;
    if (state().clearing) return clear();
    if (!coordinator.isRunning()) return Promise.reject(new Error("记忆插件已停止"));
    const currentGeneration = state().generation;
    confirmationController = new AbortController();
    const signal = confirmationController.signal;
    confirmation = Promise.resolve().then(async () => {
      if (signal.aborted) return;
      const { response } = await context.dialogs.showMessageBox({
        type: "warning", title: "清空全部记忆", message: "确定要清空全部记忆吗？",
        detail: "近期对话、长期记忆、项目状态、经验、人物画像、观察证据和提问记录将被永久清除；保留历史对话。此操作无法撤销。",
        buttons: ["取消", "清空全部记忆"], defaultId: 0, cancelId: 0, noLink: true, signal,
      });
      if (response === 1 && !signal.aborted && coordinator.isRunning() && state().generation === currentGeneration) {
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
    let organizationHistory = [];
    let error = null;
    try {
      if (durable?.list) {
        entries = durable.list();
        organizationHistory = durable.history?.() || [];
      }
      else {
        const storage = context.services.get(config.storageService);
        if (!storage) throw new Error("长期记忆存储不可用");
        entries = longTerm.listEntries(storage);
      }
    } catch (cause) { error = String(cause.message || cause); }
    let workSnapshot;
    try { workSnapshot = work.snapshot(); }
    catch (cause) { workSnapshot = { enabled: options().work.enabled, error: String(cause.message || cause), profiles: [], questions: [], recentEvidence: [], pending: 0 }; }
    let practiceSnapshot;
    try { practiceSnapshot = practice.snapshot(); }
    catch (cause) { practiceSnapshot = { enabled: config.practice.enabled, error: String(cause.message || cause), projects: [], lessons: [], sources: [], history: [], pending: 0 }; }
    return {
      practice: practiceSnapshot,
      enabled: config.enabled, totalTurns, maintaining: state().maintaining, organizing: state().organizing, clearing: state().clearing,
      shortTerm: { enabled: config.shortTerm.enabled, maxTurns: config.shortTerm.maxTurns,
        ttlMs: config.shortTerm.ttlMs, turns: buffer.list(config.shortTerm) },
      longTerm: { enabled: config.longTerm.enabled, maxEntries: config.longTerm.maxEntries, updateEveryNTurns: config.longTerm.extractEveryNTurns,
        entries, organizationHistory, error },
      pendingFacts: pendingBuffer().list().length,
      work: workSnapshot,
    };
  }
  const viewer = createMemoryViewer(context, { getSnapshot, isAvailable: () => coordinator.isAvailable(),
    correctProfile: (id, text) => work.api.correctProfile(id, text),
    deleteQuestion: (id) => work.api.deleteQuestion(id), deleteAnswer: (questionId, answerId) => work.api.deleteAnswer(questionId, answerId) });
  const unregisterClear = context.services.register?.("clear", clear) || (() => {});
  const unregisterWork = context.services.register?.("work", work.api) || (() => {});
  const unregisterOrganize = context.services.register?.("organize", organize) || (() => {});
  const unregisterMenu = context.menu?.register(() => [{ label: "记忆", submenu: [
    { label: "查看当前记忆…", enabled: coordinator.isRunning(), click: viewer.show },
    { label: "查看提问记录…", enabled: coordinator.isRunning(), click: () => viewer.show("question-history") },
    { label: state().organizing ? "正在整理记忆…" : "整理",
      enabled: coordinator.isAvailable() && !state().organizing && !confirmation && options().enabled && (options().longTerm.enabled || options().work.enabled || options().practice.enabled) &&
        Boolean(durable || context.services.get(options().storageService)), click: organizeFromMenu },
    { type: "separator" },
    {
      label: state().clearing ? "正在清空记忆…" : "清空全部记忆",
      enabled: coordinator.isAvailable() && !confirmation && Boolean(durable || context.services.get(options().storageService)),
      click: confirmClear,
    },
  ] }]) || (() => {});

  function stop() {
    confirmationController?.abort();
    viewer.close();
    return coordinator.stop();
  }

  return {
    start() {
      coordinator.start();
      if (coordinator.isRunning()) migratePersonProfiles();
    },
    stop,
    dispose() {
      confirmationController?.abort();
      const done = coordinator.dispose();
      unregisterContext();
      unsubscribeStarted();
      unsubscribeDecision();
      unsubscribeFailed();
      unsubscribeObservation();
      unregisterClear();
      unregisterWork();
      unregisterOrganize();
      unregisterMenu();
      viewer.dispose();
      buffer.clear();
      if (!extractionBuffer.durable) extractionBuffer.clear();
      inFlightDecisions.clear();
      ignoredDecisions.clear();
      return done;
    },
    getState: () => ({
      turns: buffer.list(options().shortTerm),
      pendingFacts: pendingBuffer().list(),
      totalTurns, extractedThrough,
    }),
    clear,
    organize,
    getSnapshot,
    whenIdle: coordinator.whenIdle,
  };
}

function activate(context) {
  return createMemoryPlugin(context);
}

module.exports = { activate, createMemoryPlugin, getOptions };
