const path = require("path");
const EVENTS = require("../../architecture/events");
const { getOptions } = require("./options");
const { createShortTermStore } = require("./shortTerm");
const { updateWithLlm } = require("./updater");
const { createUpdateBuffer } = require("./updateBuffer");
const longTerm = require("./longTerm");
const { organizeWithLlm } = require("./organizer");
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
  let generation = 0;
  let active = true;
  let disposed = false;
  let requested = false;
  let task = null;
  let controller = null;
  let warnedService = null;
  let clearing = null;
  let organizing = null;
  let organizationController = null;
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
    isAvailable: () => active && !disposed && !clearing });
  const practice = createPracticeMemory(context, { options, now: dependencies.now || Date.now,
    isAvailable: () => active && !disposed && !clearing });
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
  function migratePersonProfiles() {
    if (!options().enabled || !options().work.enabled || !options().longTerm.enabled) return;
    try {
      const moved = work.migrateWorkDetails(getDurable()).moved;
      if (moved) context.logger.info(`person profiles cleaned; moved ${moved} work records to long-term memory`);
    } catch (error) { context.logger.warn("person profile migration deferred:", error); }
  }
  migratePersonProfiles();

  function valid(snapshot) {
    return active && !disposed && !clearing && snapshot.generation === generation && options().enabled &&
      context.services.get(snapshot.options.textService) === snapshot.generate;
  }

  async function maintainSnapshot() {
    const config = options();
    if (!active || disposed || !config.enabled) return;
    const extractionTurns = config.longTerm.enabled ? pendingBuffer().list() : [];
    const extract = config.longTerm.enabled && extractionTurns.length >= config.longTerm.extractEveryNTurns;
    const extractWork = work.due();
    const extractPractice = practice.due();
    if (!extract && !extractWork && !extractPractice) return;

    const generate = context.services.get(config.textService);
    if (typeof generate !== "function") {
      if (warnedService !== config.textService) {
        context.logger.warn(`text service unavailable: ${config.textService}; maintenance deferred`);
        warnedService = config.textService;
      }
      return;
    }
    warnedService = null;
    const snapshot = { extractionTurns, through: totalTurns, generation, options: config, generate };
    const abortController = new AbortController();
    controller = abortController;
    const callChat = (messages, settings) => generate(messages, {
      ...settings, signal: abortController.signal,
    });
    try {
      if (!valid(snapshot)) return;
      if (extract && options().longTerm.enabled) {
        try {
          const store = getDurable(), entries = store.list();
          const evidence = pendingBuffer().evidence();
          const plan = await updateWithLlm({ entries, turns: extractionTurns, evidence, callChat,
            maxTokens: config.longTerm.maxTokens, maxEntries: config.longTerm.maxEntries });
          if (!valid(snapshot) || !options().longTerm.enabled) return;
          const apply = () => {
            const result = store.updateFromDialogue(plan, entries, extractionTurns, evidence, config.longTerm);
            pendingBuffer().consume(extractionTurns, evidence);
            return result;
          };
          const storage = context.services.get(config.storageService);
          const result = storage ? storage.transaction(apply) : apply();
          extractedThrough = snapshot.through;
          context.logger.info(`long-term updated after ${extractionTurns.length} dialogue(s): updated=${result.updated}, added=${result.added}`);
        } catch (error) {
          if (valid(snapshot)) context.logger.warn("long-term update failed:", error);
        }
      }
      if (extractWork && valid(snapshot)) {
        try {
          await work.maintain({ callChat, valid: () => valid(snapshot),
            applyMemory: (memory, evidence) => {
              if (options().longTerm.enabled) pendingBuffer().stageEvidence(evidence);
            } });
        }
        catch (error) { if (valid(snapshot)) context.logger.warn("work extraction failed:", error); }
      }
      if (extractPractice && valid(snapshot)) {
        try {
          const result = await practice.maintain({ callChat, valid: () => valid(snapshot) });
          if (result) context.logger.info(`project/experience updated: updated=${result.updated}, added=${result.added}`);
        } catch (error) { if (valid(snapshot)) context.logger.warn("project/experience extraction failed:", error); }
      }

    } finally {
      if (controller === abortController) controller = null;
    }
  }

  function scheduleMaintenance() {
    if (!active || disposed || clearing) return;
    requested = true;
    if (organizing) return;
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
    try { practice.ingestDecision({ id, sessionId, observations, result, trigger }); }
    catch (error) { context.logger.warn("project/experience record failed:", error); }
    try { work.ingestDecision({ id, sessionId, observations, result, trigger }); }
    catch (error) { context.logger.warn("work observation record failed:", error); }
    try {
      const config = options();
      if (!active || disposed || !config.enabled ||
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

  function provideContext({ observations = [] } = {}) {
    const config = options();
    if (!active || disposed || clearing || !config.enabled) return [];
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
    if (totalTurns || config.work.enabled || config.practice.enabled || config.longTerm.enabled && pendingBuffer().list().length) scheduleMaintenance();
    const blocks = buildContextBlocks({
      longTermMemory,
      recentDialogue: config.shortTerm.enabled ? turnsText : "",
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
    organizationController?.abort(new Error("记忆整理已取消"));
    for (const id of inFlightDecisions) ignoredDecisions.add(id);
    buffer.clear();
    pendingBuffer().clear();
    void context.bus.notify(EVENTS.MEMORY_CLEARED, {});
    totalTurns = extractedThrough = 0;
    const maintenance = task;
    const organization = organizing;
    clearing = Promise.resolve().then(async () => {
      if (maintenance) await maintenance;
      if (organization) await organization.catch(() => {});
      work.clear();
      practice.clear();
      const config = options();
      const legacyPath = path.resolve(context.paths?.projectRoot || path.resolve(__dirname, "../../.."), config.longTerm.legacyPath);
      if (durable || context.services.get(config.storageService)) {
        const store = getDurable();
        if (typeof store.clear !== "function") throw new Error("记忆存储未提供清空能力");
        const deleted = store.clear(legacyPath);
        const storage = context.services.get(config.storageService);
        if (storage) createUpdateBuffer(storage).clear();
        context.logger.info(`all memory cleared; long-term removed=${deleted}`);
        return { deleted };
      }
      throw new Error("长期记忆存储不可用，无法清空全部记忆");
    }).finally(() => { clearing = null; context.menu?.refresh(); });
    context.menu?.refresh();
    return clearing;
  }

  function organize() {
    if (organizing) return organizing;
    const config = options();
    if (!active || disposed || !config.enabled) return Promise.reject(new Error("记忆插件已停止"));
    if (clearing || confirmation) return Promise.reject(new Error("正在清空记忆，请稍后再整理"));
    if (!config.longTerm.enabled && !config.work.enabled && !config.practice.enabled) return Promise.reject(new Error("长期记忆已关闭，人物画像也未启用"));
    const snapshotGeneration = generation;
    const maintenance = task;
    const abortController = new AbortController();
    organizationController = abortController;
    organizing = Promise.resolve().then(async () => {
      if (maintenance) await maintenance;
      const current = options();
      const generate = context.services.get(current.textService);
      const snapshot = { generation: snapshotGeneration, options: current, generate };
      const isValid = () => !abortController.signal.aborted && valid(snapshot) &&
        options().longTerm.enabled === current.longTerm.enabled && options().work.enabled === current.work.enabled &&
        options().practice.enabled === current.practice.enabled;
      if (!isValid()) throw new Error("记忆整理已取消");
      const store = current.longTerm.enabled ? getDurable() : null;
      if (store && (typeof store.list !== "function" || typeof store.organize !== "function")) throw new Error("记忆存储不支持整理");
      const entries = store ? store.list() : [];
      const profiles = current.work.enabled ? work.organizationSnapshot() : undefined;
      const practiceSnapshot = practice.organizationSnapshot();
      const empty = { before: 0, after: 0, merged: 0, archived: 0 };
      if (!entries.length && !profiles?.length && !practiceSnapshot?.projects.length && !practiceSnapshot?.lessons.length && !practiceSnapshot?.sources.length) return { ...empty, ...(profiles ? { work: { ...empty } } : {}) };
      if (typeof generate !== "function") throw new Error("AI 文本服务不可用，请稍后重试");
      context.logger.info(`memory organization: ${entries.length} facts, ${profiles?.length || 0} work profiles`);
      const plan = await organizeWithLlm({ entries, profiles, practice: practiceSnapshot, signal: abortController.signal,
        callChat: (messages, settings) => generate(messages, {
          ...settings, signal: abortController.signal,
        }) });
      if (!isValid()) throw new Error("记忆整理已取消");
      let result;
      if (profiles !== undefined || practiceSnapshot !== undefined) {
        const storage = context.services.get(current.storageService);
        if (!storage) throw new Error("人物记忆存储不可用");
        result = storage.transaction(() => ({ ...(store ? store.organize(plan, entries) : empty),
          ...(profiles !== undefined ? { work: work.organize(plan.workProfiles, profiles) } : {}),
          ...(practiceSnapshot !== undefined ? { practice: practice.organize(plan.practice, practiceSnapshot) } : {}) }));
        void context.bus.notify(EVENTS.WORK_MEMORY_UPDATED, {});
      } else result = store.organize(plan, entries);
      context.logger.info(`long-term organized: ${result.before} -> ${result.after}; merged=${result.merged} archived=${result.archived}`);
      if (result.work) context.logger.info(`work profiles organized: ${result.work.before} -> ${result.work.after}; merged=${result.work.merged} archived=${result.work.archived}`);
      return result;
    }).finally(() => {
      organizing = null;
      if (organizationController === abortController) organizationController = null;
      context.menu?.refresh();
      if (requested && active && !disposed && !clearing) scheduleMaintenance();
    });
    context.menu?.refresh();
    return organizing;
  }

  async function organizeFromMenu() {
    const snapshotGeneration = generation;
    try {
      const result = await organize();
      if (!active || disposed || clearing || generation !== snapshotGeneration) return;
      const hasMemory = result.before || result.work?.before || result.practice;
      const details = [`长期事实：整理前 ${result.before} 条，整理后 ${result.after} 条；合并 ${result.merged} 组，归档 ${result.archived} 条。`];
      if (result.work) details.push(`人物画像：整理前 ${result.work.before} 条，整理后 ${result.work.after} 条；合并 ${result.work.merged} 组，归档 ${result.work.archived} 条。`);
      if (result.practice) details.push(`项目与经验：更新 ${result.practice.updated} 条，新增 ${result.practice.added} 条。`);
      details.push("原始记录可在「查看当前记忆」的对应分类页查看。");
      await context.bus.notify(EVENTS.BUBBLE_OUTPUT_REQUESTED, {
        text: hasMemory ? `记忆整理完成。\n${details.join("\n")}` : "暂无记忆可整理。",
      });
    } catch (error) {
      if (!active || disposed || clearing || generation !== snapshotGeneration) return;
      context.logger.warn("manual memory organization failed:", error);
      await context.bus.notify(EVENTS.BUBBLE_OUTPUT_REQUESTED, {
        type: "error", text: `记忆整理未完成，原始记忆已保留，可以稍后重试。\n${error.message || error}`,
      });
    }
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
        detail: "近期对话、长期记忆、项目状态、经验、人物画像、观察证据和提问记录将被永久清除；保留历史对话。此操作无法撤销。",
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
      enabled: config.enabled, totalTurns, maintaining: Boolean(task || organizing), organizing: Boolean(organizing), clearing: Boolean(clearing),
      shortTerm: { enabled: config.shortTerm.enabled, maxTurns: config.shortTerm.maxTurns,
        ttlMs: config.shortTerm.ttlMs, turns: buffer.list(config.shortTerm) },
      longTerm: { enabled: config.longTerm.enabled, maxEntries: config.longTerm.maxEntries, updateEveryNTurns: config.longTerm.extractEveryNTurns,
        entries, organizationHistory, error },
      pendingFacts: pendingBuffer().list().length,
      work: workSnapshot,
    };
  }
  const viewer = createMemoryViewer(context, { getSnapshot, isAvailable: () => active && !disposed && !clearing,
    correctProfile: (id, text) => work.api.correctProfile(id, text),
    deleteQuestion: (id) => work.api.deleteQuestion(id), deleteAnswer: (questionId, answerId) => work.api.deleteAnswer(questionId, answerId) });
  const unregisterClear = context.services.register?.("clear", clear) || (() => {});
  const unregisterWork = context.services.register?.("work", work.api) || (() => {});
  const unregisterOrganize = context.services.register?.("organize", organize) || (() => {});
  const unregisterMenu = context.menu?.register(() => [{ label: "记忆", submenu: [
    { label: "查看当前记忆…", enabled: active && !disposed, click: viewer.show },
    { label: "查看提问记录…", enabled: active && !disposed, click: () => viewer.show("question-history") },
    { label: organizing ? "正在整理记忆…" : "整理",
      enabled: active && !disposed && !organizing && !clearing && !confirmation && options().enabled && (options().longTerm.enabled || options().work.enabled || options().practice.enabled) &&
        Boolean(durable || context.services.get(options().storageService)), click: organizeFromMenu },
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
    organizationController?.abort(new Error("记忆整理已取消"));
    controller = null;
    if (maintenanceTimer) clearInterval(maintenanceTimer);
    maintenanceTimer = null;
    return Promise.allSettled([task, clearing, organizing].filter(Boolean));
  }

  return {
    start() {
      if (disposed) return;
      active = true;
      migratePersonProfiles();
      if ((options().work.enabled || options().practice.enabled) && !maintenanceTimer) {
        maintenanceTimer = setInterval(() => scheduleMaintenance(), 30000);
        maintenanceTimer.unref?.();
      }
      if (totalTurns || options().work.enabled || options().practice.enabled || options().longTerm.enabled && pendingBuffer().list().length) scheduleMaintenance();
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
    async whenIdle() { while (task || clearing || organizing) await Promise.allSettled([task, clearing, organizing].filter(Boolean)); },
  };
}

function activate(context) {
  return createMemoryPlugin(context);
}

module.exports = { activate, createMemoryPlugin, getOptions };
