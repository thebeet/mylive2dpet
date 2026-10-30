const { updateWithLlm } = require("./updater");
const { organizeWithLlm } = require("./organizer");

/** Serializes memory updates, organization, and clearing; owns task lifetimes. */
function createMaintenanceCoordinator({ options, model, services, logger, stores,
  getTotalTurns, onUpdated, onInvalidate, clearStores, canClear,
  refresh = () => {}, notifyUpdated = () => {} }) {
  const { pendingBuffer, getDurable, work, practice } = stores;
  let active = true;
  let disposed = false;
  let generation = 0;
  let requested = false;
  let task = null;
  let controller = null;
  let warnedModel = false;
  let clearing = null;
  let organizing = null;
  let organizationController = null;
  let timer = null;

  function valid(snapshot) {
    return active && !disposed && !clearing && snapshot.generation === generation && options().enabled &&
      model?.generateText === snapshot.generate && model?.getRevision?.() === snapshot.modelRevision;
  }

  async function maintainSnapshot() {
    const config = options();
    if (!active || disposed || !config.enabled) return;
    const extractionTurns = config.longTerm.enabled ? pendingBuffer().list() : [];
    const extract = config.longTerm.enabled && extractionTurns.length >= config.longTerm.extractEveryNTurns;
    const extractWork = work.due();
    const extractPractice = practice.due();
    if (!extract && !extractWork && !extractPractice) return;

    const generate = model?.generateText;
    if (typeof generate !== "function" || model?.isAvailable?.() === false) {
      if (!warnedModel) {
        logger.warn("core model unavailable; maintenance deferred");
        warnedModel = true;
      }
      return;
    }
    warnedModel = false;
    const snapshot = { extractionTurns, through: getTotalTurns(), generation, options: config, generate, modelRevision: model?.getRevision?.() };
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
          const storage = services.get(config.storageService);
          const result = storage ? storage.transaction(apply) : apply();
          onUpdated(snapshot.through);
          logger.info(`long-term updated after ${extractionTurns.length} dialogue(s): updated=${result.updated}, added=${result.added}`);
        } catch (error) {
          if (valid(snapshot)) logger.warn("long-term update failed:", error);
        }
      }
      if (extractWork && valid(snapshot)) {
        try {
          await work.maintain({ callChat, valid: () => valid(snapshot),
            applyMemory: (memory, evidence) => {
              if (options().longTerm.enabled) pendingBuffer().stageEvidence(evidence);
            } });
        }
        catch (error) { if (valid(snapshot)) logger.warn("work extraction failed:", error); }
      }
      if (extractPractice && valid(snapshot)) {
        try {
          const result = await practice.maintain({ callChat, valid: () => valid(snapshot) });
          if (result) logger.info(`project/experience updated: updated=${result.updated}, added=${result.added}`);
        } catch (error) { if (valid(snapshot)) logger.warn("project/experience extraction failed:", error); }
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
      if (active && !disposed) logger.warn("maintenance failed:", error);
    }).finally(() => {
      task = null;
      if (requested && active && !disposed) scheduleMaintenance();
    });
  }

  function organize() {
    if (organizing) return organizing;
    const config = options();
    if (!active || disposed || !config.enabled) return Promise.reject(new Error("记忆插件已停止"));
    if (clearing) return Promise.reject(new Error("正在清空记忆，请稍后再整理"));
    if (!config.longTerm.enabled && !config.work.enabled && !config.practice.enabled) return Promise.reject(new Error("长期记忆已关闭，人物画像也未启用"));
    const snapshotGeneration = generation;
    const maintenance = task;
    const abortController = new AbortController();
    organizationController = abortController;
    organizing = Promise.resolve().then(async () => {
      if (maintenance) await maintenance;
      const current = options();
      const generate = model?.generateText;
      const snapshot = { generation: snapshotGeneration, options: current, generate, modelRevision: model?.getRevision?.() };
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
      if (typeof generate !== "function" || model?.isAvailable?.() === false) throw new Error("AI 文本服务不可用，请稍后重试");
      logger.info(`memory organization: ${entries.length} facts, ${profiles?.length || 0} work profiles`);
      const plan = await organizeWithLlm({ entries, profiles, practice: practiceSnapshot, signal: abortController.signal,
        callChat: (messages, settings) => generate(messages, {
          ...settings, signal: abortController.signal,
        }) });
      if (!isValid()) throw new Error("记忆整理已取消");
      let result;
      if (profiles !== undefined || practiceSnapshot !== undefined) {
        const storage = services.get(current.storageService);
        if (!storage) throw new Error("人物记忆存储不可用");
        result = storage.transaction(() => ({ ...(store ? store.organize(plan, entries) : empty),
          ...(profiles !== undefined ? { work: work.organize(plan.workProfiles, profiles) } : {}),
          ...(practiceSnapshot !== undefined ? { practice: practice.organize(plan.practice, practiceSnapshot) } : {}) }));
        notifyUpdated();
      } else result = store.organize(plan, entries);
      logger.info(`long-term organized: ${result.before} -> ${result.after}; merged=${result.merged} archived=${result.archived}`);
      if (result.work) logger.info(`work profiles organized: ${result.work.before} -> ${result.work.after}; merged=${result.work.merged} archived=${result.work.archived}`);
      return result;
    }).finally(() => {
      organizing = null;
      if (organizationController === abortController) organizationController = null;
      refresh();
      if (requested && active && !disposed && !clearing) scheduleMaintenance();
    });
    refresh();
    return organizing;
  }

  function clear() {
    if (clearing) return clearing;
    if (!isRunning()) return Promise.reject(new Error("记忆插件已停止"));
    if (!canClear()) return Promise.reject(new Error("长期记忆存储不可用，无法清空全部记忆"));
    generation += 1;
    requested = false;
    controller?.abort();
    organizationController?.abort(new Error("记忆整理已取消"));
    onInvalidate();
    const maintenance = task;
    const organization = organizing;
    clearing = Promise.resolve().then(async () => {
      if (maintenance) await maintenance;
      if (organization) await organization.catch(() => {});
      return clearStores();
    }).finally(() => { clearing = null; refresh(); });
    refresh();
    return clearing;
  }

  // Service restoration is a maintenance trigger; context reads remain queries.
  const unsubscribeServices = services.subscribe?.(({ name }) => {
    const config = options();
    if (name === config.storageService) scheduleMaintenance();
  }) || (() => {});

  const unsubscribeModel = model?.subscribe?.(() => {
    generation++;
    controller?.abort(new Error("核心模型已更新"));
    organizationController?.abort(new Error("核心模型已更新"));
    scheduleMaintenance();
  }) || (() => {});

  function isRunning() { return active && !disposed; }
  function isAvailable() { return isRunning() && !clearing; }

  function start() {
    if (disposed) return;
    active = true;
    const config = options();
    if ((config.longTerm.enabled || config.work.enabled || config.practice.enabled) && !timer) {
      timer = setInterval(scheduleMaintenance, 30000);
      timer.unref?.();
    }
    scheduleMaintenance();
  }

  function stop() {
    active = false;
    requested = false;
    generation += 1;
    controller?.abort();
    organizationController?.abort(new Error("记忆整理已取消"));
    controller = null;
    if (timer) clearInterval(timer);
    timer = null;
    return Promise.allSettled([task, clearing, organizing].filter(Boolean));
  }

  return {
    request: scheduleMaintenance, organize, clear, start, stop, isRunning, isAvailable,
    dispose() { const done = stop(); disposed = true; unsubscribeServices(); unsubscribeModel(); return done; },
    getState: () => ({ generation, maintaining: Boolean(task || organizing),
      organizing: Boolean(organizing), clearing: Boolean(clearing) }),
    async whenIdle() {
      while (task || clearing || organizing) await Promise.allSettled([task, clearing, organizing].filter(Boolean));
    },
  };
}

module.exports = { createMaintenanceCoordinator };
