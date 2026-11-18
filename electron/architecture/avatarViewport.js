function avatarWindowSize(ui = {}, renderer, workArea = { width: 1920, height: 1080 }) {
  const requestedWidth = Math.max(280, Math.round(Number(ui.windowWidth) || 380));
  const requestedHeight = Math.max(420, Math.round(Number(ui.windowHeight) || 560));
  return {
    width: Math.min(Math.max(1, workArea.width - 32), renderer === "mmd" ? Math.max(640, requestedWidth) : requestedWidth),
    height: Math.min(Math.max(1, workArea.height - 32), renderer === "mmd" ? Math.max(720, requestedHeight) : requestedHeight),
  };
}
/** Keep the feet and horizontal center in place while making room above the model. */
function avatarWindowBounds(previous, requested, area) {
  const width = Math.min(Math.max(1, area.width - 32), Math.max(1, Math.ceil(requested.width)));
  const height = Math.min(Math.max(1, area.height - 32), Math.max(1, Math.ceil(requested.height)));
  return {
    width, height,
    x: Math.round(Math.max(area.x, Math.min(previous.x + (previous.width - width) / 2, area.x + area.width - width))),
    y: Math.round(Math.max(area.y, Math.min(previous.y + previous.height - height, area.y + area.height - height))),
  };
}
module.exports = { avatarWindowSize, avatarWindowBounds };
