/** Named plugin capabilities; the registry does not interpret their contents. */
function createServiceRegistry() {
  const services = new Map();

  function register(name, service) {
    if (typeof name !== "string" || !name || service == null) {
      throw new TypeError("service requires a name and an implementation");
    }
    if (services.has(name)) throw new Error(`服务已注册: ${name}`);
    services.set(name, service);
    return () => {
      if (services.get(name) === service) services.delete(name);
    };
  }

  return { register, get: (name) => services.get(name) };
}

module.exports = { createServiceRegistry };
