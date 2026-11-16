const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, "../src/avatars/alphaHitTest.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const api = {};
vm.runInNewContext(source, { exports: api, Uint8Array });

function harness() {
  const reads = [];
  let alpha = 255;
  let renders = 0;
  const gl = {
    drawingBufferWidth: 400, drawingBufferHeight: 200, RGBA: 0x1908, UNSIGNED_BYTE: 0x1401,
    isContextLost: () => false,
    readPixels(x, y, width, height, format, type, pixel) {
      reads.push([x, y]);
      pixel[3] = alpha;
    },
  };
  const canvas = { getBoundingClientRect: () => ({ left: 10, top: 20, width: 200, height: 100 }) };
  const hits = api.createAlphaHitTest(canvas, gl, () => { renders++; });
  return { hits, reads, gl, setAlpha: value => { alpha = value; }, renders: () => renders };
}

test("hit testing maps CSS coordinates to HiDPI framebuffer pixels with an inverted Y axis", () => {
  const { hits, reads, renders } = harness();
  assert.equal(hits.hitTest({ x: 35, y: 30 }), true);
  assert.deepEqual(reads, [[50, 179]]);
  assert.equal(hits.hitTest({ x: 35, y: 30 }), true);
  assert.equal(renders(), 1);
});

test("texture holes and faint edges pass through even inside the model bounds", () => {
  const { hits, setAlpha } = harness();
  hits.setPointer({ x: 35, y: 30 });
  for (const [alpha, expected] of [[255, true], [0, false], [15, false], [16, true]]) {
    setAlpha(alpha);
    hits.afterRender();
    assert.equal(hits.hitTest({ x: 35, y: 30 }), expected);
  }
});

test("outside edges and lost contexts never read the framebuffer or intercept input", () => {
  const { hits, reads, gl, renders } = harness();
  for (const position of [{ x: 9, y: 30 }, { x: 210, y: 30 }, { x: 35, y: 19 }, { x: 35, y: 120 }]) {
    assert.equal(hits.hitTest(position), false);
  }
  gl.isContextLost = () => true;
  assert.equal(hits.hitTest({ x: 35, y: 30 }), false);
  assert.equal(reads.length, 0);
  assert.equal(renders(), 0);
});
