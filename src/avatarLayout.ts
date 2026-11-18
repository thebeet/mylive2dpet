export type ContentBounds = { x: number; y: number; width: number; height: number };
export type AvatarViewport = { width: number; height: number; x: number; y: number; scale: number };
export type ViewportLimits = { width: number; height: number; maxWidth: number; maxHeight: number };

/** Size the canvas around content, using a stable model viewport to avoid resize feedback. */
export function fitAvatarLayout(
  body: ContentBounds,
  bubble: { width: number; height: number } | null,
  limits: ViewportLimits,
  headTop = body.y,
) {
  const pad = 12;
  const bubbleHeight = bubble ? bubble.height + 18 : 0;
  const scale = Math.max(0.001, Math.min(1,
    (limits.maxWidth - pad * 2) / Math.max(1, body.width),
    (limits.maxHeight - pad * 2) / Math.max(1, body.height),
    bubble ? (limits.maxHeight - pad * 2 - bubbleHeight) / Math.max(1, body.y + body.height - headTop) : 1,
  ));
  const top = Math.min(body.y * scale, bubble ? headTop * scale - bubbleHeight : body.y * scale);
  const width = Math.min(limits.maxWidth, Math.ceil(Math.max(body.width * scale, bubble?.width || 0) + pad * 2));
  const height = Math.min(limits.maxHeight, Math.ceil((body.y + body.height) * scale - top + pad * 2));
  return {
    width, height,
    viewport: {
      width: limits.width, height: limits.height, scale,
      x: width / 2 - (body.x + body.width / 2) * scale,
      y: pad - top,
    },
  };
}
