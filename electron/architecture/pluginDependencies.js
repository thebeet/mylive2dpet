/** Plan activation by declared services, preserving catalog order for ties. */
function planPlugins(definitions, config, services) {
  const values = (definition, key) => typeof definition[key] === "function"
    ? definition[key](config) : definition[key] || [];
  const providers = new Map();
  for (const definition of definitions) {
    for (const service of values(definition, "provides")) {
      if (providers.has(service)) throw new Error(`重复的服务提供者: ${service}`);
      providers.set(service, definition.name);
    }
  }
  const waiting = new Map(definitions.map((definition) => [definition.name, definition]));
  const ordered = [];
  const completed = new Set();
  const blocked = new Map();
  for (const definition of definitions) {
    const missing = values(definition, "requires").filter((service) => !services.get(service) && !providers.has(service));
    if (missing.length) { blocked.set(definition.name, `缺少必需服务: ${missing.join(", ")}`); waiting.delete(definition.name); }
  }
  while (waiting.size) {
    let progress = false;
    for (const [name, definition] of waiting) {
      const dependencies = [...values(definition, "requires"), ...values(definition, "optional")]
        .filter((service) => !services.get(service))
        .map((service) => providers.get(service)).filter((owner) => owner && owner !== name);
      const failed = values(definition, "requires").map((service) => providers.get(service)).find((owner) => blocked.has(owner));
      if (failed) {
        blocked.set(name, `必需依赖不可用: ${failed}`); waiting.delete(name); progress = true;
      } else if (dependencies.every((owner) => completed.has(owner) || blocked.has(owner))) {
        ordered.push(definition); completed.add(name); waiting.delete(name); progress = true;
      }
    }
    if (!progress) {
      for (const name of waiting.keys()) blocked.set(name, "插件依赖存在循环");
      break;
    }
  }
  return { ordered, blocked, owner: (service) => providers.get(service),
    required: (definition) => values(definition, "requires") };
}

module.exports = { planPlugins };
