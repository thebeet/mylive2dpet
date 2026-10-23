const fs = require("fs");
const path = require("path");
const { loadConfig } = require("../config");
const { captureFullscreenToJpg } = require("../screenshot");
const { compareWithPrevious } = require("../screenChange");
const EVENTS = require("../architecture/events");

function captureScreenshot() {
  return captureFullscreenToJpg();
}

/** Capture screenshots and enqueue them as perception observations. */
function registerPerceptionModule(bus) {
  return bus.subscribe(EVENTS.SCREENSHOT_CAPTURE_REQUESTED, async (request = {}) => {
    const trigger = request.trigger || "";
    const isRegion = Boolean(request.imagePath) || trigger === "region";
    let screenshotCaptured = false;

    try {
      const shot = request.imagePath
        ? {
            path: request.imagePath,
            filename: path.basename(request.imagePath),
          }
        : await captureScreenshot();

      if (request.imagePath && !fs.existsSync(shot.path)) {
        throw new Error(`截图不存在: ${shot.path}`);
      }

      const change = compareWithPrevious(shot.path, { config: loadConfig() });
      if (!change.changed) {
        try {
          fs.unlinkSync(shot.path);
        } catch {
          // Ignore cleanup failures; unchanged screenshots are still skipped.
        }
        await bus.publish(EVENTS.PERCEPTION_SKIPPED, {
          trigger,
          distance: change.distance,
          threshold: change.threshold,
          screenshotPath: shot.path,
          screenshotFilename: shot.filename,
        });
        return;
      }

      screenshotCaptured = true;
      const observation = {
        trigger,
        kind: isRegion ? "region" : "fullscreen",
        screenshotPath: shot.path,
        screenshotFilename: shot.filename,
        capturedAt: new Date().toISOString(),
        distance: change.distance,
        threshold: change.threshold,
      };

      const pendingCount = bus.enqueue(EVENTS.PERCEPTION_OBSERVATION, observation);
      await bus.publish(EVENTS.PERCEPTION_OBSERVATION_QUEUED, {
        observation,
        pendingCount,
      });
    } catch (error) {
      await bus.publish(EVENTS.PIPELINE_FAILED, {
        stage: "perception",
        trigger,
        screenshotCaptured,
        error,
      });
    }
  });
}

module.exports = { registerPerceptionModule, captureScreenshot };
