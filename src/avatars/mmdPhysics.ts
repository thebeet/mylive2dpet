import { MMDPhysics } from "three/examples/jsm/animation/MMDPhysics.js";
import { Quaternion, Vector3, type SkinnedMesh } from "three";
import ammoScriptUrl from "three/examples/jsm/libs/ammo.wasm.js?url";
import ammoWasmUrl from "three/examples/jsm/libs/ammo.wasm.wasm?url";

type AmmoApi = Record<string, unknown> & { destroy(value: object): void };
type AmmoFactory = (options: { wasmBinary: Uint8Array }) => Promise<AmmoApi>;
type RigidBodyData = { type: number; groupIndex: number; groupTarget: number; boneIndex?: number };
type NativeJoint = { constraint: { setParam(id: number, value: number, axis: number): void } };
const physicsStep = 1 / 130;
const maxCatchUpSteps = 6;
const runtime = globalThis as typeof globalThis & { Ammo?: AmmoApi | AmmoFactory };
let ammoLoading: Promise<AmmoApi> | undefined;

function readWasm(): Promise<Uint8Array> {
  // XMLHttpRequest also supports Electron's file:// production assets.
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("GET", ammoWasmUrl);
    request.responseType = "arraybuffer";
    request.onload = () => {
      if ((request.status === 0 || request.status === 200) && request.response?.byteLength) {
        resolve(new Uint8Array(request.response));
      } else reject(new Error("MMD 物理 WASM 加载失败"));
    };
    request.onerror = () => reject(new Error("MMD 物理 WASM 加载失败"));
    request.send();
  });
}

function loadAmmo(): Promise<AmmoApi> {
  if (ammoLoading) return ammoLoading;
  const script = document.createElement("script");
  script.src = ammoScriptUrl;
  ammoLoading = Promise.all([
    new Promise<AmmoFactory>((resolve, reject) => {
      script.onload = () => {
        if (typeof runtime.Ammo === "function") resolve(runtime.Ammo);
        else reject(new Error("MMD 物理引擎初始化失败"));
      };
      script.onerror = () => reject(new Error("MMD 物理引擎加载失败"));
      document.head.appendChild(script);
    }),
    readWasm(),
  ]).then(([factory, wasmBinary]) => factory({ wasmBinary })).then(engine => {
    runtime.Ammo = engine;
    return engine;
  }).catch(error => {
    ammoLoading = undefined;
    script.remove();
    throw error;
  });
  return ammoLoading;
}

export interface MmdPhysicsController {
  update(delta: number): void;
  reset(): void;
  dispose(): void;
}

