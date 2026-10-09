import "./style.css";
import * as PIXI from "pixi.js";
import { Live2DModel, MotionPriority } from "pixi-live2d-display/cubism4";
import { setupWindowDrag } from "./windowDrag";
import { createSpeechBubble, type HeadAnchor } from "./speechBubble";

const MODEL_URL =
  "/assets/Setsuna_v081l_b/setsuna_psd2live_v001.model3.json";

Live2DModel.registerTicker(PIXI.Ticker);

function assertCubismCore() {
  const core = (
    window as Window & { Live2DCubismCore?: unknown }
  ).Live2DCubismCore;
  if (!core) {
    throw new Error(
      "Live2D Cubism Core 未加载，请确认 public/live2dcubismcore.min.js 存在",
    );
  }
}

function layoutModel(model: Live2DModel, app: PIXI.Application) {
  const padding = 0.04;
  const maxW = app.screen.width * (1 - padding * 2);
  // 上方多留气泡区（约 38% 高度）
  const topReserve = 0.38;
  const maxH = app.screen.height * (1 - padding - topReserve);
  const scale = Math.min(maxW / model.width, maxH / model.height);
  model.scale.set(scale);
  model.anchor.set(0.5, 1);
  model.position.set(app.screen.width / 2, app.screen.height * 0.98);
}

/** 估算头顶位置（模型包围盒顶部略下一点） */
function getHeadAnchor(model: Live2DModel): HeadAnchor {
  const bounds = model.getBounds();
  return {
    x: bounds.x + bounds.width / 2,
    headTop: bounds.y + bounds.height * 0.08,
  };
}

function setStatus(el: HTMLElement, text: string) {
  el.textContent = text;
}

/** 读取模型支持的动作 / 表情并打印到 console */
function logLive2DCapabilities(model: Live2DModel) {
  const motionDefs =
    model.internalModel.motionManager.definitions ?? {};
  const motions = Object.entries(motionDefs).map(([group, list]) => ({
    group,
    count: Array.isArray(list) ? list.length : 0,
    files: Array.isArray(list)
      ? list.map((m) => (m as { File?: string })?.File ?? "(unknown)")
      : [],
  }));

  const exprDefs = model.internalModel.motionManager.expressionManager
    ?.definitions;
  const expressions = Array.isArray(exprDefs)
    ? exprDefs.map((e) => {
        const item = e as { Name?: string; name?: string; File?: string };
        return item.Name || item.name || item.File || String(e);
      })
    : [];

  console.log("[Live2D] supported motions:", motions);
  console.log(
    "[Live2D] motion groups:",
    motions.map((m) => `${m.group} (${m.count})`).join(", ") || "(none)",
  );
  console.log("[Live2D] supported expressions:", expressions);
}

function keepAnimating(app: PIXI.Application) {
  app.ticker.autoStart = false;
  app.ticker.stop();
  PIXI.Ticker.shared.autoStart = false;
  PIXI.Ticker.shared.stop();

  window.setInterval(() => {
    const now = performance.now();
    PIXI.Ticker.shared.update(now);
    app.render();
  }, 1000 / 60);
}

async function main() {
  assertCubismCore();

  const mount = document.getElementById("app");
  if (!mount) {
    throw new Error("#app not found");
  }

  const drag = setupWindowDrag(mount);

  let modelRef: Live2DModel | null = null;
  const bubble = createSpeechBubble(mount, () =>
    modelRef ? getHeadAnchor(modelRef) : null,
  );

  let lastAppliedExpression = "";
  const applyExpression = (name?: string) => {
    if (!name || !modelRef || name === lastAppliedExpression) return;
    lastAppliedExpression = name;
    void modelRef.expression(name);
    console.log("[Live2D] expression:", name);
  };

  if (window.petDesktop?.onBubble) {
    window.petDesktop.onBubble((payload) => {
      bubble.handle(payload);
      if (payload.type === "expression") {
        applyExpression(payload.expression);
      } else if (
        (payload.type === "stream" || payload.type === "say") &&
        payload.expression
      ) {
        applyExpression(payload.expression);
      }
    });
  }

  const status = document.createElement("div");
  status.className = "status";
  status.textContent = "正在加载模型（约 270MB，首次较慢）…";
  mount.appendChild(status);

  const app = new PIXI.Application({
    resizeTo: window,
    backgroundAlpha: 0,
    antialias: true,
    autoDensity: true,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    autoStart: false,
    sharedTicker: false,
  });
  mount.insertBefore(app.view as HTMLCanvasElement, status);
  keepAnimating(app);

  try {
    const model = await Live2DModel.from(MODEL_URL, {
      autoInteract: true,
      idleMotionGroup: "Thinking",
    });

    modelRef = model;
    logLive2DCapabilities(model);
    app.stage.addChild(model);
    layoutModel(model, app);

    let layoutRaf = 0;
    window.addEventListener("resize", () => {
      cancelAnimationFrame(layoutRaf);
      layoutRaf = requestAnimationFrame(() => {
        layoutModel(model, app);
        bubble.placeAboveHead();
      });
    });

    void model.expression("neutral");
    void model.motion("Thinking", 0, MotionPriority.IDLE);

    // 该模型 model3 无 HitAreas，不能依赖 "hit"；用 pointertap 点角色触发
    model.interactive = true;
    model.cursor = "pointer";

    // 记录按下键，避免右键 pointertap 误触聊天
    let lastPointerButton = 0;
    mount.addEventListener(
      "pointerdown",
      (e) => {
        lastPointerButton = e.button;
      },
      { capture: true },
    );

    model.on("pointertap", () => {
      if (lastPointerButton !== 0) return;
      if (drag.wasDragging()) return;
      void model.motion("ReachStudy", 0, MotionPriority.NORMAL);
      console.log("[chat] pet clicked, trigger chatNow");
      void window.petDesktop?.chatNow?.().catch((err) => {
        console.error("[chat] chatNow failed:", err);
      });
    });

    mount.addEventListener(
      "pointerup",
      () => {
        // 等 pointertap 读完 wasDragging 再清
        requestAnimationFrame(() => drag.clearDrag());
      },
      { capture: true },
    );

    // 右键弹出与托盘相同的菜单（不触发聊天）
    mount.addEventListener(
      "contextmenu",
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        lastPointerButton = 2;
        window.petDesktop?.openContextMenu?.({
          x: e.clientX,
          y: e.clientY,
        });
      },
      { capture: true },
    );

    status.remove();
    requestAnimationFrame(() => {
      window.petDesktop?.forcePaint();
    });
  } catch (err) {
    console.error(err);
    setStatus(
      status,
      err instanceof Error ? err.message : "Live2D 加载失败",
    );
  }
}

void main();
