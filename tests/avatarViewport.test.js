const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { avatarWindowSize } = require('../electron/architecture/avatarViewport');

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
