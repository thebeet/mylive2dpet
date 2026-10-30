const object = (value) => value && typeof value === "object" && !Array.isArray(value);

function dictionary(value, name) {
  if (value != null && !object(value)) throw new Error(`${name} 必须是对象`);
}

function number(value, fallback, min, max, name) {
  const result = value == null ? fallback : Number(value);
  if (!Number.isFinite(result) || result < min || result > max) throw new Error(`${name} 超出允许范围`);
  return Math.floor(result);
}

function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

/** Shared validation primitives; each plugin declares its own option structure. */
function validateOptions(plugin, { objects = [], toggles = [], capture = false } = {}) {
  for (const key of objects) dictionary(plugin?.[key], `plugins.${plugin?.name}.${key}`);
  for (const key of toggles) {
    if (plugin?.[key]?.enabled != null && typeof plugin[key].enabled !== "boolean") {
      throw new Error(`plugins.${plugin.name}.${key}.enabled 必须是布尔值`);
    }
  }
  if (capture && plugin?.interval_ms != null) number(plugin.interval_ms, 5000, -86400000, 86400000, "plugin.interval_ms");
  if (capture && plugin?.observationTtlMs != null) number(plugin.observationTtlMs, 60000, 1000, 86400000, "plugin.observationTtlMs");
}

module.exports = { object, dictionary, number, freeze, validateOptions };
