function avatarWindowSize(ui = {}, renderer, workArea = { width: 1920, height: 1080 }) {
  const requestedWidth = Math.max(280, Math.round(Number(ui.windowWidth) || 380));
  const requestedHeight = Math.max(420, Math.round(Number(ui.windowHeight) || 560));
  return {
    width: Math.min(Math.max(1, workArea.width - 32), renderer === "mmd" ? Math.max(640, requestedWidth) : requestedWidth),
    height: Math.min(Math.max(1, workArea.height - 32), renderer === "mmd" ? Math.max(720, requestedHeight) : requestedHeight),
  };
}
module.exports = { avatarWindowSize };
