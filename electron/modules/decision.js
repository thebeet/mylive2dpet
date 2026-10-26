const { randomUUID } = require("crypto");
const EVENTS = require("../architecture/events");
const { createDecisionResult } = require("../architecture/contracts");
const { createPerceptionService } = require("../architecture/perceptionService");

/** Drain queued observations as a batch when a decision is requested. */
function registerDecisionModule(bus, { decide, perception = createPerceptionService(bus) } = {}) {
  if (typeof decide !== "function") {
    throw new TypeError("decision module requires an injected decision provider");
  }
  const sessionId = randomUUID();
  const sessionStartedAt = Date.now();
  return bus.subscribe(EVENTS.DECISION_REQUESTED, async (request = {}) => {
    const observations = await perception.takeBatch();
    if (observations.length === 0) {
      console.log(
        `[decision:${request.trigger || "manual"}] skipped: no pending observations`,
      );
      return;
    }

    const id = randomUUID();
    let result;
    try {
      request.signal?.throwIfAborted();
      await bus.notify(EVENTS.DECISION_STARTED, {
        id, sessionId, sessionStartedAt,
        trigger: request.trigger,
        observationCount: observations.length,
      });
      result = createDecisionResult(await decide(observations, request));
      request.signal?.throwIfAborted();
    } catch (error) {
      const recovery = await perception.fail(observations, error, { cancelled: request.signal?.aborted });
      await bus.notify(EVENTS.PIPELINE_FAILED, {
        id,
        cancelled: Boolean(request.signal?.aborted),
        stage: "decision",
        trigger: request.trigger,
        observationCount: observations.length,
        error,
        ...recovery,
      });
      return;
    }

    await bus.notify(EVENTS.DECISION_COMPLETED, {
      id, sessionId, sessionStartedAt, completedAt: Date.now(),
      trigger: request.trigger,
      observations,
      result,
    });
    await perception.release(observations, "completed");
  }, { owner: "core:decision" });
}

module.exports = { registerDecisionModule };
