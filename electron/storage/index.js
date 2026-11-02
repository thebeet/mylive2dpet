const { repositories, collectionMethods, blobMethods, validateMethods } = require("./contracts");

const STORAGE_SERVICE = "storage";
/** Compatibility for previously configured SQLite service names. */
function storageService(value) {
  if (value == null || value === "storage" || value === "storage-sqlite.database") return STORAGE_SERVICE;
  throw new Error("storageService 请使用核心 storage 服务；后端由存储插件提供");
}

/** Application-owned Storage. Backend registration and resource lifetime belong to provider plugins. */
function createStorage({ services } = {}) {
  let backend = null, revision = 0;
  const listeners = new Set();
  function notify() { for (const listener of [...listeners]) { try { listener({ revision, available: Boolean(backend) }); } catch { /* observer isolation */ } } }
  function current() { if (!backend) throw new Error("Storage backend unavailable"); return backend; }
  function synchronous(value) {
    if (value && typeof value.then === "function") throw new TypeError("Storage operations must be synchronous");
    return value;
  }
  function guard(value, owner) {
    const epoch = revision;
    return new Proxy(value, { get(target, key) {
      const item = Reflect.get(target, key, target);
      return typeof item === "function" ? (...args) => {
        if (backend !== owner || revision !== epoch) throw new Error("Storage backend replaced or unloaded");
        return synchronous(item.apply(target, args));
      } : item;
    } });
  }
  const api = Object.freeze({
    isAvailable: () => Boolean(backend),
    getRevision: () => revision,
    compact() {
      const owner = current();
      return typeof owner.compact === "function" ? synchronous(owner.compact()) : { supported: false };
    },
    subscribe(listener) { if (typeof listener !== "function") throw new TypeError("Storage listener must be a function"); listeners.add(listener); return () => listeners.delete(listener); },
    collection(namespace) {
      if (typeof namespace !== "string" || !namespace.trim() || namespace.length > 200) throw new TypeError("Invalid Storage namespace");
      const owner = current();
      return guard(validateMethods(synchronous(owner.collection(namespace)), collectionMethods, `Storage collection ${namespace}`), owner);
    },
    blobs(namespace) {
      if (typeof namespace !== "string" || !namespace.trim() || namespace.length > 200) throw new TypeError("Invalid Storage namespace");
      const owner = current();
      return guard(validateMethods(synchronous(owner.blobs(namespace)), blobMethods, `Storage blobs ${namespace}`), owner);
    },
    repository(name, options) {
      if (!repositories[name]) throw new Error(`Unknown Storage repository: ${name}`);
      const owner = current();
      return guard(validateMethods(synchronous(owner.repository(name, options)), repositories[name], `Storage repository ${name}`), owner);
    },
    hasRepository(name) {
      if (!repositories[name]) throw new Error(`Unknown Storage repository: ${name}`);
      return synchronous(current().hasRepository(name));
    },
    transaction(work) {
      if (typeof work !== "function") throw new TypeError("Storage transaction requires a callback");
      const owner = current();
      const epoch = revision;
      return synchronous(owner.transaction(() => {
        if (backend !== owner || revision !== epoch) throw new Error("Storage backend replaced or unloaded");
        return synchronous(work(api));
      }));
    },
  });
  function registerBackend(implementation) {
    validateMethods(implementation, ["collection", "blobs", "repository", "hasRepository", "transaction"], "Storage backend");
    if (backend) throw new Error("Storage backend already registered");
    backend = implementation;
    revision++;
    let unregister;
    try { unregister = services?.register(STORAGE_SERVICE, api); }
    catch (error) { backend = null; notify(); throw error; }
    notify();
    const epoch = revision;
    return () => {
      if (backend !== implementation || revision !== epoch) return;
      backend = null;
      revision++;
      unregister?.();
      notify();
    };
  }
  return { api, registerBackend };
}
module.exports = { createStorage, STORAGE_SERVICE, storageService };
