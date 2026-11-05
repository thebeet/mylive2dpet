const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, "../src/avatars/mmdPhysics.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

async function harness(withHat = false) {
  const THREE = await import("three");
  const mesh = new THREE.SkinnedMesh(new THREE.BufferGeometry());
  mesh.geometry.userData.MMD = { rigidBodies: [
    { type: 0, groupIndex: 0, groupTarget: 0xffff },
    { type: 0, groupIndex: 2, groupTarget: 0xffff },
    { type: 1, groupIndex: 3, groupTarget: 0xfffe },
  ], constraints: [] };
  const driver = new THREE.Bone();
  const cloth = new THREE.Bone();
  driver.add(cloth);
  mesh.add(driver);
  if (withHat) {
    driver.name = "頭";
    const hat = new THREE.Bone(); hat.name = "帽";
    driver.add(hat); hat.add(cloth);
    mesh.bind(new THREE.Skeleton([driver, hat, cloth]));
    mesh.geometry.userData.MMD.rigidBodies = [
      { type: 0, boneIndex: 0, groupIndex: 0, groupTarget: 0xffff, position: [0, 17, 0] },
      { type: 2, boneIndex: 2, groupIndex: 4, groupTarget: 0xffff },
    ];
    mesh.geometry.userData.MMD.constraints = [{ rigidBodyIndex1: 0, rigidBodyIndex2: 1 }];
  }
  const root = new THREE.Group();
  root.add(mesh);
  mesh.position.set(-2, -10, 1);
  mesh.rotation.set(0.05, 0.1, 0);
  root.position.set(2, 10, -1);
  root.rotation.set(0.3, 1.2, 0);
  root.scale.setScalar(1.4);
  root.updateMatrixWorld(true);
  const calls = { jump: 0, spin: 0, clamped: 0, steps: [], resets: 0, fail: false, limits: [], sleeping: [] };
  const identity = new THREE.Matrix4();
  function checkFrame() {
    assert.equal(mesh.parent, null);
    assert.ok(mesh.matrixWorld.equals(identity), "physics must see the model's identity transform");
  }
  const dynamicPosition = new THREE.Vector3();
  const dynamicRotation = new THREE.Quaternion();
  const transform = {
    getOrigin: () => ({ x: () => dynamicPosition.x, y: () => dynamicPosition.y, z: () => dynamicPosition.z }),
    getRotation: () => ({ x: () => dynamicRotation.x, y: () => dynamicRotation.y, z: () => dynamicRotation.z, w: () => dynamicRotation.w }),
    setOrigin: v => dynamicPosition.set(v.x, v.y, v.z),
    setRotation: q => dynamicRotation.set(q.x, q.y, q.z, q.w),
  };
  class Physics {
    world = { getSolverInfo: () => ({ set_m_numIterations: value => { calls.iterations = value; } }) };
    constraints = [{ constraint: { setParam: (...args) => calls.limits.push(args) } }];
    bodies = [{ updateFromBone() {}, updateBone() {}, params: { type: 0 }, bone: driver, body: {
      setLinearVelocity() {}, setAngularVelocity() {}, clearForces() {},
    } }, { updateFromBone() {}, updateBone() {}, params: { type: 1 }, bone: cloth, body: {
      setLinearVelocity() {}, setAngularVelocity() {}, clearForces() {},
      getCenterOfMassTransform: () => transform,
      setCenterOfMassTransform() { calls.clamped++; },
      getMotionState: () => ({ setWorldTransform() {} }),
      setSleepingThresholds: (...values) => calls.sleeping.push(values),
    } }];
    constructor(_mesh, bodies, _constraints, options) {
      checkFrame();
      calls.bodies = bodies;
      calls.joints = _constraints;
      calls.options = options;
    }
    update(delta) {
      checkFrame();
      if (calls.fail) throw new Error("solver failed");
      this.bodies.forEach(entry => entry.updateFromBone());
      dynamicPosition.x += calls.jump;
      dynamicRotation.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), calls.spin));
      this.bodies.forEach(entry => entry.updateBone());
      calls.steps.push(delta);
      cloth.rotation.z += 0.01;
      mesh.updateMatrixWorld(true);
    }
    reset() { checkFrame(); calls.resets++; }
  }
  const engine = { btVector3: class { setValue(x, y, z) { Object.assign(this, {x,y,z}); } }, btQuaternion: class { setValue(x,y,z,w) { Object.assign(this, {x,y,z,w}); } }, destroy() {} };
  const context = vm.createContext({ exports: {}, console, document: {
    createElement: () => ({ remove() {} }),
    head: { appendChild(script) {
      context.Ammo = async () => engine;
      queueMicrotask(() => script.onload());
    } },
  }, XMLHttpRequest: class {
    status = 200;
    response = new ArrayBuffer(8);
    open() {}
    send() { queueMicrotask(() => this.onload()); }
  }, require(name) {
    if (name === "three") return THREE;
    if (name.endsWith("/MMDPhysics.js")) return { MMDPhysics: Physics };
    if (name.endsWith("?url")) return { default: "test-asset" };
    throw new Error(`Unexpected import: ${name}`);
  } });
  vm.runInContext(source, context);
  const physics = await context.exports.createMmdPhysics(mesh, new AbortController().signal);
  return { physics, mesh, root, driver, cloth, calls, context, engine, dynamicPosition, dynamicRotation };
}

