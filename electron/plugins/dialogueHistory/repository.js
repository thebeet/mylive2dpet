/** Backend-independent repository factory. */
function createHistoryRepository(storage, options) {
  return storage.repository("dialogue-history", options);
}
module.exports = { createHistoryRepository };
