/** Backend-neutral repository capabilities used by the application. No SQL crosses this boundary. */
const repositories = Object.freeze({
  "dialogue-history": ["append", "list", "endSessions"],
  "raw-log": ["append", "finish", "list", "get", "rewriteRequests", "listGroups", "getGroup", "clear"],
  memory: ["appendBatch", "retrieve", "list", "organize", "history", "importProfiles", "updateFromDialogue", "isDuplicate", "formatForPrompt", "clear"],
  "work-memory": ["addEvidence", "pending", "applyExtraction", "profiles", "context", "snapshot", "clear", "nextQuestion", "getQuestion", "markShown", "answer", "correctProfile", "getState", "setState", "organize", "migrateWorkDetails", "deleteQuestion", "deleteAnswer"],
  "memory-practice": ["snapshot", "sources", "ingest", "apply", "context", "clear", "history"],
  "memory-updates": ["append", "restoreTurn", "list", "evidence", "stageEvidence", "consume", "clear"],
});
const collectionMethods = ["get", "set", "delete", "list", "clear"];
const blobMethods = ["put", "get", "getMetadata", "updateMetadata", "list", "delete", "clear"];
function validateMethods(value, methods, label) {
  if (!value || methods.some(method => typeof value[method] !== "function")) {
    throw new TypeError(`${label} does not implement: ${methods.join(", ")}`);
  }
  return value;
}
module.exports = { repositories, collectionMethods, blobMethods, validateMethods };