export async function createMmdPhysics(mesh: SkinnedMesh, signal: AbortSignal): Promise<MmdPhysicsController> {
  const engine = await loadAmmo();
  signal.throwIfAborted();
  // Three's MMDPhysics has no dispose API. Track the native allocations it owns,
  // including temporary pools and Bullet's world infrastructure, for full cleanup.
  const allocations: { type: string; value: object }[] = [];
  const constructors = new Map<string, unknown>();
  const scopedAmmo = new Proxy(engine, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (typeof key !== "string" || !key.startsWith("bt") || typeof value !== "function") return value;
      if (!constructors.has(key)) constructors.set(key, new Proxy(value, {
        construct(ctor, args) {
          const instance = Reflect.construct(ctor, args) as object;
          allocations.push({ type: key, value: instance });
          return instance;
        },
      }));
      return constructors.get(key);
    },
  });
  function withAmmo<T>(work: () => T): T {
    const previous = runtime.Ammo;
    runtime.Ammo = scopedAmmo;
    try { return work(); }
    finally { runtime.Ammo = previous; }
  }
  const displayPosition = mesh.position.clone();
  const displayQuaternion = mesh.quaternion.clone();
  const displayScale = mesh.scale.clone();
  function inModelSpace<T>(work: () => T): T {
    // View rotation, centering and breathing belong to presentation. Bullet must
    // always see the same coordinate frame, including while resetting bodies.
    // This also avoids MMDPhysics' exact world-scale check detaching a rotated
    // mesh when decomposition produces 0.9999999999999999 instead of 1.
    const parent = mesh.parent;
    displayPosition.copy(mesh.position);
    displayQuaternion.copy(mesh.quaternion);
    displayScale.copy(mesh.scale);
    mesh.parent = null;
    mesh.position.set(0, 0, 0);
    mesh.quaternion.identity();
    mesh.scale.set(1, 1, 1);
    mesh.updateMatrixWorld(true);
    try { return withAmmo(work); }
    finally {
      mesh.parent = parent;
      mesh.position.copy(displayPosition);
      mesh.quaternion.copy(displayQuaternion);
      mesh.scale.copy(displayScale);
      mesh.updateMatrixWorld(true);
    }
  }
  function freeAllocations() {
    const world = allocations.find(entry => entry.type === "btDiscreteDynamicsWorld")?.value as {
      removeConstraint(value: object): void; removeRigidBody(value: object): void;
    } | undefined;
    // Detach first, including when a constructor failed before returning physics.
    if (world) {
      for (const entry of allocations) if (entry.type === "btGeneric6DofSpringConstraint") world.removeConstraint(entry.value);
      for (const entry of allocations) if (entry.type === "btRigidBody") world.removeRigidBody(entry.value);
    }
    for (const { value } of allocations.reverse()) engine.destroy(value);
    allocations.length = 0;
  }
  let physics: MMDPhysics;
  try {
    const data = mesh.geometry.userData.MMD;
    // Desktop-sized secondary motion needs body collisions, but the densely
    // overlapping garment panels must not continually push against each other.
    // Preserve the PMX's body collision exclusions and its source parameters.
    const bodyGroups = (data.rigidBodies as RigidBodyData[]).reduce((mask, body) =>
      body.type === 0 ? mask | (1 << body.groupIndex) : mask, 0);
    const rigidBodies = (data.rigidBodies as RigidBodyData[]).map(body =>
      body.type === 0 ? body : { ...body, groupTarget: body.groupTarget & bodyGroups });
    // Furina's hat ribbons are constrained to the head in the source PMX.
    // Give those joints a kinematic hat anchor at the same bind transform, so
    // removing the hat carries its ribbons without pulling them toward the head.
    const hat = mesh.skeleton?.getBoneByName("帽");
    const hatIndex = hat ? mesh.skeleton.bones.indexOf(hat) : -1;
    const headBody = hat ? rigidBodies.findIndex(body => body.type === 0 && mesh.skeleton.bones[body.boneIndex!]?.name === "頭") : -1;
    const constraints = data.constraints.map((joint: { rigidBodyIndex1: number; rigidBodyIndex2: number }) => ({ ...joint }));
    if (hatIndex >= 0 && headBody >= 0) {
      const anchor = rigidBodies.length;
      rigidBodies.push({ ...rigidBodies[headBody], boneIndex: hatIndex, groupTarget: 0 });
      const onHat = (index: number) => {
        let bone = mesh.skeleton.bones[rigidBodies[index]?.boneIndex!];
        while (bone) { if (bone === hat) return true; bone = bone.parent as typeof bone; }
        return false;
      };
      for (const joint of constraints) {
        if (joint.rigidBodyIndex1 === headBody && onHat(joint.rigidBodyIndex2)) joint.rigidBodyIndex1 = anchor;
        else if (joint.rigidBodyIndex2 === headBody && onHat(joint.rigidBodyIndex1)) joint.rigidBodyIndex2 = anchor;
      }
    }
    physics = inModelSpace(() => {
      const instance = new MMDPhysics(mesh, rigidBodies, constraints, { unitStep: physicsStep, maxStepNum: maxCatchUpSteps });
      const world = instance.world as unknown as { getSolverInfo(): { set_m_numIterations(value: number): void } };
      world.getSolverInfo().set_m_numIterations(40);
      for (const entry of instance.constraints) {
        const { constraint } = entry as unknown as NativeJoint;
        for (let axis = 0; axis < 6; axis++) {
          // Gentle limit correction (STOP_ERP) and compliance (CFM/STOP_CFM)
          // let interconnected cloth joints relax instead of fighting over
          // an exact position on every step. Keep the model's spring strengths.
          constraint.setParam(2, 0.05, axis);
          constraint.setParam(3, 0.01, axis);
          constraint.setParam(4, 0.01, axis);
        }
      }
      for (const entry of instance.bodies) {
        if ((entry.params as RigidBodyData).type === 0) continue;
        const body = entry.body as { setSleepingThresholds(linear: number, angular: number): void };
        body.setSleepingThresholds(0.03, 0.03);
      }
      return instance;
    });
  } catch (error) {
    freeAllocations();
    throw error;
  }
  const zero = withAmmo(() => {
    const api = scopedAmmo as AmmoApi & { btVector3: new (x: number, y: number, z: number) => object };
    return new api.btVector3(0, 0, 0);
  });
  // Bound solver motion before it reaches the visible skeleton. A frame may
  // contain several catch-up steps, so share one displacement budget among them.
  // Kinematic bodies remain controlled by the authored animation.
  const positions = mesh.geometry.getAttribute("position");
  let minY = Infinity, maxY = -Infinity;
  if (positions) for (let i = 0; i < positions.count; i++) {
    minY = Math.min(minY, positions.getY(i)); maxY = Math.max(maxY, positions.getY(i));
  }
  const modelHeight = Number.isFinite(maxY - minY) && maxY > minY ? maxY - minY : 20;
  const maxFrameDistance = modelHeight * 0.008;
  const maxFrameAngle = Math.PI / 30;
  let stepDistance = maxFrameDistance, stepAngle = maxFrameAngle;
  const scratch = withAmmo(() => {
    const api = scopedAmmo as AmmoApi & {
      btVector3: new (x: number, y: number, z: number) => { setValue(x: number, y: number, z: number): void };
      btQuaternion: new (x: number, y: number, z: number, w: number) => { setValue(x: number, y: number, z: number, w: number): void };
    };
    return { origin: new api.btVector3(0, 0, 0), rotation: new api.btQuaternion(0, 0, 0, 1) };
  });
  for (const entry of physics.bodies) {
    if ((entry.params as RigidBodyData).type === 0) continue;
    const body = entry.body as unknown as {
      getCenterOfMassTransform(): {
        getOrigin(): { x(): number; y(): number; z(): number };
        getRotation(): { x(): number; y(): number; z(): number; w(): number };
        setOrigin(value: object): void; setRotation(value: object): void;
      };
      setCenterOfMassTransform(value: object): void;
      getMotionState(): { setWorldTransform(value: object): void };
      setLinearVelocity(value: object): void; setAngularVelocity(value: object): void; clearForces(): void;
    };
    const previous = new Vector3(), current = new Vector3();
    const previousRotation = new Quaternion(), rotation = new Quaternion();
    const updateFromBone = entry.updateFromBone.bind(entry), updateBone = entry.updateBone.bind(entry);
    entry.updateFromBone = () => {
      const transform = body.getCenterOfMassTransform(), p = transform.getOrigin(), q = transform.getRotation();
      previous.set(p.x(), p.y(), p.z()); previousRotation.set(q.x(), q.y(), q.z(), q.w());
      return updateFromBone();
    };
    entry.updateBone = () => {
      const transform = body.getCenterOfMassTransform(), p = transform.getOrigin(), q = transform.getRotation();
      current.set(p.x(), p.y(), p.z()); rotation.set(q.x(), q.y(), q.z(), q.w());
      const distance = previous.distanceTo(current), angle = previousRotation.angleTo(rotation);
      if (distance > stepDistance || angle > stepAngle || !Number.isFinite(distance + angle)) {
        if (!Number.isFinite(distance)) current.copy(previous);
        else if (distance > stepDistance) current.sub(previous).multiplyScalar(stepDistance / distance).add(previous);
        if (!Number.isFinite(angle)) rotation.copy(previousRotation);
        else if (angle > stepAngle) rotation.slerpQuaternions(previousRotation, rotation, stepAngle / angle);
        scratch.origin.setValue(current.x, current.y, current.z);
        scratch.rotation.setValue(rotation.x, rotation.y, rotation.z, rotation.w);
        transform.setOrigin(scratch.origin); transform.setRotation(scratch.rotation);
        body.setCenterOfMassTransform(transform);
        body.getMotionState().setWorldTransform(transform);
        body.setLinearVelocity(zero); body.setAngularVelocity(zero); body.clearForces();
      }
      return updateBone();
    };
  }
  let disposed = false;
  let accumulated = 0;
  return {
    update(delta) {
      if (disposed || !Number.isFinite(delta) || delta <= 0) return;
      // MMDPhysics otherwise advances at least one full step even on a fast
      // render frame. Accumulate real elapsed time and bound catch-up work.
      accumulated = Math.min(accumulated + delta, physicsStep * maxCatchUpSteps);
      if (accumulated < physicsStep) return;
      const steps = Math.min(maxCatchUpSteps, Math.floor((accumulated + 1e-12) / physicsStep));
      const frameBudget = Math.min(1, delta * 60);
      stepDistance = maxFrameDistance * frameBudget / steps;
      stepAngle = maxFrameAngle * frameBudget / steps;
      inModelSpace(() => {
        while (accumulated >= physicsStep) {
          physics.update(physicsStep);
          accumulated -= physicsStep;
        }
      });
    },
    reset() {
      if (disposed) return;
      accumulated = 0;
      stepDistance = maxFrameDistance * physicsStep * 60;
      stepAngle = maxFrameAngle * physicsStep * 60;
      inModelSpace(() => {
        // Clear momentum as well as transforms after a long pause or initial posing.
        for (const entry of physics.bodies) {
          const body = entry.body as { setLinearVelocity(v: object): void; setAngularVelocity(v: object): void; clearForces(): void };
          body.setLinearVelocity(zero);
          body.setAngularVelocity(zero);
          body.clearForces();
        }
        physics.reset();
        for (let i = 0; i < 130; i++) physics.update(physicsStep);
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      freeAllocations();
    },
  };
}
