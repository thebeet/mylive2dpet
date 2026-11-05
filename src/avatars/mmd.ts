import * as THREE from "three";
import { MMDLoader } from "three/examples/jsm/loaders/MMDLoader.js";
import type { AvatarRenderer, RendererContext } from "./types";
import type { MmdPhysicsController } from "./mmdPhysics";
import { loadMmdMotions, type MmdMotionPlayer } from "./mmdMotions";

function disposeMesh(mesh: THREE.SkinnedMesh) {
  mesh.geometry.dispose();
  const textures = new Set<THREE.Texture>();
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const material of materials) {
    for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
    material.dispose();
  }
  textures.forEach(texture => texture.dispose());
  mesh.skeleton.dispose();
}

export async function createRenderer({ mount, descriptor, signal }: RendererContext): Promise<AvatarRenderer> {
  const manager = new THREE.LoadingManager();
  // PMX texture paths use Windows separators, including on Linux.
  manager.setURLModifier(url => url.replace(/\\/g, "/"));
  const failed: string[] = [];
  const loaded = new Promise<void>(resolve => { manager.onLoad = resolve; });
  manager.onError = url => failed.push(url);
  const mesh = await new MMDLoader(manager).loadAsync(descriptor.modelUrl);
  await loaded; // The loader returns the mesh before its textures have finished.
  if (signal.aborted || failed.length) {
    disposeMesh(mesh);
    signal.throwIfAborted();
    throw new Error(`3D 贴图加载失败：${failed[0]}`);
  }

  let physics: MmdPhysicsController | undefined;
  let motionPlayer: MmdMotionPlayer | undefined;
  try {
    if (descriptor.physicsEnabled !== false) {
      const { createMmdPhysics } = await import("./mmdPhysics");
      signal.throwIfAborted();
      // Build constraints in the original bind pose before applying the idle pose.
      physics = await createMmdPhysics(mesh, signal);
    }
    motionPlayer = await loadMmdMotions(mesh, descriptor.motions, signal);
  } catch (error) { physics?.dispose(); disposeMesh(mesh); throw error; }

  let renderer: THREE.WebGLRenderer;
  try { renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true }); }
  catch (error) { motionPlayer?.dispose(); physics?.dispose(); disposeMesh(mesh); throw error; }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const canvas = renderer.domElement;
  mount.prepend(canvas);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0xb9afcf, 2));
  const light = new THREE.DirectionalLight(0xffffff, 2.4);
  light.position.set(-8, 20, 20);
  scene.add(light);
  const root = new THREE.Group();
  scene.add(root);
  root.add(mesh);
  const bones = Object.fromEntries(mesh.skeleton.bones.map(bone => [bone.name, bone]));
  const leftArm = bones["左腕"];
  const rightArm = bones["右腕"];
  const elbow = bones["左ひじ"];
  const wrist = bones["左手首"];
  const rightElbow = bones["右ひじ"];
  const rightWrist = bones["右手首"];
  const head = bones["頭"];
  // The model starts in an A-pose. Bend the elbows and bring both hands forward,
  // rather than rotating straight arms through the torso.
  const applyArmPose = (waveWeight = 0, waveTime = 0) => {
    const blend = THREE.MathUtils.lerp;
    leftArm?.rotation.set(blend(-0.12, 0, waveWeight), blend(-0.08, 0, waveWeight), blend(-0.65, -0.05, waveWeight));
    elbow?.rotation.set(blend(-0.55, 0, waveWeight), blend(0.12, 0, waveWeight), blend(-0.9, 1.8 + Math.sin(waveTime * 6) * 0.12, waveWeight));
    wrist?.rotation.set(blend(0.2, 0, waveWeight), blend(0.1, 0, waveWeight), blend(0.25, Math.sin(waveTime * 6) * 0.2, waveWeight));
    rightArm?.rotation.set(-0.12, 0.08, 0.65);
    rightElbow?.rotation.set(-0.55, -0.12, 0.9);
    rightWrist?.rotation.set(0.2, -0.1, -0.25);
  };
  applyArmPose();
  mesh.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(mesh, true);
  const height = bounds.max.y - bounds.min.y;
  const center = bounds.getCenter(new THREE.Vector3());
  // Rotate around the body center so pitching does not swing the feet across the window.
  mesh.position.sub(center);
  root.position.copy(center);
  const initialYaw = THREE.MathUtils.degToRad(descriptor.rotationY || 0);
  root.rotation.set(0, initialYaw, 0, "YXZ");
  root.updateMatrixWorld(true);
  try { physics?.reset(); }
  catch (error) {
    motionPlayer?.dispose();
    physics?.dispose();
    disposeMesh(mesh);
    renderer.dispose();
    renderer.forceContextLoss();
    canvas.remove();
    throw error;
  }
  const camera = new THREE.OrthographicCamera(-10, 10, 15, -15, 0.1, 2000);
  camera.position.set(center.x, center.y, bounds.max.z + height * 3);
  camera.lookAt(center.x, center.y, center.z);
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const target = { x: 0, y: 0 };
  const following = { x: 0, y: 0 };
  const headOffset = new THREE.Quaternion();
  const headEuler = new THREE.Euler();
  const baseMorphs: number[] = mesh.morphTargetInfluences?.map(() => 0) || [];
  const morphs = mesh.morphTargetDictionary || {};
  const blinkIndex = morphs["まばたき"];
  let waveStart = -Infinity;
  let disposed = false;
  const startedAt = performance.now();
  let previousFrame = startedAt;
  const point = new THREE.Vector3();
  const api: AvatarRenderer = {
    resize() {
      const width = window.innerWidth;
      const viewportHeight = window.innerHeight;
      renderer.setSize(width, viewportHeight);
      const visibleHeight = height / (0.68 * descriptor.scale);
      const halfWidth = visibleHeight * width / viewportHeight / 2;
      // Reserve room above the head; positive offset moves the model down.
      const shift = visibleHeight * (0.12 + descriptor.verticalOffset / viewportHeight);
      camera.left = -halfWidth;
      camera.right = halfWidth;
      camera.top = visibleHeight / 2 + shift;
      camera.bottom = -visibleHeight / 2 + shift;
      camera.updateProjectionMatrix();
    },
    setExpression(name) {
      const weights = descriptor.expressionMorphs?.[name];
      if (!weights || !mesh.morphTargetInfluences) return;
      baseMorphs.fill(0);
      for (const [morph, weight] of Object.entries(weights)) {
        const index = morphs[morph];
        if (index != null) baseMorphs[index] = weight;
      }
      mesh.morphTargetInfluences.splice(0, baseMorphs.length, ...baseMorphs);
    },
    playMotion(id) {
      if (motionPlayer?.play(id)) return;
      if (id === "wave") waveStart = performance.now();
      else if (id === "idle") waveStart = -Infinity;
    },
    onTap() { api.playMotion("wave"); },
    focus(position) {
      target.x = THREE.MathUtils.clamp((position.x / window.innerWidth - 0.5) * 0.3, -0.18, 0.18);
      target.y = THREE.MathUtils.clamp((position.y / window.innerHeight - 0.5) * 0.18, -0.12, 0.12);
    },
    getHeadAnchor() {
      mesh.updateMatrixWorld(true);
      if (head) head.getWorldPosition(point);
      else point.set(center.x, bounds.max.y, center.z);
      if (head) point.y += height * 0.13; // Include Furina's hat above the head bone.
      point.project(camera);
      return { x: (point.x + 1) / 2 * window.innerWidth, headTop: (1 - point.y) / 2 * window.innerHeight };
    },
    hitTest(position) {
      pointer.set(position.x / window.innerWidth * 2 - 1, 1 - position.y / window.innerHeight * 2);
      raycaster.setFromCamera(pointer, camera);
      return raycaster.intersectObject(mesh).length > 0;
    },
    rotate(deltaX, deltaY) {
      const radiansPerPixel = Math.PI / 300;
      root.rotation.x = THREE.MathUtils.clamp(root.rotation.x + deltaY * radiansPerPixel, -Math.PI / 6, Math.PI / 6);
      root.rotation.y += deltaX * radiansPerPixel;
      root.updateMatrixWorld(true);
    },
    resetRotation() {
      root.rotation.set(0, initialYaw, 0, "YXZ");
      root.updateMatrixWorld(true);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      signal.removeEventListener("abort", api.dispose);
      window.clearInterval(timer);
      motionPlayer?.dispose();
      physics?.dispose();
      scene.clear();
      disposeMesh(mesh);
      renderer.dispose();
      renderer.forceContextLoss();
      canvas.remove();
    },
  };
  const timer = window.setInterval(() => {
    const now = performance.now();
    const delta = (now - previousFrame) / 1000;
    previousFrame = now;
    const elapsed = (now - startedAt) / 1000;
    const wave = (now - waveStart) / 1000;
    const envelope = wave < 3
      ? THREE.MathUtils.smoothstep(wave, 0, 0.65) * (1 - THREE.MathUtils.smoothstep(wave, 2.25, 3))
      : 0;
    if (motionPlayer) motionPlayer.update(delta);
    else applyArmPose(envelope, Number.isFinite(wave) ? wave : 0);
    root.position.y = center.y + Math.sin(elapsed * 1.8) * height * 0.002;
    if (head) {
      const follow = 1 - Math.exp(-Math.min(delta, 1 / 15) / 0.25);
      if (motionPlayer) {
        following.x += (target.x - following.x) * follow;
        following.y += (target.y - following.y) * follow;
        const weight = motionPlayer.trackingWeight;
        headOffset.setFromEuler(headEuler.set(following.y * weight, following.x * weight, 0));
        head.quaternion.multiply(headOffset);
      } else {
        head.rotation.y += (target.x - head.rotation.y) * follow;
        head.rotation.x += (target.y - head.rotation.x) * follow;
      }
    }
    if (blinkIndex != null && mesh.morphTargetInfluences) {
      const phase = elapsed % 4.3;
      const blink = phase < 0.18 ? Math.sin(phase / 0.18 * Math.PI) : 0;
      mesh.morphTargetInfluences[blinkIndex] = Math.max(baseMorphs[blinkIndex], blink);
    }
    if (physics) {
      root.updateMatrixWorld(true);
      if (delta > 1) physics.reset();
      else physics.update(delta);
    }
    renderer.render(scene, camera);
  }, 1000 / 60);
  signal.addEventListener("abort", api.dispose, { once: true });
  api.resize();
  api.setExpression("neutral");
  renderer.render(scene, camera);
  return api;
}
