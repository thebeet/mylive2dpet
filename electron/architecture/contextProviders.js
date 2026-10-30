const { createContextBlock } = require("./contracts");

/** Optional context extensions cannot prevent a decision if one fails. */
function createContextProviders({ logger = console } = {}) {
  const providers = new Map();
  let revision = 0;

  function register(name, provide) {
    if (typeof name !== "string" || !name || typeof provide !== "function") {
      throw new TypeError("context provider requires a name and a handler");
    }
    if (providers.has(name)) throw new Error(`上下文提供者已注册: ${name}`);
    providers.set(name, provide);
    revision++;
    return () => {
      if (providers.get(name) === provide) { providers.delete(name); revision++; }
    };
  }

  async function collect(input) {
    const blocks = [];
    for (const [name, provide] of [...providers]) {
      try {
        if (providers.get(name) !== provide) continue;
        const result = await provide(input);
        if (!Array.isArray(result)) throw new TypeError("context provider must return an array");
        const contribution = result.map((block) => {
          const validated = createContextBlock(block);
          return { ...validated, id: `${name}:${validated.id}` };
        });
        if (providers.get(name) === provide) blocks.push(...contribution);
      } catch (error) {
        logger.warn(`[context:${name}] failed:`, error);
      }
    }
    return blocks;
  }

  return { register, collect, getRevision: () => revision };
}

module.exports = { createContextProviders };
