type Point = { x: number; y: number };

/** Sample the composited avatar, including texture holes and semi-transparent edges. */
export function createAlphaHitTest(
  canvas: HTMLCanvasElement,
  gl: WebGLRenderingContext | WebGL2RenderingContext,
  render: () => void,
) {
  const pixel = new Uint8Array(4);
  let pointer: Point | null = null;
  let sampled: Point | null = null;
  let hit = false;
  function pixelPosition(position: Point) {
    if (gl.isContextLost()) return null;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const x = Math.floor((position.x - rect.left) * gl.drawingBufferWidth / rect.width);
    const y = Math.floor((position.y - rect.top) * gl.drawingBufferHeight / rect.height);
    if (x < 0 || y < 0 || x >= gl.drawingBufferWidth || y >= gl.drawingBufferHeight) return null;
    return { x, y };
  }
  function afterRender() {
    sampled = pointer && { ...pointer };
    hit = false;
    const point = pointer && pixelPosition(pointer);
    if (!point) return;
    // WebGL's origin is bottom-left. Read immediately after rendering: the default
    // framebuffer need not survive presentation (preserveDrawingBuffer stays off).
    gl.readPixels(point.x, gl.drawingBufferHeight - 1 - point.y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    hit = pixel[3] >= 16;
  }
  return {
    setPointer(position: Point) { pointer = { ...position }; },
    afterRender,
    hitTest(position: Point) {
      if (!sampled || sampled.x !== position.x || sampled.y !== position.y) {
        pointer = { ...position };
        // Global tracking also reports positions far outside this window.
        if (pixelPosition(position)) render();
        afterRender();
      }
      return hit;
    },
  };
}
