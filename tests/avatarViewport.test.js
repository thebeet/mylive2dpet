const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { avatarWindowSize, avatarWindowBounds } = require('../electron/architecture/avatarViewport');

function compiled(file) {
  const exports = {};
  const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText;
  vm.runInNewContext(source, { exports });
  return exports;
}

const { fitAvatarLayout } = compiled('avatarLayout.ts');
const { mmdViewport, mmdContentBounds, extendMmdViewport } = compiled('avatars/mmdViewport.ts');

test('canvas includes the whole model and dialogue without recursively growing or scaling up', () => {
  const limits = { width: 380, height: 560, maxWidth: 1200, maxHeight: 1000 };
  const body = { x: -40, y: -30, width: 460, height: 650 };
  const bubble = { width: 480, height: 180 };
  const layout = fitAvatarLayout(body, bubble, limits);
  assert.equal(layout.width, 504);
  assert.equal(layout.height, 872);
  assert.equal(layout.viewport.scale, 1);
  assert.equal(layout.viewport.y + body.y, 210);
  assert.equal(layout.viewport.y + body.y + body.height, layout.height - 12);
  assert.deepEqual(fitAvatarLayout(body, bubble, limits), layout);
});

test('small screens reduce only the model to fit the complete dialogue and body', () => {
  for (const [maxWidth, maxHeight] of [[320, 480], [640, 720], [1000, 700]]) {
    const body = { x: -200, y: -500, width: 900, height: 1600 };
    const bubble = { width: Math.min(480, maxWidth - 24), height: 160 };
    const layout = fitAvatarLayout(body, bubble, { width: 640, height: 720, maxWidth, maxHeight });
    const view = layout.viewport;
    assert.ok(layout.width <= maxWidth && layout.height <= maxHeight);
    assert.ok(view.scale > 0 && view.scale < 1);
    assert.ok(view.x + body.x * view.scale >= 12 - 1e-6);
    assert.ok(view.y + body.y * view.scale >= bubble.height + 30 - 1e-6);
    assert.ok(view.y + (body.y + body.height) * view.scale <= layout.height - 12 + 1e-6);
  }
});

test('dialogue uses existing movement space above the head before expanding the canvas', () => {
  const limits = { width: 640, height: 720, maxWidth: 1200, maxHeight: 1000 };
  const body = { x: 0, y: 0, width: 600, height: 800 };
  const empty = fitAvatarLayout(body, null, limits);
  const short = fitAvatarLayout(body, { width: 480, height: 80 }, limits, 200);
  assert.equal(short.height, empty.height);
  assert.equal(short.viewport.scale, 1);
  const long = fitAvatarLayout(body, { width: 480, height: 300 }, limits, 200);
  assert.equal(long.height, empty.height + 118);
  assert.equal(long.viewport.y + 200 - 18 - 300, 12);
});

test('window growth preserves its bottom center and clamps to offset monitor work areas', () => {
  const previous = { x: 400, y: 400, width: 300, height: 400 };
  const area = { x: 0, y: 0, width: 1200, height: 1000 };
  assert.deepEqual(avatarWindowBounds(previous, { width: 500, height: 700 }, area), { x: 300, y: 100, width: 500, height: 700 });
  const monitor = { x: -800, y: 200, width: 800, height: 600 };
  const result = avatarWindowBounds({ x: -100, y: 600, width: 100, height: 100 }, { width: 2000, height: 2000 }, monitor);
  assert.ok(result.x >= monitor.x && result.y >= monitor.y);
  assert.ok(result.x + result.width <= monitor.x + monitor.width);
  assert.ok(result.y + result.height <= monitor.y + monitor.height);
});

test('3D canvas extension preserves model projection while fitting spread arms and a raised hat', () => {
  for (const scale of [0.5, 1, 2, 5]) {
    const limits = { width: 640, height: 720, maxWidth: 1600, maxHeight: 1000 };
    const bounds = mmdContentBounds(20, limits.width, limits.height, scale, 50);
    const layout = fitAvatarLayout(bounds, { width: 480, height: 120 }, limits);
    const frame = mmdViewport(20, limits.width, limits.height, scale, 50);
    const expanded = extendMmdViewport(frame, layout.viewport, layout.width, layout.height);
    const px = world => (world - expanded.left) / (expanded.right - expanded.left) * layout.width;
    const py = world => (expanded.top - world) / (expanded.top - expanded.bottom) * layout.height;
    assert.ok(px(-14) >= 12 - 1e-6 && px(14) <= layout.width - 12 + 1e-6);
    assert.ok(py(16) >= 150 - 1e-6 && py(-12) <= layout.height - 12 + 1e-6);
    const projectedWidth = px(14) - px(-14);
    assert.ok(Math.abs(projectedWidth - bounds.width * layout.viewport.scale) < 1e-6);
  }
});

test('3D gets a larger stage, respects larger user sizes and fits small displays', () => {
  assert.deepEqual(avatarWindowSize({}, 'mmd'), {width:640,height:720});
  assert.deepEqual(avatarWindowSize({}, 'live2d'), {width:380,height:560});
  assert.deepEqual(avatarWindowSize({windowWidth:900,windowHeight:850}, 'mmd'), {width:900,height:850});
  assert.deepEqual(avatarWindowSize({}, 'mmd', {width:600,height:650}), {width:568,height:618});
});

test('3D framing fits full-body movement in narrow and wide viewports', () => {
  const exports = {};
  const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/avatars/mmdViewport.ts'), 'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
  vm.runInNewContext(source, {exports});
  for (const [width,height] of [[380,560],[640,720],[900,600],[280,420]]) {
    const frame = exports.mmdViewport(20,width,height,1,0);
    assert.ok(frame.right-frame.left >= 28-1e-6, 'spread arms must fit horizontally');
    assert.ok(frame.top >= 13 && frame.bottom <= -10, 'raised hat and feet must fit vertically');
    assert.ok(Math.abs((frame.right-frame.left)/(frame.top-frame.bottom)-width/height)<1e-6);
  }
});