test("PMX simulation isolates presentation transforms and restores them on errors", async () => {
  const { physics, mesh, root, calls, context, engine } = await harness();
  const position = mesh.position.clone();
  const quaternion = mesh.quaternion.clone();
  const checkRestored = () => {
    assert.equal(mesh.parent, root);
    assert.ok(mesh.position.equals(position));
    assert.ok(mesh.quaternion.equals(quaternion));
    const expected = new mesh.matrixWorld.constructor().multiplyMatrices(root.matrixWorld, mesh.matrix);
    assert.ok(mesh.matrixWorld.equals(expected));
    assert.equal(context.Ammo, engine);
  };
  physics.reset();
  checkRestored();
  physics.update(1 / 60);
  checkRestored();
  root.rotation.set(-0.4, 3.5, 0);
  root.updateMatrixWorld(true);
  physics.update(1 / 60);
  checkRestored();
  calls.fail = true;
  assert.throws(() => physics.update(1 / 60), /solver failed/);
  checkRestored();
  physics.dispose();
});

test("PMX uses elapsed fixed steps and bounds catch-up after slow frames", async () => {
  const { physics, calls } = await harness();
  for (let i = 0; i < 120; i++) physics.update(1 / 120);
  assert.ok(calls.steps.length >= 129 && calls.steps.length <= 130);
  assert.ok(calls.steps.every(delta => delta === 1 / 130));
  const before = calls.steps.length;
  physics.update(10);
  assert.ok(calls.steps.length - before <= 6);
  for (const delta of [0, -1, NaN, Infinity]) physics.update(delta);
  assert.ok(calls.steps.length - before <= 6);
  physics.dispose();
});

test("secondary motion keeps advancing after two seconds and never resets on view rotation", async () => {
  const { physics, mesh, root, driver, cloth, calls } = await harness();
  physics.reset();
  for (let i = 0; i < 240; i++) physics.update(1 / 60);
  const settledSteps = calls.steps.length;
  const settledPose = cloth.quaternion.clone();
  for (let i = 0; i < 180; i++) {
    root.rotation.y += 0.2;
    root.position.y += 0.001;
    root.updateMatrixWorld(true);
    physics.update(1 / 60);
  }
  assert.ok(calls.steps.length > settledSteps);
  assert.ok(!cloth.quaternion.equals(settledPose));
  driver.rotation.y = 0.3;
  mesh.updateMatrixWorld(true);
  physics.update(1 / 60);
  assert.ok(calls.steps.length > settledSteps);
  assert.ok(!cloth.quaternion.equals(settledPose));
  assert.equal(calls.resets, 1, "motion must preserve the existing physical state");
  physics.dispose();
});

test("desktop physics keeps body collisions, relaxes joints and preserves source PMX data", async () => {
  const { physics, mesh, calls } = await harness();
  const original = mesh.geometry.userData.MMD.rigidBodies;
  assert.deepEqual(calls.bodies.map(body => body.groupTarget), [0xffff, 0xffff, 4]);
  assert.equal(original[2].groupTarget, 0xfffe, "the source model's collision filters must remain intact");
  assert.ok(calls.iterations > 10, "dense joints need more than Bullet's default solver iterations");
  for (let axis = 0; axis < 6; axis++) {
    const settings = new Map(calls.limits.filter(call => call[2] === axis).map(([id, value]) => [id, value]));
    assert.ok(settings.get(2) > 0 && settings.get(2) < 0.475, "correct joint errors more gently than MMDPhysics' default");
    assert.ok(settings.get(3) > 0 && settings.get(4) > 0, "allow coupled joints to relax on all axes");
  }
  assert.equal(calls.sleeping.length, 1, "only dynamic bodies should have their sleeping thresholds changed");
  assert.ok(calls.sleeping[0].every(value => value > 0), "let bodies sleep at low velocity rather than disabling sleeping");
  physics.dispose();
});

test("detachable hat ribbons follow a dedicated kinematic anchor without mutating PMX data", async () => {
  const { physics, mesh, calls } = await harness(true);
  assert.equal(calls.bodies.length, 3);
  assert.equal(calls.bodies[2].type, 0);
  assert.equal(calls.bodies[2].boneIndex, 1);
  assert.equal(calls.bodies[2].groupTarget, 0);
  assert.deepEqual([...calls.bodies[2].position], [0, 17, 0]);
  assert.equal(calls.joints[0].rigidBodyIndex1, 2);
  assert.equal(calls.joints[0].rigidBodyIndex2, 1);
  assert.equal(mesh.geometry.userData.MMD.rigidBodies.length, 2);
  assert.equal(mesh.geometry.userData.MMD.constraints[0].rigidBodyIndex1, 0);
  physics.dispose();
});

test("dynamic body movement is capped across all catch-up steps in a frame", async () => {
  const { physics, calls, dynamicPosition, dynamicRotation, root } = await harness();
  calls.jump = 10; calls.spin = 1;
  physics.update(1 / 60);
  assert.ok(dynamicPosition.length() <= 0.160001);
  assert.ok(dynamicRotation.angleTo(new dynamicRotation.constructor()) <= Math.PI / 30 + 1e-6);
  assert.ok(calls.clamped > 0);
  const previous = dynamicPosition.clone(), rotation = dynamicRotation.clone();
  root.rotation.y += 2;
  physics.update(1);
  assert.ok(previous.distanceTo(dynamicPosition) <= 0.160001, "six catch-up steps share the same frame budget");
  assert.ok(rotation.angleTo(dynamicRotation) <= Math.PI / 30 + 1e-6);
  calls.jump = 0.0001; calls.spin = 0.0001;
  const clamps = calls.clamped;
  physics.update(1 / 60);
  assert.equal(calls.clamped, clamps, "natural small motion should pass unchanged");
  physics.dispose();
});
