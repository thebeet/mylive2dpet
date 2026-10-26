const providers = new Map();
let refreshHandler = null;

/** Register a plugin's context-menu items with the core menu host. */
function registerMenuContribution(name, getItems) {
  if (typeof getItems !== "function") {
    throw new TypeError("menu contribution must be a function");
  }
  providers.set(name, getItems);
  return () => {
    if (providers.get(name) === getItems) providers.delete(name);
  };
}

function getMenuContributions(context) {
  const items = [];
  for (const [name, getItems] of providers) {
    try {
      const contribution = getItems(context);
      if (Array.isArray(contribution)) items.push(...contribution);
    } catch (error) {
      console.error(`[menu] plugin contribution failed: ${name}`, error);
    }
  }
  return items;
}

function setMenuRefreshHandler(handler) {
  refreshHandler = typeof handler === "function" ? handler : null;
}

function requestMenuRefresh() {
  refreshHandler?.();
}

module.exports = {
  registerMenuContribution,
  getMenuContributions,
  setMenuRefreshHandler,
  requestMenuRefresh,
};
