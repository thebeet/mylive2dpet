const EVENTS = require("../architecture/events");

/** Connect decisions to the pet's visible and spoken output. */
function registerExecutionModule(bus, { sendBubble }) {
  const unsubscribeDecisionStarted = bus.subscribe(
    EVENTS.DECISION_STARTED,
    async () => {
      await bus.publish(EVENTS.SPEECH_OUTPUT_STOP_REQUESTED, {
        reason: "decision-started",
      });
      sendBubble({ type: "thinking" });
    },
    { owner: "core:execution" },
  );

  const unsubscribeDecision = bus.subscribe(
    EVENTS.DECISION_COMPLETED,
    async ({ result, trigger, observations }) => {
      try {
        sendBubble({
          type: "say",
          text: result.reply,
          expression: result.expression || "neutral",
        });
        await bus.publish(EVENTS.SPEECH_OUTPUT_REQUESTED, {
          text: result.reply,
          expression: result.expression || "neutral",
        });
      } catch (error) {
        await bus.notify(EVENTS.PIPELINE_FAILED, {
          stage: "execution", trigger, observationCount: observations?.length || 0, error,
        });
      }
    },
    { owner: "core:execution" },
  );

  const unsubscribeFailure = bus.subscribe(EVENTS.PIPELINE_FAILED, (event) => {
    if (event.cancelled) return;
    console.error(
      `[${event.stage}:${event.trigger || "unknown"}] failed:`,
      event.error,
    );
    if (event.observationCount > 0) {
      sendBubble({
        type: "error",
        text:
          event.error instanceof Error
            ? event.error.message
            : String(event.error),
      });
    }
  }, { owner: "core:execution" });

  return () => {
    unsubscribeDecisionStarted();
    unsubscribeDecision();
    unsubscribeFailure();
  };
}

module.exports = { registerExecutionModule };
