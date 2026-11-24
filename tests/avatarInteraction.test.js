const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const compile = file => ts.transpileModule(fs.readFileSync(path.join(__dirname, "../src", file), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const mainSource = compile("main.ts");
const dragSource = compile("windowDrag.ts");
const layoutExports = {};
vm.runInNewContext(compile("avatarLayout.ts"), { exports: layoutExports });

async function harness(t, { rotatable = true } = {}) {
  class Element extends EventTarget {
    style = {};
    captured = new Set();
    appendChild() {}
    setPointerCapture(id) { this.captured.add(id); }
    hasPointerCapture(id) { return this.captured.has(id); }
    releasePointerCapture(id) {
      this.captured.delete(id);
      const event = new Event("lostpointercapture");
      Object.assign(event, { pointerId: id });
      this.dispatchEvent(event);
    }
  }
  const root = new Element();
  const window = new EventTarget();
  window.innerWidth = 380;
  window.innerHeight = 560;
  const document = { getElementById: () => root, createElement: () => new Element() };
  const calls = { rotations: [], resets: 0, moves: [], menus: [], taps: 0, chats: 0, ignored: [], sizes: [] };
  const renderer = {
    hitTest: ({ x, y }) => x >= 100 && x <= 300 && y >= 200 && y <= 500,
    dispose() {}, focus() {}, resize() {}, getHeadAnchor() { return null; },
    getLayoutBounds: () => ({ x: 100, y: 200, width: 200, height: 300 }),
    onTap() { calls.taps++; },
    ...(rotatable ? {
      rotate: (dx, dy) => calls.rotations.push([dx, dy]),
      resetRotation: () => { calls.resets++; },
    } : {}),
  };
  const callbacks = {};
  let markReady;
  const ready = new Promise(resolve => { markReady = resolve; });
  const listen = name => fn => { callbacks[name] = fn; return () => {}; };
  window.petDesktop = {
    isElectron: true,
    setIgnoreMouseEvents: ignore => calls.ignored.push(ignore),
    getAvatarConfig: async () => ({ revision: 1, avatar: { renderer: "mmd" } }),
    avatarReady: markReady, forcePaint() {},
    fitWindow: size => calls.sizes.push(size),
    onAvatarChanged: listen("changed"), onAvatarCommand: listen("command"),
    onBubble: listen("bubble"), onGlobalPointerMove: listen("pointer"),
    onViewportLimitsChanged: listen("limits"),
    moveWindow: (...args) => calls.moves.push(args),
    openContextMenu: position => calls.menus.push(position),
    chatNow: async () => { calls.chats++; },
  };
  const globals = { window, document, Event, AbortController, console };
  const dragExports = {};
  let bubbleSize = null;
  vm.runInNewContext(dragSource, { ...globals, exports: dragExports });
  vm.runInNewContext(mainSource, { ...globals, exports: {}, require: name => {
    if (name === "./windowDrag") return dragExports;
    if (name === "./avatarLayout") return layoutExports;
    if (name === "./speechBubble") return { createSpeechBubble: (_mount, _anchor, changed) => ({
      handle(payload) {
        bubbleSize = payload.type === "hide" ? null : { width: 300, height: 100 };
        changed();
      },
      measure: () => bubbleSize,
      hitTest: () => false,
      destroy() {}, placeAboveHead() {},
    }) };
    if (name === "./avatars/mmd") return { createRenderer: async context => {
      callbacks.rendered = context.onRendered;
      callbacks.viewport = context.getViewport;
      return renderer;
    } };
    if (name === "./style.css") return {};
    throw new Error(`Unexpected import: ${name}`);
  } });
  await ready;
  const emit = (type, props = {}) => {
    const event = new Event(type, { cancelable: true });
    Object.assign(event, { pointerId: 1, button: 2, clientX: 190, clientY: 310, screenX: 190, screenY: 310, ...props });
    // Window's capture listeners run before the target's pointer handlers.
    window.dispatchEvent(event);
    root.dispatchEvent(event);
  };
  t.after(() => window.dispatchEvent(new Event("beforeunload")));
  return { calls, emit, root, window, callbacks, renderer };
}

test("transparent space passes input through and cannot start avatar gestures", async t => {
  const { calls, emit, root, callbacks } = await harness(t);
  assert.equal(calls.ignored.at(-1), true);
  callbacks.pointer({ x: 190, y: 310 });
  assert.equal(calls.ignored.at(-1), false);
  callbacks.pointer({ x: 40, y: 40 });
  for (let frame = 0; frame < 3; frame++) callbacks.rendered();
  assert.equal(calls.ignored.at(-1), true);
  for (const button of [0, 2]) {
    emit("pointerdown", { button, clientX: 40, clientY: 40 });
    emit("pointermove", { button, clientX: 190, clientY: 310, screenX: 220 });
    emit("pointerup", { button });
  }
  assert.equal(root.hasPointerCapture(1), false);
  assert.equal(calls.moves.length, 0);
  assert.equal(calls.rotations.length, 0);
  assert.equal(calls.menus.length, 0);
  assert.equal(calls.chats, 0);
});

test("bubble expands the canvas and hiding it restores the model canvas without changing model scale", async t => {
  const { calls, callbacks } = await harness(t);
  const before = calls.sizes.at(-1);
  const scale = callbacks.viewport().scale;
  callbacks.bubble({ type: "say", text: "A longer conversation" });
  const during = calls.sizes.at(-1);
  assert.ok(during.width >= 324);
  assert.equal(during.height, before.height + 118);
  assert.equal(callbacks.viewport().scale, scale);
  callbacks.bubble({ type: "hide" });
  assert.deepEqual(calls.sizes.at(-1), before);
  for (let frame = 0; frame < 100; frame++) callbacks.rendered();
  assert.equal(calls.sizes.length, 3);
});

test("moving to a smaller display refits content and returning restores the original scale", async t => {
  const { calls, callbacks } = await harness(t);
  const initial = calls.sizes.at(-1);
  callbacks.limits({ maxWidth: 180, maxHeight: 240 });
  assert.ok(calls.sizes.at(-1).width <= 180);
  assert.ok(calls.sizes.at(-1).height <= 240);
  assert.ok(callbacks.viewport().scale < 1);
  callbacks.limits({ maxWidth: 1000, maxHeight: 1000 });
  assert.equal(callbacks.viewport().scale, 1);
  assert.deepEqual(calls.sizes.at(-1), initial);
});

test("animation rechecks a stationary cursor and sends only changed input states", async t => {
  const { calls, callbacks, renderer } = await harness(t);
  callbacks.pointer({ x: 190, y: 310 });
  const count = calls.ignored.length;
  callbacks.rendered();
  callbacks.rendered();
  assert.equal(calls.ignored.length, count);
  renderer.hitTest = () => false;
  callbacks.rendered();
  assert.equal(calls.ignored.at(-1), false);
  callbacks.rendered();
  callbacks.rendered();
  assert.equal(calls.ignored.at(-1), false);
  callbacks.rendered();
  assert.equal(calls.ignored.at(-1), true);
});

test("mouse hit testing pauses while a button is held and resumes after release", async t => {
  const { calls, emit, callbacks, renderer } = await harness(t);
  callbacks.pointer({ x: 190, y: 310 });
  emit("pointerdown", { button: 0 });
  const heldStateCount = calls.ignored.length;
  renderer.hitTest = () => false;
  callbacks.pointer({ x: 40, y: 40 });
  callbacks.rendered();
  assert.equal(calls.ignored.length, heldStateCount);
  emit("pointerup", { button: 0 });
  for (let frame = 0; frame < 3; frame++) callbacks.rendered();
  assert.equal(calls.ignored.at(-1), true);
});

test("right-click target survives brief alpha-hit misses during animation", async t => {
  const { calls, emit, callbacks, renderer } = await harness(t);
  callbacks.pointer({ x: 190, y: 310 });
  renderer.hitTest = () => false;
  callbacks.rendered();
  callbacks.rendered();
  assert.equal(calls.ignored.at(-1), false);
  renderer.hitTest = () => true;
  callbacks.rendered();
  emit("pointerdown");
  emit("pointerup");
  assert.equal(calls.menus.length, 1);
});

test("both drag buttons retain input outside the silhouette until release or cancellation", async t => {
  for (const button of [0, 2]) {
    const { calls, emit, callbacks, root } = await harness(t);
    callbacks.pointer({ x: 190, y: 310 });
    emit("pointerdown", { button });
    callbacks.pointer({ x: 40, y: 40 });
    callbacks.rendered();
    assert.equal(calls.ignored.at(-1), false);
    assert.equal(root.hasPointerCapture(1), true);
    emit("pointermove", { button, clientX: 40, clientY: 40, screenX: 40 });
    emit("pointerup", { button, clientX: 40, clientY: 40 });
    assert.equal(root.hasPointerCapture(1), false);
    for (let frame = 0; frame < 3; frame++) callbacks.rendered();
    assert.equal(calls.ignored.at(-1), true);
    assert.equal(calls.chats, 0);
    assert.equal(calls.menus.length, 0);
  }
});

test("right drag rotates the avatar without moving the window, chatting or opening the menu", async t => {
  const { calls, emit, root } = await harness(t);
  emit("pointerdown");
  assert.ok(root.hasPointerCapture(1));
  emit("contextmenu"); // Linux can send this before the right button is released.
  assert.equal(calls.menus.length, 0);
  emit("pointermove", { clientX: 240, clientY: 330 });
  emit("pointermove", { clientX: 290, clientY: 340 });
  emit("pointerup", { clientX: 290, clientY: 340 });
  assert.deepEqual(calls.rotations.map(pair => Array.from(pair)), [[50, 20], [50, 10]]);
  assert.equal(calls.moves.length, 0);
  assert.equal(calls.menus.length, 0);
  assert.equal(calls.chats, 0);
  assert.equal(root.hasPointerCapture(1), false);
  emit("pointermove", { clientX: 250, clientY: 330 });
  assert.equal(calls.rotations.length, 2);
});

test("right click waits for release and tolerates small hand movement", async t => {
  const { calls, emit } = await harness(t);
  emit("pointerdown");
  emit("pointermove", { clientX: 192, clientY: 311 });
  assert.equal(calls.menus.length, 0);
  emit("pointerup", { clientX: 192, clientY: 311 });
  assert.equal(calls.rotations.length, 0);
  assert.equal(calls.menus.length, 1);
  assert.equal(calls.menus[0].x, 192);
  assert.equal(calls.chats, 0);
});

test("left dragging still moves the window and left clicking still chats", async t => {
  const { calls, emit } = await harness(t);
  emit("pointerdown", { button: 0 });
  emit("pointermove", { button: 0, clientX: 220, screenX: 220 });
  emit("pointerup", { button: 0, clientX: 220, screenX: 220 });
  assert.equal(calls.moves.length, 1);
  assert.equal(calls.rotations.length, 0);
  assert.equal(calls.chats, 0);
  emit("pointerdown", { button: 0 });
  emit("pointerup", { button: 0 });
  assert.equal(calls.chats, 1);
  assert.equal(calls.taps, 1);
});

test("cancel, capture loss and window blur stop rotation without opening a menu", async t => {
  for (const reason of ["pointercancel", "lostpointercapture", "blur"]) {
    const { calls, emit, window } = await harness(t);
    emit("pointerdown");
    if (reason === "blur") window.dispatchEvent(new Event("blur"));
    else emit(reason);
    emit("pointermove", { clientX: 250 });
    emit("pointerup");
    assert.equal(calls.rotations.length, 0, reason);
    assert.equal(calls.menus.length, 0, reason);
  }
});

test("right clicks still open the menu for renderers without rotation", async t => {
  const { calls, emit } = await harness(t, { rotatable: false });
  emit("pointerdown");
  emit("pointerup");
  assert.equal(calls.menus.length, 1);
  assert.equal(calls.rotations.length, 0);
});

test("reset rotation ignores stale commands and terminates an active rotation gesture", async t => {
  const { calls, callbacks, emit, root } = await harness(t);
  emit("pointerdown");
  callbacks.command({ revision: 0, type: "control", id: "resetRotation" });
  assert.equal(calls.resets, 0);
  assert.equal(root.hasPointerCapture(1), true);
  callbacks.command({ revision: 1, type: "control", id: "resetRotation" });
  assert.equal(calls.resets, 1);
  assert.equal(root.hasPointerCapture(1), false);
  emit("pointermove", { clientX: 250 });
  emit("pointerup");
  assert.equal(calls.rotations.length, 0);
  assert.equal(calls.menus.length, 0);
});
