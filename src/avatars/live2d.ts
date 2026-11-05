import * as PIXI from "pixi.js";
import type { AvatarRenderer, RendererContext } from "./types";

let coreLoading: Promise<void> | undefined;
async function loadCore() {
  if ((window as Window & { Live2DCubismCore?: unknown }).Live2DCubismCore) return;
  if (!coreLoading) {
    coreLoading = new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "./live2dcubismcore.min.js";
      script.onload = () => resolve();
      script.onerror = () => { script.remove(); coreLoading = undefined; reject(new Error("Live2D Cubism Core 加载失败")); };
      document.head.appendChild(script);
    });
  }
  return coreLoading;
}

export async function createRenderer({ mount, descriptor, signal }: RendererContext): Promise<AvatarRenderer> {
  await loadCore();
  signal.throwIfAborted();
  const { Live2DModel, MotionPriority } = await import("pixi-live2d-display/cubism4");
  signal.throwIfAborted();
  Live2DModel.registerTicker(PIXI.Ticker);
  const model = await Live2DModel.from(descriptor.modelUrl, {
    autoInteract: false,
    idleMotionGroup: descriptor.idleMotion?.group ?? "",
  });
  if (signal.aborted) { model.destroy({ children: true, texture: true, baseTexture: true }); signal.throwIfAborted(); }

  let app: PIXI.Application;
  try {
    app = new PIXI.Application({
      resizeTo: window, backgroundAlpha: 0, antialias: true, autoDensity: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2), autoStart: false, sharedTicker: false,
    });
  } catch (error) {
    model.destroy({ children: true, texture: true, baseTexture: true });
    throw error;
  }
  const canvas = app.view as HTMLCanvasElement;
  mount.prepend(canvas);
  app.stage.addChild(model);
  app.ticker.autoStart = false;
  app.ticker.stop();
  PIXI.Ticker.shared.autoStart = false;
  PIXI.Ticker.shared.stop();
  // A timer preserves animation while the transparent desktop window is unfocused.
  const timer = window.setInterval(() => {
    PIXI.Ticker.shared.update(performance.now());
    app.render();
  }, 1000 / 60);
  let disposed = false;
  let lastExpression = "";
  const api: AvatarRenderer = {
    resize() {
      // Use the unscaled model size so repeated layout does not oscillate.
      const width = model.width / model.scale.x;
      const height = model.height / model.scale.y;
      const scale = Math.min(window.innerWidth * 0.92 / width, window.innerHeight * 0.58 / height) * descriptor.scale;
      app.renderer.resize(window.innerWidth, window.innerHeight);
      model.scale.set(scale);
      model.anchor.set(0.5, 1);
      model.position.set(window.innerWidth / 2, window.innerHeight * 0.98 + descriptor.verticalOffset);
    },
    setExpression(name) {
      if (!descriptor.expressions.includes(name) || name === lastExpression) return;
      lastExpression = name;
      void model.expression(name);
    },
    playMotion(id) {
      const motion = descriptor.motions.find(item => item.id === id);
      if (motion?.group != null && motion.index != null) void model.motion(motion.group, motion.index, MotionPriority.NORMAL);
    },
    onTap() {
      if (descriptor.clickMotion) api.playMotion(`${descriptor.clickMotion.group}:${descriptor.clickMotion.index}`);
    },
    focus(position) {
      const rect = canvas.getBoundingClientRect();
      model.focus(position.x - rect.left, position.y - rect.top);
    },
    getHeadAnchor() {
      const bounds = model.getBounds();
      return { x: bounds.x + bounds.width / 2, headTop: bounds.y + bounds.height * 0.08 };
    },
    hitTest(position) { return model.getBounds().contains(position.x, position.y); },
    dispose() {
      if (disposed) return;
      disposed = true;
      signal.removeEventListener("abort", api.dispose);
      window.clearInterval(timer);
      app.destroy(true, { children: true, texture: true, baseTexture: true });
    },
  };
  signal.addEventListener("abort", api.dispose, { once: true });
  api.resize();
  api.setExpression(descriptor.defaultExpression || "neutral");
  if (descriptor.idleMotion) {
    void model.motion(descriptor.idleMotion.group, descriptor.idleMotion.index, MotionPriority.IDLE);
  }
  PIXI.Ticker.shared.update(performance.now());
  app.render();
  return api;
}
