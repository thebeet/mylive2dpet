module.exports = Object.freeze({
  AI_REQUEST_STARTED: "ai.request.started",
  AI_REQUEST_FINISHED: "ai.request.finished",
  PERCEPTION_OBSERVATION: "perception.observation",
  PERCEPTION_OBSERVATION_QUEUED: "perception.observation.queued",
  PERCEPTION_OBSERVATION_RELEASED: "perception.observation.released",
  PERCEPTION_SKIPPED: "perception.skipped",
  SPEECH_OUTPUT_REQUESTED: "execution.speech.requested",
  SPEECH_OUTPUT_STOP_REQUESTED: "execution.speech.stop.requested",
  SPEECH_OUTPUT_STATE: "execution.speech.state",
  // Compatibility alias for existing observers during event migration.
  TTS_PLAYBACK_STATE: "execution.speech.state",
  DECISION_REQUESTED: "decision.requested",
  DECISION_STARTED: "decision.started",
  DECISION_COMPLETED: "decision.completed",
  PIPELINE_FAILED: "pipeline.failed",
  WORK_MEMORY_UPDATED: "memory.work.updated",
  MEMORY_CLEARED: "memory.cleared",
});
