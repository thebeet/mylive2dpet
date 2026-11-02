/** Backend-independent repository factory. */
function createPracticeStore(storage, options) {
  return storage.repository("memory-practice", options);
}
module.exports = { createPracticeStore };
