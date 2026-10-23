const { decideFromObservations } = require("../openaiChat");
const EVENTS = require("../architecture/events");

/** Drain queued observations as a batch when a decision is requested. */
function registerDecisionModule(bus) {
  return bus.subscribe(EVENTS.DECISION_REQUESTED, async (request = {}) => {
    const observations = bus
      .takeAll(EVENTS.PERCEPTION_OBSERVATION)
      .sort((left, right) => {
        const leftTime = Date.parse(left.capturedAt) || 0;
        const rightTime = Date.parse(right.capturedAt) || 0;
        return leftTime - rightTime;
      });
    if (observations.length === 0) {
      console.log(
        `[decision:${request.trigger || "manual"}] skipped: no pending observations`,
      );
      return;
    }

    let result;
    try {
      await bus.publish(EVENTS.DECISION_STARTED, {
        trigger: request.trigger,
        observationCount: observations.length,
      });
      result = await decideFromObservations(observations);
    } catch (error) {
      // Keep failed observations at the front of the queue for a later retry.
      bus.requeue(EVENTS.PERCEPTION_OBSERVATION, observations);
      await bus.publish(EVENTS.PIPELINE_FAILED, {
        stage: "decision",
        trigger: request.trigger,
        screenshotCaptured: true,
        observationCount: observations.length,
        error,
      });
      return;
    }

    try {
      await bus.publish(EVENTS.DECISION_COMPLETED, {
        trigger: request.trigger,
        observations,
        result,
      });
    } catch (error) {
      await bus.publish(EVENTS.PIPELINE_FAILED, {
        stage: "execution",
        trigger: request.trigger,
        screenshotCaptured: true,
        observationCount: observations.length,
        error,
      });
    }
  });
}

module.exports = { registerDecisionModule };
