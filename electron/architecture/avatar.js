/** One active presentation provider. Renderer acknowledgements and commands are generation-scoped. */
function createAvatarHost({ onChange = () => {}, sendCommand = () => {} } = {}) {
  let current = null;
  let revision = 0;
  let ready = false;
  const snapshot = () => ({ revision, avatar: current ? { ...current.descriptor, plugin: current.name } : null });
  return {
    getSnapshot: snapshot,
    getExpressions: () => current?.descriptor.expressions || ["neutral"],
    getIconPath: () => current?.descriptor.iconPath || "",
    isReady: (name) => ready && current?.name === name,
    setReady(generation) {
      if (!current || generation !== revision) return false;
      ready = true;
      return true;
    },
    resetReady() { ready = false; },
    register(name, descriptor) {
      if (current) throw new Error(`已有启用的形象插件: ${current.name}`);
      const entry = { name, descriptor };
      current = entry;
      revision++;
      ready = false;
      onChange(snapshot());
      return () => {
        if (current !== entry) return;
        current = null;
        revision++;
        ready = false;
        onChange(snapshot());
      };
    },
    command(name, command) {
      if (!ready || current?.name !== name) return false;
      const allowed = command.type === "expression" ? current.descriptor.expressions
        : command.type === "motion" ? current.descriptor.motions.map(({ id }) => id)
        : command.type === "control" ? current.descriptor.controls || [] : [];
      if (!allowed.includes(command.id)) return false;
      sendCommand({ ...command, revision });
      return true;
    },
  };
}
module.exports = { createAvatarHost };
