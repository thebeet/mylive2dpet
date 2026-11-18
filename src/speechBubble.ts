export type BubblePayload =
  | { type: "expression"; expression: string }
  | { type: "say"; text: string; expression?: string }
  | { type: "tts"; state: "start" | "end" | "error" }
  | { type: "error"; text: string }
  | { type: "hide" };

export type HeadAnchor = {
  /** 窗口坐标系：角色水平中心 */
  x: number;
  /** 窗口坐标系：头顶 Y（从上往下） */
  headTop: number;
};

const HIDE_AFTER_MS = 12000;
const GAP_ABOVE_HEAD = 18;
const EDGE_PAD = 12;

export function createSpeechBubble(
  mount: HTMLElement,
  getAnchor: () => HeadAnchor | null,
  onSizeChange: () => void = () => {},
) {
  const el = document.createElement("div");
  el.className = "speech-bubble";
  el.hidden = true;
  const content = document.createElement("div");
  content.className = "speech-bubble-content";
  el.appendChild(content);
  mount.appendChild(el);

  let hideTimer = 0;
  let followRaf = 0;
  let availableWidth = window.innerWidth;
  let availableHeight = window.innerHeight;

  const measure = (width = availableWidth, height = availableHeight) => {
    availableWidth = width;
    availableHeight = height;
    if (el.hidden) return null;
    el.style.maxWidth = `${Math.max(1, Math.min(480, width - EDGE_PAD * 2))}px`;
    el.style.minWidth = `${Math.min(108, Math.max(1, width - EDGE_PAD * 2))}px`;
    el.style.width = "max-content";
    content.style.maxHeight = `${Math.max(1, Math.floor(height * 0.45) - 27)}px`;
    el.style.height = "auto";
    const rect = el.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  };

  const clearHide = () => {
    if (hideTimer) {
      window.clearTimeout(hideTimer);
      hideTimer = 0;
    }
  };

  /** The host reserves space above the complete model, including its hat. */
  const placeAboveHead = () => {
    const anchor = getAnchor();
    if (!anchor) return;
    const { x, headTop } = anchor;

    measure();
    el.style.top = "auto";
    el.style.bottom = `${Math.max(
      EDGE_PAD,
      window.innerHeight - headTop + GAP_ABOVE_HEAD,
    )}px`;
    const bubbleHeight = el.getBoundingClientRect().height;
    const desiredTop = Math.max(
      EDGE_PAD,
      headTop - GAP_ABOVE_HEAD - bubbleHeight,
    );
    const maxTop = Math.max(
      EDGE_PAD,
      window.innerHeight - EDGE_PAD - bubbleHeight,
    );
    const top = Math.min(desiredTop, maxTop);
    el.style.top = `${top}px`;
    el.style.bottom = "auto";

    // 先按中心定位，量宽后夹紧左右
    el.style.left = `${x}px`;
    el.style.transform = "translateX(-50%)";
    const rect = el.getBoundingClientRect();
    let left = x;
    const half = rect.width / 2;
    if (left - half < EDGE_PAD) left = EDGE_PAD + half;
    if (left + half > window.innerWidth - EDGE_PAD) {
      left = window.innerWidth - EDGE_PAD - half;
    }
    el.style.left = `${left}px`;
  };

  const stopFollow = () => {
    if (followRaf) {
      cancelAnimationFrame(followRaf);
      followRaf = 0;
    }
  };

  const startFollow = () => {
    stopFollow();
    const tick = () => {
      if (!el.hidden) {
        placeAboveHead();
        followRaf = requestAnimationFrame(tick);
      } else {
        followRaf = 0;
      }
    };
    followRaf = requestAnimationFrame(tick);
  };

  const show = (text: string, kind: "say" | "error") => {
    clearHide();
    el.hidden = false;
    el.dataset.kind = kind;
    content.textContent = text;
    onSizeChange();
    placeAboveHead();
    startFollow();
  };

  const scheduleHide = () => {
    clearHide();
    hideTimer = window.setTimeout(() => {
      el.hidden = true;
      stopFollow();
      onSizeChange();
    }, HIDE_AFTER_MS);
  };

  const handle = (payload: BubblePayload) => {
    if (payload.type === "hide") {
      clearHide();
      el.hidden = true;
      stopFollow();
      onSizeChange();
      return;
    }
    if (payload.type === "expression" || payload.type === "tts") {
      // 表情 / TTS 状态由外部处理，气泡忽略
      return;
    }
    if (payload.type === "error") {
      show(payload.text.slice(0, 160), "error");
      scheduleHide();
      return;
    }
    show(payload.text, "say");
    scheduleHide();
  };

  return {
    el,
    handle,
    measure,
    hitTest(position: { x: number; y: number }) {
      if (el.hidden || content.scrollHeight <= content.clientHeight) return false;
      const rect = el.getBoundingClientRect();
      return position.x >= rect.left && position.x < rect.right && position.y >= rect.top && position.y < rect.bottom;
    },
    placeAboveHead,
    destroy: () => {
      clearHide();
      stopFollow();
      el.remove();
    },
  };
}
