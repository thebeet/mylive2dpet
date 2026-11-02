/** Shared deletion generation prevents pre-cleanup work from restoring old log/image records. */
const LOG_LIFECYCLE = "core.log-lifecycle";
function getLogGeneration(storage) {
  return storage?.isAvailable?.() ? storage.collection(LOG_LIFECYCLE).get("generation") || 0 : 0;
}
module.exports = { LOG_LIFECYCLE, getLogGeneration };
