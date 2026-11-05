/** Shared main-process lifecycle and menus; renderer implementations remain independent. */
function activateAvatar(context, descriptor) {
  let release = null;
  context.menu.register(() => [
    {
      label: "播放动作",
      enabled: context.avatar.isReady() && descriptor.motions.length > 0,
      submenu: descriptor.motions.map(({ id, label }) => ({
        label, click: () => context.avatar.command({ type: "motion", id }),
      })),
    },
    {
      label: "切换表情",
      enabled: context.avatar.isReady() && descriptor.expressions.length > 0,
      submenu: descriptor.expressions.map(id => ({
        label: id, click: () => context.avatar.command({ type: "expression", id }),
      })),
    },
    ...(descriptor.controls?.includes("resetRotation") ? [{
      label: "角度回正",
      enabled: context.avatar.isReady(),
      click: () => context.avatar.command({ type: "control", id: "resetRotation" }),
    }] : []),
  ]);
  const stop = () => { release?.(); release = null; };
  return {
    start() { if (!release) release = context.avatar.register(descriptor); },
    stop,
    dispose: stop,
  };
}
module.exports = { activateAvatar };
