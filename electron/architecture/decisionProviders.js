const { createDecisionResult } = require("./contracts");
const { createContextProviders } = require("./contextProviders");

/** Select exactly one provider for each request; registration does not run it. */
function createDecisionProviders(getSelectedProvider, { contextProviders = createContextProviders() } = {}) {
  const providers = new Map();

  function register(name, decide) {
    if (typeof name !== "string" || !name || typeof decide !== "function") {
      throw new TypeError("decision provider requires a name and a handler");
    }
    if (providers.has(name)) throw new Error(`决策实现已注册: ${name}`);
    providers.set(name, decide);
    return () => {
      if (providers.get(name) === decide) providers.delete(name);
    };
  }

  async function decide(input) {
    const name = getSelectedProvider();
    const provider = providers.get(name);
    if (!provider) throw new Error(`决策插件未加载: ${name}`);
    const context = await contextProviders.collect(input);
    if (providers.get(name) !== provider) throw new Error(`决策插件已卸载: ${name}`);
    return createDecisionResult(await provider({ ...input, context }));
  }

  return { register, decide, has: (name) => providers.has(name), contextProviders };
}

module.exports = { createDecisionProviders };
