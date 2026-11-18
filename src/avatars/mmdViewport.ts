/** Stable full-body framing leaves room for outstretched arms and lifted props. */
export function mmdViewport(height: number, width: number, viewportHeight: number, scale: number, verticalOffset: number) {
  const aspect = Math.max(1, width) / Math.max(1, viewportHeight);
  const safeHeight = height / (0.68 * scale);
  const diameter = height * 1.4 / scale;
  const visibleHeight = Math.max(safeHeight, diameter / aspect);
  const shift = visibleHeight * 0.035 + verticalOffset * visibleHeight / Math.max(1, viewportHeight);
  return {
    left: -visibleHeight * aspect / 2, right: visibleHeight * aspect / 2,
    top: visibleHeight / 2 + shift, bottom: -visibleHeight / 2 + shift,
  };
}

/** Include the body, spread arms and raised hat in the stable model viewport. */
export function mmdContentBounds(height: number, width: number, viewportHeight: number, scale: number, verticalOffset: number) {
  const frame = mmdViewport(height, width, viewportHeight, scale, verticalOffset);
  const pixelsPerUnit = viewportHeight / (frame.top - frame.bottom);
  return {
    x: (-height * 0.7 - frame.left) * pixelsPerUnit,
    y: (frame.top - height * 0.8) * pixelsPerUnit,
    width: height * 1.4 * pixelsPerUnit,
    height: height * 1.4 * pixelsPerUnit,
  };
}

export function extendMmdViewport(
  frame: ReturnType<typeof mmdViewport>,
  viewport: { height: number; scale: number; x: number; y: number },
  width: number, height: number,
) {
  const unitsPerPixel = (frame.top - frame.bottom) / (viewport.height * viewport.scale);
  const left = frame.left - viewport.x * unitsPerPixel;
  const top = frame.top + viewport.y * unitsPerPixel;
  return { left, right: left + width * unitsPerPixel, top, bottom: top - height * unitsPerPixel };
}
