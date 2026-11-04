const { object, freeze } = require("./configValidation");

/** Trusted plugin instructions and output declarations, independent of observation context. */
function createPromptExtensions() {
  const extensions = new Map();

  function register(name, extension, { isActive = () => true } = {}) {
    if (typeof name !== "string" || !name || extensions.has(name)) throw new Error(`系统提示词扩展名称无效或重复: ${name}`);
    if (!object(extension) || typeof extension.text !== "string" || !extension.text.trim()) {
      throw new TypeError("system prompt extension requires non-empty text");
    }
    const schemas = extension.effectSchemas ?? [];
    const summarySchemas = extension.summarySchemas ?? {};
    if (!object(summarySchemas) || Object.values(summarySchemas).some((schema) => !object(schema) || schema.type !== "string")) {
      throw new TypeError("summarySchemas must map names to string schemas");
    }
    if (extension.validateSummaries != null && typeof extension.validateSummaries !== "function") {
      throw new TypeError("validateSummaries must be a function");
    }
    if (extension.selectSummaryFields != null && typeof extension.selectSummaryFields !== "function") {
      throw new TypeError("selectSummaryFields must be a function");
    }
    for (const key of Object.keys(summarySchemas)) {
      if (!key || [...extensions.values()].some((entry) => Object.hasOwn(entry.contribution.summarySchemas, key))) {
        throw new Error(`摘要字段名称无效或重复: ${key}`);
      }
    }
    if (!Array.isArray(schemas)) throw new TypeError("effectSchemas must be an array");
    for (const schema of schemas) {
      if (!object(schema) || schema.type !== "object" || schema.additionalProperties !== false ||
          !object(schema.properties) || !Array.isArray(schema.required) ||
          Object.keys(schema.properties).some((key) => !schema.required.includes(key))) {
        throw new TypeError("effect schemas must be strict object schemas with all properties required");
      }
    }
    const entry = { contribution: freeze(JSON.parse(JSON.stringify({ text: extension.text.trim(), effectSchemas: schemas, summarySchemas }))),
      validateSummaries: extension.validateSummaries, selectSummaryFields: extension.selectSummaryFields, isActive };
    extensions.set(name, entry);
    return () => { if (extensions.get(name) === entry) extensions.delete(name); };
  }

  function collect(input) {
    const active = [...extensions].filter(([, entry]) => entry.isActive());
    const declarations = active
      .map(([name, entry]) => ({ name, ...entry.contribution }));
    const contributions = declarations.map((contribution, index) => {
      const select = active[index][1].selectSummaryFields;
      if (!input || !select) return contribution;
      const names = select(input);
      if (!Array.isArray(names) || names.some((name) => !Object.hasOwn(contribution.summarySchemas, name))) {
        throw new TypeError(`插件 ${contribution.name} must select declared summary field names`);
      }
      return { ...contribution, summarySchemas: Object.fromEntries(names.map((name) => [name, contribution.summarySchemas[name]])) };
    });
    return {
      contributions,
      effectSchemas: contributions.flatMap((entry) => entry.effectSchemas),
      summarySchemas: Object.fromEntries(contributions.flatMap((entry) => Object.entries(entry.summarySchemas))),
      summaryValidators: active.filter(([, entry]) => entry.validateSummaries)
        .map(([name, entry]) => ({ name, validate: entry.validateSummaries })),
      // Input modality changes the request schema, not the plugin configuration or history segment.
      signature: JSON.stringify(declarations),
    };
  }

  return { register, collect };
}

module.exports = { createPromptExtensions };
