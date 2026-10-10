const DRAG_THRESHOLD_PX = 6;

/** Move the Electron frameless window; distinguish drag from tap for Live2D hits. */
export function setupWindowDrag(root: HTMLElement): {
  wasDragging: () => boolean;
  clearDrag: () => void;
} {
  let active = false;
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let lastY = 0;
  let pointerId = -1;

  const wasDragging = () => dragging;
  const clearDrag = () => {
    dragging = false;
    active = false;
    pointerId = -1;
  };

  if (!window.petDesktop?.isElectron) {
    return { wasDragging, clearDrag };
  }

  root.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    active = true;
    dragging = false;
    pointerId = e.pointerId;
    startX = e.screenX;
    startY = e.screenY;
    lastX = e.screenX;
    lastY = e.screenY;
  }, { capture: true });

  window.addEventListener("pointermove", (e) => {
    if (!active || e.pointerId !== pointerId) return;
    const dist = Math.hypot(e.screenX - startX, e.screenY - startY);
    if (!dragging && dist >= DRAG_THRESHOLD_PX) {
      dragging = true;
    }
    if (!dragging) return;

    const dx = e.screenX - lastX;
    const dy = e.screenY - lastY;
    if (dx === 0 && dy === 0) return;
    // 用整数屏幕坐标，减少 HiDPI 下的累积误差
    window.petDesktop!.moveWindow(dx, dy);
    lastX = e.screenX;
    lastY = e.screenY;
  }, { capture: true });

  const onEnd = (e: PointerEvent) => {
    if (!active || e.pointerId !== pointerId) return;
    active = false;
    pointerId = -1;
  };

  window.addEventListener("pointerup", onEnd, { capture: true });
  window.addEventListener("pointercancel", onEnd, { capture: true });

  return { wasDragging, clearDrag };
}
