/** Named plugin capabilities; the registry does not interpret their contents. */
function createServiceRegistry({ logger = console } = {}) {
  const services = new Map();
  const listeners = new Set();

  function notify(name, service) {
    for (const listener of [...listeners]) {
      try { listener({ name, service }); }
      catch (error) {
        try { logger.warn("service observer failed:", error); }
        catch { /* Observers must not interrupt service registration or removal. */ }
      }
    }
  }

  function register(name, service) {
    if (typeof name !== "string" || !name || service == null) {
      throw new TypeError("service requires a name and an implementation");
    }
    if (services.has(name)) throw new Error(`服务已注册: ${name}`);
    services.set(name, service);
    notify(name, service);
    return () => {
      if (services.get(name) === service) {
        services.delete(name);
        notify(name, undefined);
      }
    };
  }

  function subscribe(listener) {
    if (typeof listener !== "function") throw new TypeError("service observer must be a function");
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return { register, subscribe, get: (name) => services.get(name) };
}

module.exports = { createServiceRegistry };
