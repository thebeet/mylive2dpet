const EVENTS = require("../../architecture/events");
const { getOptions } = require("./options");
const { createScreenChangeDetector } = require("./screenChange");
const { getLogGeneration } = require("../../storage/logLifecycle");

/** Screenshot policy, observation production and capture cadence belong here. */
function createScreenPerceptionPlugin(context, dependencies = {}) {
  const detector = dependencies.detector || createScreenChangeDetector();
  const setTimer = dependencies.setInterval || setInterval;
  const clearTimer = dependencies.clearInterval || clearInterval;
  let timer = null;
  let generation = 0;
  let pending = Promise.resolve();
  let busy = false;
  let disposed = false;
  let running = true;
  const unsubscribeClear = context.bus.subscribe(EVENTS.RAW_LOG_CLEARED, () => detector.reset(), { allowWhileStopped: true });
  const unsubscribeDecision = context.bus.subscribe(EVENTS.DECISION_COMPLETED, event => {
    const ids = [...new Set(event.observations.flatMap(observation => observation.content
      .filter(part => part.type === "image")
      .map(part => /^storage:\/\/screenshots\/([^/?#]+)$/.exec(part.uri || "")?.[1])
      .filter(Boolean)))];
    if (!ids.length) return;
    const blobs = context.storage.blobs("screenshots");
    context.storage.transaction(() => {
      for (const id of ids) {
        const record = blobs.getMetadata(id);
        if (!record) continue;
        const analyses = record.metadata.analyses || [];
        if (analyses.some(item => item.decisionId === event.id)) continue;
        blobs.updateMetadata(id, { analyses: [...analyses, {
          decisionId: event.id, completedAt: event.completedAt,
          screenshotIds: ids,
          screenSummary: event.result.summaries?.screen || "",
          workSummary: event.result.summaries?.work || "",
        }] });
      }
    });
  }, { allowWhileStopped: true });
  async function performCapture(request, captureGeneration) {
    if (disposed) throw new Error("视觉感知插件已卸载");
    if (!running) throw new Error("视觉感知插件已停止");
    if (captureGeneration != null && captureGeneration !== generation) return null;
    const trigger = request.trigger || "screen";
    const logGeneration = getLogGeneration(context.storage);
    const captured = await context.screen.captureFullscreen();
    // A stopped source must not persist or enqueue a late capture.
    if (disposed || !running || (captureGeneration != null && captureGeneration !== generation)) return null;
    if (logGeneration !== getLogGeneration(context.storage)) return null;
    let options, change;
    if (request.enqueue !== false) {
      options = getOptions(context.config.get());
      change = detector.compareWithPrevious(captured.data, { options: options.changeDetect });
      if (!change.changed) {
        context.logger.info(`screenshot skipped: little change hamming=${change.distance}/${change.threshold}`);
        await context.bus.notify(EVENTS.PERCEPTION_SKIPPED, {
          source: "screen", trigger, reason: "little-change", metadata: change,
        });
        return null;
      }
    }
    const saved = context.storage.blobs("screenshots").put(captured.data, {
      filename: captured.filename, width: captured.width, height: captured.height,
      capturedAt: captured.capturedAt || new Date().toISOString(),
      mimeType: captured.mimeType || "image/jpeg", trigger,
      manual: request.enqueue === false,
    });
    const shot = { ...saved.metadata, id: saved.id, size: saved.size,
      uri: `storage://screenshots/${saved.id}` };
    if (request.enqueue === false) return shot;
    await context.perception.submit({
      source: "screen",
      trigger,
      expiresAt: Date.now() + options.observationTtlMs,
      capturedAt: shot.capturedAt,
      content: [{ type: "image", uri: shot.uri, mimeType: shot.mimeType }],
      metadata: {
        modality: "screen",
        label: "桌面全屏",
        filename: shot.filename,
        screenshotId: shot.id,
        distance: change.distance,
        threshold: change.threshold,
      },
    });
    return shot;
  }

  function capture(request = {}, captureGeneration) {
    // Serialize explicit and periodic captures so hashes are updated in order.
    busy = true;
    const task = pending.then(() => performCapture(request, captureGeneration));
    const settled = task.catch(() => {}).finally(() => {
      if (pending === settled) busy = false;
    });
    pending = settled;
    return task;
  }

  async function capturePeriodic(captureGeneration) {
    if (busy || captureGeneration !== generation) return;
    try {
      await capture({ trigger: "interval" }, captureGeneration);
    } catch (error) {
      await context.bus.notify(EVENTS.PIPELINE_FAILED, {
        stage: "perception", trigger: "interval", source: "screen", error,
      });
    }
  }

  function stop() {
    running = false;
    generation += 1;
    if (timer != null) clearTimer(timer);
    timer = null;
    return pending;
  }

  function start() {
    if (disposed) return;
    stop();
    running = true;
    const options = getOptions(context.config.get());
    if (!options.enabled || options.intervalMs <= 0) {
      context.logger.info("automatic screenshot capture disabled");
      return;
    }
    detector.reset();
    const captureGeneration = generation;
    context.logger.info(`capture every ${options.intervalMs}ms`);
    void capturePeriodic(captureGeneration);
    timer = setTimer(() => void capturePeriodic(captureGeneration), options.intervalMs);
  }

  const unregisterSource = context.perception.registerSource("screen", capture);

  return {
    start, stop,
    dispose() {
      disposed = true;
      const done = stop();
      unregisterSource();
      return done.then(async () => {
        await context.perception.discard((item) => item.source === "screen", "plugin-unloaded");
        unsubscribeDecision();
        unsubscribeClear();
      });
    },
  };
}

function activate(context) {
  const unregisterPrompt = context.systemPrompt.register(require("./prompt").promptExtension);
  const plugin = createScreenPerceptionPlugin(context);
  return { ...plugin, dispose() { unregisterPrompt(); return plugin.dispose(); } };
}

module.exports = { activate, createScreenPerceptionPlugin };
