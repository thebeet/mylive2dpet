const EVENTS = require("../architecture/events");

/** Connect decisions to the pet's visible and spoken output. */
function createExecutionModule(bus, { sendBubble }) {
  const unsubscribeBubble = bus.subscribe(EVENTS.BUBBLE_OUTPUT_REQUESTED, ({ text, type = "say" }) => {
    if (typeof text !== "string" || !text.trim() || !["say", "error"].includes(type)) return;
    sendBubble({ type, text });
  }, { owner: "core:execution" });

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

  // Called by the decision workflow after all completion observers have recorded the turn.
  async function presentDecision({ result }) {
    if (result.speak === false) { sendBubble({ type: "hide" }); return; }
    sendBubble({
      type: "say",
      text: result.reply,
      expression: result.expression || "neutral",
    });
    await bus.publish(EVENTS.SPEECH_OUTPUT_REQUESTED, {
      text: result.reply,
      expression: result.expression || "neutral",
    });
  }

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

  return { presentDecision, dispose() {
    unsubscribeBubble();
    unsubscribeDecisionStarted();
    unsubscribeFailure();
  } };
}

module.exports = { createExecutionModule };
