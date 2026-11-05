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
  const document = { getElementById: () => root, createElement: () => new Element() };
  const calls = { rotations: [], resets: 0, moves: [], menus: [], taps: 0, chats: 0 };
  const renderer = {
    hitTest: ({ x, y }) => x >= 100 && x <= 300 && y >= 200 && y <= 500,
    dispose() {}, focus() {}, resize() {}, getHeadAnchor() { return null; },
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
    getAvatarConfig: async () => ({ revision: 1, avatar: { renderer: "mmd" } }),
    avatarReady: markReady, forcePaint() {},
    onAvatarChanged: listen("changed"), onAvatarCommand: listen("command"),
    onBubble: listen("bubble"), onGlobalPointerMove: listen("pointer"),
    moveWindow: (...args) => calls.moves.push(args),
    openContextMenu: position => calls.menus.push(position),
    chatNow: async () => { calls.chats++; },
  };
  const globals = { window, document, Event, AbortController, console };
  const dragExports = {};
  vm.runInNewContext(dragSource, { ...globals, exports: dragExports });
  vm.runInNewContext(mainSource, { ...globals, exports: {}, require: name => {
    if (name === "./windowDrag") return dragExports;
    if (name === "./speechBubble") return { createSpeechBubble: () => ({ handle() {}, destroy() {}, placeAboveHead() {} }) };
    if (name === "./avatars/mmd") return { createRenderer: async () => renderer };
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
  return { calls, emit, root, window, callbacks };
}

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
