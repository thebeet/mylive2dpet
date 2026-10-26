const fs = require("fs");
const path = require("path");
const EVENTS = require("../../architecture/events");
const { getOptions } = require("./options");
const { createScreenChangeDetector } = require("./screenChange");

/** Screenshot policy, observation production and capture cadence belong here. */
function createScreenPerceptionPlugin(context, dependencies = {}) {
  const detector = dependencies.detector || createScreenChangeDetector();
  const setTimer = dependencies.setInterval || setInterval;
  const clearTimer = dependencies.clearInterval || clearInterval;
  const removeFile = dependencies.removeFile || ((filePath) => fs.unlinkSync(filePath));
  let timer = null;
  let generation = 0;
  let pending = Promise.resolve();
  let busy = false;
  let disposed = false;
  let running = true;
  const temporaryFiles = new Set();
  const temporaryDir = path.join(context.paths?.getUserData?.() || path.resolve(__dirname, "../../.."), "cache", "screen-perception");
  fs.mkdirSync(temporaryDir, { recursive: true });
  // Only this plugin's temporary directory is swept; manual captures are retained.
  for (const entry of fs.readdirSync(temporaryDir)) {
    if (entry.endsWith(".jpg")) {
      try { removeFile(path.join(temporaryDir, entry)); } catch { /* stale file cleanup */ }
    }
  }
  function removeTemporary(filePath) {
    if (!temporaryFiles.delete(filePath)) return;
    try { removeFile(filePath); } catch (error) { context.logger.warn("temporary screenshot cleanup failed:", error); }
  }
  const unsubscribeRelease = context.bus.subscribe(EVENTS.PERCEPTION_OBSERVATION_RELEASED, ({ observation }) => {
    for (const part of observation.content) if (part.path) removeTemporary(part.path);
  }, { allowWhileStopped: true });

  async function performCapture(request, captureGeneration) {
    if (disposed) throw new Error("视觉感知插件已卸载");
    if (!running) throw new Error("视觉感知插件已停止");
    if (captureGeneration != null && captureGeneration !== generation) return null;
    const trigger = request.trigger || "screen";
    const shot = await context.screen.captureFullscreen(request.enqueue === false ? {} : { directory: temporaryDir });
    if (request.enqueue !== false) temporaryFiles.add(shot.path);
    // A stopped periodic source must not enqueue the result of an old capture.
    if (disposed || !running || (captureGeneration != null && captureGeneration !== generation)) {
      if (request.enqueue !== false) removeTemporary(shot.path);
      return null;
    }
    if (request.enqueue === false) return shot;
    const options = getOptions(context.config.get());
    let change;
    try { change = detector.compareWithPrevious(shot.path, { options: options.changeDetect }); }
    catch (error) { removeTemporary(shot.path); throw error; }
    if (!change.changed) {
      removeTemporary(shot.path);
      context.logger.info(`screenshot skipped: little change hamming=${change.distance}/${change.threshold}`);
      await context.bus.notify(EVENTS.PERCEPTION_SKIPPED, {
        source: "screen", trigger, reason: "little-change", metadata: change,
      });
      return null;
    }
    try { await context.perception.submit({
      source: "screen",
      trigger,
      expiresAt: Date.now() + options.observationTtlMs,
      content: [{ type: "image", path: shot.path, mimeType: "image/jpeg" }],
      metadata: {
        modality: "screen",
        label: "桌面全屏",
        filename: shot.filename,
        distance: change.distance,
        threshold: change.threshold,
      },
    }); } catch (error) { removeTemporary(shot.path); throw error; }
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
  const unregisterMenu = context.menu.register(() => [{
    label: "截取全屏",
    click: async () => {
      try {
        const shot = await capture({ trigger: "manual-capture", enqueue: false });
        context.logger.info("screenshot saved:", shot.path);
      } catch (error) {
        context.logger.error("screenshot failed:", error);
      }
    },
  }]);

  return {
    start, stop,
    dispose() {
      disposed = true;
      const done = stop();
      unregisterSource();
      unregisterMenu();
      return done.then(async () => {
        await context.perception.discard((item) => item.source === "screen", "plugin-unloaded");
        unsubscribeRelease();
        for (const filePath of [...temporaryFiles]) removeTemporary(filePath);
      });
    },
  };
}

function activate(context) {
  return createScreenPerceptionPlugin(context);
}

module.exports = { activate, createScreenPerceptionPlugin };
