const pluginDefinitions = require("./plugins/manifest");
const { getPlugin, isPluginEnabled } = require("./plugins/registry");
const menuHooks = require("./menuHooks");
const { createServiceRegistry } = require("./architecture/serviceRegistry");
const { createContextProviders } = require("./architecture/contextProviders");
const { planPlugins } = require("./architecture/pluginDependencies");
const EVENTS = require("./architecture/events");
const { isDeepStrictEqual } = require("node:util");

/** Loads built-in plugins and supplies only the host capabilities they need. */
function createPluginHost({ bus, getConfig, perception, model, requestDecision, screen, pet,
  paths = {}, windows = {}, dialogs = {}, ipc = {}, attention = {},
  services = createServiceRegistry(),
  contextProviders = createContextProviders(),
  platform = process.platform, logger = console, definitions = pluginDefinitions }) {
  const active = new Map();
  const registrations = new Map();
  const scopes = new Map();
  const states = new Map();
  let activated = false;
  let disposing = false;
  let disposed = false;
  let lifecycle = Promise.resolve();
  let disposal = null;
  let dependencyPlan = null;
  let hostConfig = null;
  let running = false;
  const readConfig = () => hostConfig || getConfig();

  function serialize(operation) {
    const task = lifecycle.then(operation);
    lifecycle = task.catch(() => {});
    return task;
  }

  function logFor(name, level, ...args) {
    const write = logger?.[level] || logger?.log;
    if (typeof write === "function") write.call(logger, `[plugin:${name}]`, ...args);
  }

  async function cleanRegistrations(name) {
    for (const dispose of [...(registrations.get(name) || [])].reverse()) {
      try { await dispose(); } catch (error) { logFor(name, "error", "registration cleanup failed:", error); }
    }
    registrations.delete(name);
  }

  function createContext(name) {
    const scope = { status: "activating", controller: new AbortController() };
    scopes.set(name, scope);
    const available = () => !["stopping", "stopped", "disposing", "disposed"].includes(scope.status);
    function assertAvailable() { if (!available()) throw new Error(`插件已停止或卸载: ${name}`); }
    function assertNotDisposed() { if (scope.status === "disposed") throw new Error(`插件已卸载: ${name}`); }
    const disposers = [];
    registrations.set(name, disposers);
    function track(dispose) {
      let released = false;
      let result;
      const release = () => {
        if (!released) {
          released = true;
          const index = disposers.indexOf(release);
          if (index >= 0) disposers.splice(index, 1);
          result = dispose();
        }
        return result;
      };
      disposers.push(release);
      return release;
    }
    const scopedBus = Object.fromEntries(
      ["publish", "notify"].map((method) => [method, (type, payload) => {
        if (method === "publish") assertAvailable(); else assertNotDisposed();
        if (type === EVENTS.DECISION_REQUESTED) {
          assertAvailable();
          if (typeof requestDecision !== "function") throw new Error("decision scheduling unavailable");
          return requestDecision({ ...payload, signal: payload?.signal
            ? AbortSignal.any([payload.signal, scope.controller.signal]) : scope.controller.signal });
        }
        return bus[method](type, payload);
      }]),
    );
    scopedBus.subscribe = (type, handler, { allowWhileStopped = false } = {}) => {
      assertAvailable();
      if (typeof handler !== "function") throw new TypeError("message handler must be a function");
      return track(bus.subscribe(type, (payload) => {
        if (scope.status === "disposed" || (!available() && !allowWhileStopped)) return;
        return handler(payload);
      }, { owner: `plugin:${name}` }));
    };
    return {
      bus: scopedBus,
      platform,
      paths,
      attention: { getIdleSeconds: () => { assertAvailable(); return attention.getIdleSeconds?.(); } },
      windows: {
        create: (options) => {
          assertAvailable();
          if (typeof windows.create !== "function") throw new Error("window service unavailable");
          const win = windows.create(options);
          const release = track(() => { if (!win.isDestroyed()) win.destroy(); });
          win.once("closed", release);
          return win;
        },
      },
      dialogs: {
        showMessageBox: (options) => {
          assertAvailable();
          if (typeof dialogs.showMessageBox !== "function") throw new Error("dialog service unavailable");
          return dialogs.showMessageBox(options);
        },
      },
      ipc: {
        handle: (channel, handler) => {
          assertAvailable();
          if (typeof ipc.handle !== "function") throw new Error("IPC service unavailable");
          return track(ipc.handle(`${name}:${channel}`, (...args) => { assertAvailable(); return handler(...args); }));
        },
      },
      screen: Object.fromEntries(Object.entries(screen || {}).map(([key, value]) => [key,
        typeof value === "function" ? (...args) => { assertAvailable(); return value(...args); } : value])),
      pet: Object.fromEntries(Object.entries(pet || {}).map(([key, value]) => [key,
        typeof value === "function" ? (...args) => { assertAvailable(); return value(...args); } : value])),
      perception: perception && {
        submit: (...args) => { assertAvailable(); return perception.submit(...args); },
        capture: (...args) => { assertAvailable(); return perception.capture(...args); },
        pendingCount: perception.pendingCount,
        discard: (...args) => { assertNotDisposed(); return perception.discard(...args); },
        registerSource: (source, capture) => {
          assertAvailable();
          return track(perception.registerSource(source, (...args) => { assertAvailable(); return capture(...args); }));
        },
      },
      decisions: {
        request: (options = {}) => {
          assertAvailable();
          if (typeof requestDecision !== "function") throw new Error("decision scheduling unavailable");
          return requestDecision({ ...options, signal: options.signal
            ? AbortSignal.any([options.signal, scope.controller.signal]) : scope.controller.signal });
        },
      },
      model: model && {
        generateText: (messages, options = {}) => {
          assertAvailable();
          return model.generateText(messages, { ...options, signal: options.signal
            ? AbortSignal.any([options.signal, scope.controller.signal]) : scope.controller.signal });
        },
        isAvailable: () => available() && model.isAvailable(),
        getRevision: model.getRevision,
        subscribe: (handler) => {
          assertAvailable();
          return track(model.subscribe(() => { if (available()) handler(); }));
        },
      },
      decisionContext: {
        register: (provide) => {
          assertAvailable();
          return track(contextProviders.register(name, (...args) => available() ? provide(...args) : []));
        },
      },
      services: {
        register: (serviceName, service, { allowWhileStopped = false } = {}) => {
          assertAvailable();
          if (service == null || !["function", "object"].includes(typeof service)) throw new TypeError("服务必须是函数或对象");
          const guard = () => { assertNotDisposed(); if (!allowWhileStopped) assertAvailable(); };
          const guarded = typeof service === "function" ? (...args) => { guard(); return service(...args); }
            : new Proxy(service, { get(target, key) {
              const value = Reflect.get(target, key, target);
              return typeof value === "function" ? (...args) => { guard(); return value.apply(target, args); } : value;
            } });
          return track(services.register(`${name}.${serviceName}`, guarded));
        },
        get: (serviceName) => { assertNotDisposed(); return services.get(serviceName); },
        subscribe: (handler) => {
          assertAvailable();
          return track(services.subscribe((event) => {
            if (available()) handler(event);
          }));
        },
      },
      config: {
        get: () => { assertNotDisposed(); return readConfig(); },
        getPluginOptions: (pluginName, config = readConfig()) =>
          getPlugin(config, pluginName) || {},
        isPluginEnabled: (pluginName, config = readConfig()) =>
          isPluginEnabled(config, pluginName),
      },
      menu: {
        register: (getItems) => {
          assertAvailable();
          function guardItems(items) {
            return items.map((item) => ({ ...item,
              ...(Array.isArray(item.submenu) ? { submenu: guardItems(item.submenu) } : {}),
              ...(typeof item.click === "function" ? { click: (...args) => {
                if (!available()) return;
                try {
                  const result = item.click(...args);
                  if (result?.then) void Promise.resolve(result).catch((error) => logFor(name, "error", "menu action failed:", error));
                } catch (error) { logFor(name, "error", "menu action failed:", error); }
              } } : {}),
            }));
          }
          return track(menuHooks.registerMenuContribution(name, (input) => {
            if (!available()) return [];
            const items = getItems(input);
            return Array.isArray(items) ? guardItems(items) : [];
          }));
        },
        refresh: () => menuHooks.requestMenuRefresh(),
      },
      logger: {
        info: (...args) => logFor(name, "info", ...args),
        warn: (...args) => logFor(name, "warn", ...args),
        error: (...args) => logFor(name, "error", ...args),
      },
    };
  }

  const dependencyValues = (definition, key, config) => typeof definition[key] === "function"
    ? definition[key](config) : definition[key] || [];

  function createPlan(config) {
    const enabled = [];
    const unavailable = new Map();
    const ownedServices = new Set();
    for (const definition of definitions) {
      for (const snapshot of [hostConfig, config].filter(Boolean)) {
        for (const service of dependencyValues(definition, "provides", snapshot)) ownedServices.add(service);
      }
      try {
        if (definition.shouldLoad(config)) enabled.push(definition);
        else unavailable.set(definition.name, { status: "disabled" });
      } catch (error) {
        unavailable.set(definition.name, { status: "failed", reason: error.message });
        logFor(definition.name, "error", error);
      }
    }
    // Existing plugin services must not hide missing providers or dependency order.
    const plan = planPlugins(enabled, config, {
      get: (service) => ownedServices.has(service) ? undefined : services.get(service),
    });
    for (const [name, reason] of plan.blocked) unavailable.set(name, { status: "blocked", reason });
    return { ...plan, unavailable };
  }

  async function activatePlugins(plan) {
    dependencyPlan = plan;
    for (const [name, state] of plan.unavailable) {
      states.set(name, state);
      if (state.reason) logFor(name, "error", state.reason);
    }
    for (const definition of plan.ordered) {
      if (disposing) break;
      if (active.has(definition.name)) continue;
      let handle;
      try {
        const missing = plan.required(definition).filter((service) => !services.get(service));
        if (missing.length) {
          const reason = `必需服务未加载: ${missing.join(", ")}`;
          states.set(definition.name, { status: "blocked", reason }); logFor(definition.name, "error", reason); continue;
        }
        const plugin = definition.load();
        if (typeof plugin.activate !== "function") {
          throw new TypeError("plugin must export activate(context)");
        }
        handle = await plugin.activate(createContext(definition.name));
        if (!handle || typeof handle !== "object") {
          throw new TypeError("activate must return a lifecycle object");
        }
        for (const method of ["start", "stop", "dispose"]) {
          if (handle[method] != null && typeof handle[method] !== "function") {
            throw new TypeError(`plugin ${method} must be a function`);
          }
        }
        active.set(definition.name, { handle, started: false, requires: plan.required(definition) });
        scopes.get(definition.name).status = "active";
        states.set(definition.name, { status: "active" });
        logFor(definition.name, "info", "activated");
      } catch (error) {
        const scope = scopes.get(definition.name);
        if (scope) { scope.status = "disposing"; scope.controller.abort(); }
        try { if (typeof handle?.dispose === "function") await handle.dispose(); }
        catch (rollbackError) { logFor(definition.name, "error", "activation rollback failed:", rollbackError); }
        if (scope) scope.status = "disposed";
        await cleanRegistrations(definition.name);
        states.set(definition.name, { status: "failed", reason: error.message });
        logFor(definition.name, "error", "activation failed:", error);
      }
    }
  }

  function activate() {
    return serialize(async () => {
      if (activated || disposing || disposed) return;
      const config = getConfig();
      const plan = createPlan(config);
      hostConfig = config;
      activated = true;
      await activatePlugins(plan);
    });
  }

  async function startPlugins() {
    for (const { name } of dependencyPlan?.ordered || []) {
      const record = active.get(name);
      if (!record) continue;
      if (disposing) break;
      if (record.started) continue;
      const missing = record.requires.filter((service) => {
        const owner = dependencyPlan.owner(service);
        return !services.get(service) || (owner && !active.get(owner)?.started);
      });
      if (missing.length) {
        states.set(name, { status: "blocked", reason: `必需服务未启动: ${missing.join(", ")}` });
        logFor(name, "error", "required services not running:", missing.join(", "));
        continue;
      }
      try {
        const scope = scopes.get(name);
        if (scope.controller.signal.aborted) scope.controller = new AbortController();
        scope.status = "starting";
        await record.handle.start?.();
        record.started = true;
        scope.status = "running";
        states.set(name, { status: "running" });
      } catch (error) {
        logFor(name, "error", "start failed:", error);
        try { await record.handle.stop?.(); }
        catch (stopError) { logFor(name, "error", "start rollback failed:", stopError); }
        scopes.get(name).status = "stopped";
        scopes.get(name).controller.abort();
        states.set(name, { status: "failed", reason: error.message });
      }
    }
    menuHooks.requestMenuRefresh();
  }

  function start() {
    return serialize(async () => {
      if (disposing || disposed) return;
      running = true;
      await startPlugins();
    });
  }

  function reverseActiveOrder() {
    return (dependencyPlan?.ordered || []).map(({ name }) => name).filter((name) => active.has(name)).reverse();
  }

  async function stopPlugins(names) {
    // Cancel every plugin before waiting; dependencies must not delay cancellation.
    const tasks = names.map(async (name) => {
      const record = active.get(name);
      record.started = false;
      const scope = scopes.get(name);
      scope.status = "stopping";
      scope.controller.abort();
      try { await record.handle.stop?.(); }
      catch (error) { logFor(name, "error", "stop failed:", error); }
      finally { scope.status = "stopped"; states.set(name, { status: "stopped" }); }
    });
    await Promise.all(tasks);
    menuHooks.requestMenuRefresh();
  }

  function stop() {
    return serialize(async () => {
      running = false;
      if (!disposed) await stopPlugins(reverseActiveOrder());
    });
  }

  async function disposePlugins(names) {
    await stopPlugins(names);
    for (const name of names) {
      const { handle } = active.get(name);
      const scope = scopes.get(name);
      scope.status = "disposing";
      try { await handle.dispose?.(); }
      catch (error) { logFor(name, "error", "dispose failed:", error); }
      finally {
        scope.status = "disposed";
        await cleanRegistrations(name);
        active.delete(name);
        scopes.delete(name);
        states.set(name, { status: "disposed" });
      }
    }
  }

  function reload(config = getConfig()) {
    return serialize(async () => {
      if (!activated || disposing || disposed) return;
      const plan = createPlan(config);
      const affected = new Set();
      for (const definition of definitions) {
        const name = definition.name;
        const wasAvailable = !dependencyPlan.unavailable.has(name);
        const isAvailable = !plan.unavailable.has(name);
        if (!isDeepStrictEqual(getPlugin(hostConfig, name), getPlugin(config, name)) ||
            wasAvailable !== isAvailable) affected.add(name);
      }
      // Include transitive consumers of old and new required service providers.
      let changed = true;
      while (changed) {
        changed = false;
        for (const definition of definitions) {
          if (affected.has(definition.name)) continue;
          const dependsOnAffected = [hostConfig, config].some((snapshot) =>
            dependencyValues(definition, "requires", snapshot).some((service) =>
              affected.has(dependencyPlan.owner(service)) || affected.has(plan.owner(service))));
          if (dependsOnAffected) { affected.add(definition.name); changed = true; }
        }
      }
      const names = reverseActiveOrder().filter((name) => affected.has(name));
      for (const name of names) logFor(name, "info", "reloading after configuration change");
      await disposePlugins(names);
      if (disposing || disposed) return;
      // Old instances finish cleanup against the configuration they were using.
      hostConfig = config;
      await activatePlugins(plan);
      if (running) await startPlugins();
      menuHooks.requestMenuRefresh();
    });
  }

  function dispose() {
    if (disposal) return disposal;
    disposing = true;
    disposal = serialize(async () => {
      try {
        running = false;
        await disposePlugins(reverseActiveOrder());
      } finally {
        active.clear();
        activated = false;
        disposed = true;
      }
    });
    return disposal;
  }

  return { activate, start, stop, dispose, reload,
    getState: () => Object.fromEntries([...states].map(([name, state]) => [name, { ...state }])) };
}

module.exports = { createPluginHost };
