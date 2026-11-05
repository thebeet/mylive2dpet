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
