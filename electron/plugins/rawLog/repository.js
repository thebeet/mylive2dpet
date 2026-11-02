/** Backend-independent repository factory. */
const { compactRequestImages, requestImagePreviews } = require("./images");
const { LOG_LIFECYCLE, getLogGeneration } = require("../../storage/logLifecycle");

function createRawLogRepository(storage, options) {
  const repository = storage.repository("raw-log", options);
  const migrations = storage.collection("raw-log.migrations");
  if (!migrations.get("image-references-v1")) {
    repository.rewriteRequests(request => compactRequestImages(storage, request));
    migrations.set("image-references-v1", true);
  }
  return {
    append(entry) {
      if (entry.logGeneration != null && entry.logGeneration !== getLogGeneration(storage)) return;
      return storage.transaction(() => repository.append({ ...entry,
        request: compactRequestImages(storage, entry.request, entry.imageReferences) }));
    },
    finish: entry => repository.finish(entry),
    clear() {
      return storage.transaction(() => {
        const generation = getLogGeneration(storage) + 1;
        const requests = repository.clear();
        const screenshots = storage.blobs("screenshots").clear();
        const requestImages = storage.blobs("raw-log-images").clear();
        storage.collection("raw-log.image-index").clear();
        const diagnostics = storage.collection("core.ai-log").list().length;
        storage.collection("core.ai-log").clear();
        storage.collection(LOG_LIFECYCLE).set("generation", generation);
        return { requests, screenshots, requestImages, diagnostics, generation };
      });
    },
    list: options => repository.list(options),
    listGroups: options => repository.listGroups(options),
    getGroup(id) {
      const records = repository.getGroup(id);
      const first = records.find(record => record.conversation?.kind !== "summary") || records[0];
      return { initialMessages: first.request.messages?.slice(0, -1) || [],
        entries: records.map(({ request, ...record }) => ({ ...record,
          input: request.messages?.at(-1),
          parameters: Object.fromEntries(Object.entries(request).filter(([key]) => key !== "messages")),
        })) };
    },
    get(id) {
      const result = repository.get(id);
      return { ...result, imagePreviews: requestImagePreviews(storage, result.request) };
    },
  };
}
module.exports = { createRawLogRepository };
