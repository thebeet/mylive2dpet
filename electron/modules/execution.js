const {
  isTtsEnabled,
  prepareReplyAudio,
  playPreparedAudio,
  stopTts,
} = require("../plugins/tts");
const EVENTS = require("../architecture/events");

/** Connect decisions to the pet's visible and spoken output. */
function registerExecutionModule(bus, { sendBubble }) {
  const unsubscribeDecisionStarted = bus.subscribe(
    EVENTS.DECISION_STARTED,
    () => {
      stopTts();
      sendBubble({ type: "thinking" });
    },
  );

  const unsubscribeDecision = bus.subscribe(
    EVENTS.DECISION_COMPLETED,
    ({ result }) => {
      sendBubble({
        type: "say",
        text: result.reply,
        expression: result.expression || "neutral",
      });

      if (isTtsEnabled()) {
        void prepareReplyAudio(result.reply)
          .then((prepared) =>
            playPreparedAudio(prepared, {
              onState: (state) => sendBubble({ type: "tts", state }),
            }),
          )
          .catch((error) => {
            console.error(
              "[tts] prepare/play failed:",
              error instanceof Error ? error.message : error,
            );
          });
      }
    },
  );

  const unsubscribeFailure = bus.subscribe(EVENTS.PIPELINE_FAILED, (event) => {
    console.error(
      `[${event.stage}:${event.trigger || "unknown"}] failed:`,
      event.error,
    );
    // Keep the existing behavior: show a failure only after screen capture worked.
    if (event.screenshotCaptured) {
      sendBubble({
        type: "error",
        text:
          event.error instanceof Error
            ? event.error.message
            : String(event.error),
      });
    }
  });

  return () => {
    unsubscribeDecisionStarted();
    unsubscribeDecision();
    unsubscribeFailure();
  };
}

module.exports = { registerExecutionModule };
