import "./style.css";
import { setupWindowDrag } from "./windowDrag";
import { createSpeechBubble } from "./speechBubble";
import type { AvatarRenderer, AvatarSnapshot } from "./avatars/types";
import { fitAvatarLayout, type AvatarViewport, type ViewportLimits } from "./avatarLayout";

async function main() {
  const mount = document.getElementById("app");
  if (!mount) throw new Error("#app not found");
  let active: AvatarRenderer | null = null;
  let limits: ViewportLimits = { width: window.innerWidth, height: window.innerHeight,
    maxWidth: window.innerWidth, maxHeight: window.innerHeight };
  let viewport: AvatarViewport = { ...limits, x: 0, y: 0, scale: 1 };
  let layoutSize = "";
  const canRotate = (event: PointerEvent) => !!active?.rotate &&
    active.hitTest({ x: event.clientX, y: event.clientY });
  const hitsAvatar = (event: PointerEvent) => !!active?.hitTest({ x: event.clientX, y: event.clientY });
  const drag = setupWindowDrag(mount, hitsAvatar);
  let controller: AbortController | null = null;
  let revision = -1;
  let latestPointer: { x: number; y: number } | null = null;
  let tapPointer = -1;
  let rotationDrag: {
    pointerId: number; renderer: AvatarRenderer | null;
    startX: number; startY: number; lastX: number; lastY: number; moved: boolean;
  } | null = null;
  let ignoringMouse: boolean | undefined;
  function updateMouseInput() {
    const interacting = tapPointer !== -1 || rotationDrag !== null;
    const ignore = !interacting && !(latestPointer && (active?.hitTest(latestPointer) || bubble.hitTest?.(latestPointer)));
    if (ignore === ignoringMouse) return;
    ignoringMouse = ignore;
    window.petDesktop?.setIgnoreMouseEvents(ignore);
  }
  function endRotation() {
    const gesture = rotationDrag;
    rotationDrag = null;
    mount!.style.cursor = "";
    if (gesture && mount!.hasPointerCapture(gesture.pointerId)) mount!.releasePointerCapture(gesture.pointerId);
    updateMouseInput();
  }
  const bubble = createSpeechBubble(mount, () => active?.getHeadAnchor() || null, updateLayout);
  function updateLayout() {
    // A running desktop host picks up the new window IPC after its next restart.
    if (!active || !window.petDesktop?.fitWindow) return;
    const head = active.getHeadAnchor();
    const next = fitAvatarLayout(active.getLayoutBounds(), bubble.measure(limits.maxWidth, limits.maxHeight), limits,
      head ? (head.headTop - viewport.y) / viewport.scale : undefined);
    viewport = next.viewport;
    active.resize();
    const size = `${next.width}:${next.height}`;
    if (layoutSize !== size) {
      layoutSize = size;
      window.petDesktop?.fitWindow?.({ width: next.width, height: next.height });
    }
    bubble.placeAboveHead();
  }
  const status = document.createElement("div");
  status.className = "status";
  mount.appendChild(status);

  async function showAvatar(snapshot: AvatarSnapshot) {
    if (snapshot.revision <= revision) return;
    revision = snapshot.revision;
    cancelGesture();
    controller?.abort();
    active?.dispose();
    active = null;
    limits = snapshot.viewport || { width: window.innerWidth, height: window.innerHeight,
      maxWidth: window.innerWidth, maxHeight: window.innerHeight };
    viewport = { width: limits.width, height: limits.height, x: 0, y: 0, scale: 1 };
    layoutSize = "";
    updateMouseInput();
    bubble.handle({ type: "hide" });
    status.hidden = false;
    if (!snapshot.avatar) { status.textContent = "未启用形象插件"; return; }
    status.textContent = "正在加载形象…";
    const loading = new AbortController();
    controller = loading;
    try {
      const module = snapshot.avatar.renderer === "live2d"
        ? await import("./avatars/live2d") : await import("./avatars/mmd");
      loading.signal.throwIfAborted();
      const instance = await module.createRenderer({ mount: mount!, descriptor: snapshot.avatar, signal: loading.signal,
        onRendered: updateMouseInput, getViewport: () => viewport });
      if (loading.signal.aborted || revision !== snapshot.revision) { instance.dispose(); return; }
      active = instance;
      updateLayout();
      if (latestPointer) instance.focus(latestPointer);
      updateMouseInput();
      status.hidden = true;
      window.petDesktop?.avatarReady(snapshot.revision);
      window.petDesktop?.forcePaint();
    } catch (error) {
      if (loading.signal.aborted) return;
      console.error("[avatar] load failed:", error);
      status.textContent = error instanceof Error ? error.message : "形象加载失败";
    }
  }
  const disposeListeners = [
    window.petDesktop?.onViewportLimitsChanged?.(next => {
      limits = { ...limits, ...next };
      layoutSize = "";
      updateLayout();
    }),
    window.petDesktop?.onAvatarChanged(snapshot => { void showAvatar(snapshot); }),
    window.petDesktop?.onAvatarCommand(command => {
      if (command.revision !== revision) return;
      if (command.type === "expression") active?.setExpression(command.id);
      else if (command.type === "motion") active?.playMotion(command.id);
      else if (command.type === "control" && command.id === "resetRotation") {
        endRotation();
        active?.resetRotation?.();
      }
    }),
    window.petDesktop?.onBubble(payload => {
      bubble.handle(payload);
      if (payload.type === "expression" || payload.type === "say") {
        if (payload.expression) active?.setExpression(payload.expression);
      }
    }),
  ];
  const focus = (position: { x: number; y: number }) => {
    latestPointer = position;
    active?.focus(position);
    updateMouseInput();
  };
  if (window.petDesktop) disposeListeners.push(window.petDesktop.onGlobalPointerMove(focus));
  else window.addEventListener("pointermove", event => focus({ x: event.clientX, y: event.clientY }));

  mount.addEventListener("contextmenu", event => event.preventDefault());
  mount.addEventListener("pointerdown", event => {
    if (!hitsAvatar(event)) return;
    if (event.button === 0) {
      tapPointer = event.pointerId;
      mount.setPointerCapture(event.pointerId);
      updateMouseInput();
    }
    if (event.button !== 2) return;
    rotationDrag = { pointerId: event.pointerId, renderer: canRotate(event) ? active : null,
      startX: event.clientX, startY: event.clientY,
      lastX: event.clientX, lastY: event.clientY, moved: false };
    mount.setPointerCapture(event.pointerId);
    updateMouseInput();
    event.preventDefault();
  }, { capture: true });
  mount.addEventListener("pointermove", event => {
    const gesture = rotationDrag;
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (!gesture.moved && Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) < 6) return;
    gesture.moved = true;
    if (gesture.renderer) mount.style.cursor = "grabbing";
    gesture.renderer?.rotate?.(event.clientX - gesture.lastX, event.clientY - gesture.lastY);
    gesture.lastX = event.clientX;
    gesture.lastY = event.clientY;
  });
  mount.addEventListener("pointerup", event => {
    if (event.button === 2) {
      if (rotationDrag?.pointerId !== event.pointerId) return;
      const clicked = !rotationDrag.moved;
      endRotation();
      if (clicked) window.petDesktop?.openContextMenu({ x: event.clientX, y: event.clientY });
      return;
    }
    const tapped = event.button === 0 && event.pointerId === tapPointer && !drag.wasDragging() &&
      active?.hitTest({ x: event.clientX, y: event.clientY });
    if (tapped) {
      active?.onTap();
      void window.petDesktop?.chatNow().catch(error => console.error("[chat]", error));
    }
    tapPointer = -1;
    drag.clearDrag();
    if (mount.hasPointerCapture(event.pointerId)) mount.releasePointerCapture(event.pointerId);
    updateMouseInput();
  });
  const cancelGesture = () => {
    const capturedTap = tapPointer;
    tapPointer = -1;
    drag.clearDrag();
    endRotation();
    if (capturedTap !== -1 && mount.hasPointerCapture(capturedTap)) mount.releasePointerCapture(capturedTap);
    updateMouseInput();
  };
  mount.addEventListener("pointercancel", cancelGesture);
  mount.addEventListener("lostpointercapture", event => {
    if (rotationDrag?.pointerId === event.pointerId || tapPointer === event.pointerId) cancelGesture();
  });
  window.addEventListener("blur", cancelGesture);
  window.addEventListener("resize", () => { active?.resize(); bubble.placeAboveHead(); updateMouseInput(); });
  window.addEventListener("beforeunload", () => {
    cancelGesture();
    controller?.abort();
    active?.dispose();
    disposeListeners.forEach(dispose => dispose?.());
    bubble.destroy();
  }, { once: true });

  if (window.petDesktop) {
    try { await showAvatar(await window.petDesktop.getAvatarConfig()); }
    catch (error) { status.textContent = error instanceof Error ? error.message : "无法读取形象配置"; }
  } else {
    status.textContent = "请通过桌面应用启动以读取形象插件配置";
  }
}
void main();
