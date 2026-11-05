import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { Parser } from "mmd-parser";
import * as THREE from "three";

const coreBones = ["上半身", "上半身2", "上半身3", "首", "頭", "左肩", "右肩", "左腕", "右腕", "左ひじ", "右ひじ", "左手首", "右手首"];
const danceBones = ["センター", "下半身", ...["左", "右"].flatMap(side => ["足", "ひざ", "足首", "足D", "ひざD", "足首D"].map(joint => `${side}${joint}`))];
const animatedBones = [...coreBones, ...danceBones, "帽"];
const idleAngles = {
  左腕: [-0.12, -0.08, -0.65], 右腕: [-0.12, 0.08, 0.65],
  左ひじ: [-0.55, 0.12, -0.9], 右ひじ: [-0.55, -0.12, 0.9],
  左手首: [0.2, 0.1, 0.25], 右手首: [0.2, -0.1, -0.25],
};
const definitions = [
  { id: "idle", label: "待机", duration: 4, loop: true },
  { id: "wave", label: "招手", duration: 3, loop: false },
  { id: "nod", label: "点头", duration: 2.4, loop: false },
  { id: "shake_head", label: "摇头", duration: 2.8, loop: false },
  { id: "thinking", label: "思考", duration: 4, loop: false },
  { id: "bow", label: "鞠躬", duration: 3.2, loop: false },
  { id: "happy", label: "开心", duration: 3.6, loop: false },
  { id: "clap", label: "鼓掌", duration: 3.6, loop: false },
  { id: "hat_tip", label: "摘帽致意", duration: 10, loop: false },
  { id: "swan_dance", label: "天鹅舞", duration: 16, loop: false },
];

export function parseModel(filename) {
  const bytes = fs.readFileSync(filename);
  return new Parser().parsePmx(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), true);
}

function createRig(model) {
  const root = new THREE.Group();
  const list = model.bones.map(data => {
    const bone = new THREE.Bone();
    bone.name = data.name;
    bone.position.fromArray(data.position);
    if (data.parentIndex >= 0) bone.position.sub(new THREE.Vector3().fromArray(model.bones[data.parentIndex].position));
    return bone;
  });
  list.forEach((bone, i) => (list[model.bones[i].parentIndex] || root).add(bone));
  root.updateMatrixWorld(true);
  const bones = Object.fromEntries(list.map(bone => [bone.name, bone]));
  for (const name of [...animatedBones, "左中指１", "右中指１", "左人指１", "右人指１", "左小指１", "右小指１"]) {
    if (!bones[name]) throw new Error(`模型缺少生成动作所需骨骼：${name}`);
  }
  return { root, list, bones };
}

function worldPosition(bone) { return bone.getWorldPosition(new THREE.Vector3()); }
function setWorldRotation(bone, quaternion) {
  const parent = bone.parent.getWorldQuaternion(new THREE.Quaternion()).invert();
  bone.quaternion.copy(parent.multiply(quaternion));
  bone.updateMatrixWorld(true);
}
function aimBone(bone, child, target) {
  const origin = worldPosition(bone);
  const current = worldPosition(child).sub(origin).normalize();
  const desired = target.clone().sub(origin).normalize();
  const delta = new THREE.Quaternion().setFromUnitVectors(current, desired);
  setWorldRotation(bone, delta.multiply(bone.getWorldQuaternion(new THREE.Quaternion())));
}

// Analytic two-bone IK uses this model's actual arm lengths and joint positions.
// Fingers and dynamic cloth/hair bones are left to the model and physics.
function reach(rig, side, target, handRotation) {
  const arm = rig.bones[`${side}腕`], elbow = rig.bones[`${side}ひじ`], wrist = rig.bones[`${side}手首`];
  rig.root.updateMatrixWorld(true);
  const shoulder = worldPosition(arm);
  const upperLength = shoulder.distanceTo(worldPosition(elbow));
  const lowerLength = worldPosition(elbow).distanceTo(worldPosition(wrist));
  const direction = target.clone().sub(shoulder);
  const distance = THREE.MathUtils.clamp(direction.length(), Math.abs(upperLength - lowerLength) + 0.01, upperLength + lowerLength - 0.01);
  direction.normalize();
  const pole = new THREE.Vector3(side === "左" ? 1 : -1, -0.8, 0.15);
  pole.addScaledVector(direction, -pole.dot(direction)).normalize();
  const along = (upperLength ** 2 - lowerLength ** 2 + distance ** 2) / (2 * distance);
  const bend = Math.sqrt(Math.max(0, upperLength ** 2 - along ** 2));
  const elbowTarget = shoulder.clone().addScaledVector(direction, along).addScaledVector(pole, bend);
  aimBone(arm, elbow, elbowTarget);
  aimBone(elbow, wrist, shoulder.clone().addScaledVector(direction, distance));
  setWorldRotation(wrist, handRotation);
}

function handOrientation(rig, side, palmNormal, fingerDirection = new THREE.Vector3(0, 1, 0)) {
  const wrist = worldPosition(rig.bones[`${side}手首`]);
  const forward = worldPosition(rig.bones[`${side}中指１`]).sub(wrist).normalize();
  const across = worldPosition(rig.bones[`${side}人指１`]).sub(worldPosition(rig.bones[`${side}小指１`]));
  across.addScaledVector(forward, -across.dot(forward)).normalize();
  const normal = new THREE.Vector3().crossVectors(forward, across).normalize();
  const rest = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(forward, across, normal));
  const targetAcross = new THREE.Vector3().crossVectors(palmNormal, fingerDirection).normalize();
  const target = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(fingerDirection, targetAcross, palmNormal));
  return target.multiply(rest.invert());
}

export function bakeMotionPack(model) {
  const rig = createRig(model);
  const { root, list, bones } = rig;
  const handRotations = {
    左: handOrientation(rig, "左", new THREE.Vector3(-1, 0, 0)),
    右: handOrientation(rig, "右", new THREE.Vector3(1, 0, 0)),
    thinking: handOrientation(rig, "左", new THREE.Vector3(0, 0, -1), new THREE.Vector3(-0.65, 0.76, 0).normalize()),
  };
  const hatRest = worldPosition(bones["帽"]);
  const headRest = worldPosition(bones["頭"]);
  const neckRest = worldPosition(bones["首"]);
  const chestRest = worldPosition(bones["上半身2"]);
  const bodyScale = headRest.y / 16.86992645263672;
  const restPositions = new Map(list.map(bone => [bone, bone.position.clone()]));
  const feet = Object.fromEntries(["左", "右"].map(side => [side, {
    ankle: worldPosition(bones[`${side}足首`]),
    toeOffset: worldPosition(bones[`${side}つま先`]).sub(worldPosition(bones[`${side}足首`])),
  }]));
  function placeFoot(side, shift, rise, turnout) {
    // Keep the forefoot on the floor while lifting the heel, then solve the
    // hip/knee analytically. Bake the deforming D chain too (no runtime grants).
    const foot = feet[side];
    const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(rise, turnout, 0, "YXZ"));
    const target = foot.ankle.clone().add(foot.toeOffset).add(shift)
      .sub(foot.toeOffset.clone().applyQuaternion(rotation));
    root.updateMatrixWorld(true);
    const hip = bones[`${side}足`], knee = bones[`${side}ひざ`], ankle = bones[`${side}足首`];
    const origin = worldPosition(hip);
    const upper = origin.distanceTo(worldPosition(knee)), lower = worldPosition(knee).distanceTo(worldPosition(ankle));
    const direction = target.clone().sub(origin);
    const distance = THREE.MathUtils.clamp(direction.length(), Math.abs(upper - lower) + 0.001, upper + lower - 0.001);
    direction.normalize();
    const pole = new THREE.Vector3(Math.sin(turnout), 0, Math.cos(turnout));
    pole.addScaledVector(direction, -pole.dot(direction)).normalize();
    const along = (upper * upper - lower * lower + distance * distance) / (2 * distance);
    const bend = Math.sqrt(Math.max(0, upper * upper - along * along));
    aimBone(hip, knee, origin.clone().addScaledVector(direction, along).addScaledVector(pole, bend));
    aimBone(knee, ankle, origin.clone().addScaledVector(direction, distance));
    setWorldRotation(ankle, rotation);
    for (const joint of ["足", "ひざ", "足首"]) bones[`${side}${joint}D`].quaternion.copy(bones[`${side}${joint}`].quaternion);
    root.updateMatrixWorld(true);
  }
  // Cubic Hermite phrases preserve velocity between poses instead of stopping
  // at every key. The outer envelope eases into and out of the standing pose.
  function phrase(time, values) {
    const t = THREE.MathUtils.clamp(time / 2, 0, values.length - 1);
    const i = Math.min(Math.floor(t), values.length - 2), u = t - i;
    const a = values[i], b = values[i + 1];
    const ma = i === 0 ? 0 : (b - values[i - 1]) / 2;
    const mb = i + 2 >= values.length ? 0 : (values[i + 2] - a) / 2;
    return (2*u**3-3*u*u+1)*a + (u**3-2*u*u+u)*ma + (-2*u**3+3*u*u)*b + (u**3-u*u)*mb;
  }
  function idlePose() {
    list.forEach(bone => { bone.quaternion.identity(); bone.position.copy(restPositions.get(bone)); });
    for (const [name, angles] of Object.entries(idleAngles)) bones[name].rotation.set(...angles);
    root.updateMatrixWorld(true);
  }
  idlePose();
  const base = animatedBones.map(name => bones[name].quaternion.clone());
  const clips = definitions.map(definition => {
    const times = [], positions = [], hatPositions = [], values = animatedBones.map(() => []);
    const frameCount = Math.round(definition.duration * 30);
    for (let frame = 0; frame <= frameCount; frame++) {
      const time = frame / 30;
      times.push(time);
      idlePose();
      if (definition.id === "idle") {
        bones["上半身2"].rotation.x = Math.sin(time / definition.duration * Math.PI * 2) * 0.006;
        bones["頭"].rotation.z = Math.sin(time / definition.duration * Math.PI * 2) * 0.004;
      } else {
        const cycle = time / definition.duration;
        switch (definition.id) {
          case "wave":
            bones["左腕"].rotation.set(0, 0, -0.05);
            bones["左ひじ"].rotation.set(0, 0, 1.8 + Math.sin(time * 6) * 0.12);
            bones["左手首"].rotation.set(0, 0, Math.sin(time * 6) * 0.2);
            break;
          case "nod":
            bones["頭"].rotation.x = 0.14 * (0.5 - 0.5 * Math.cos(cycle * Math.PI * 4));
            bones["首"].rotation.x = bones["頭"].rotation.x * 0.2;
            break;
          case "shake_head":
            bones["頭"].rotation.y = Math.sin(cycle * Math.PI * 4) * 0.18;
            break;
          case "thinking":
            reach(rig, "左", headRest.clone().add(new THREE.Vector3(0.95, -1.5, 1).multiplyScalar(bodyScale)), handRotations.thinking);
            bones["頭"].rotation.set(0.04, 0.08, -0.08);
            break;
          case "bow":
            bones["上半身"].rotation.x = 0.14;
            bones["上半身2"].rotation.x = 0.08;
            bones["首"].rotation.x = 0.02;
            bones["頭"].rotation.x = 0.03;
            break;
          case "happy":
            bones["左肩"].rotation.z = -0.055;
            bones["右肩"].rotation.z = 0.055;
            bones["頭"].rotation.z = Math.sin(cycle * Math.PI * 4) * 0.07;
            bones["上半身2"].rotation.z = Math.sin(cycle * Math.PI * 4) * 0.025;
            break;
          case "clap": {
            const gap = (0.18 + (0.5 + 0.5 * Math.cos(time * Math.PI * 4)) * 0.47) * bodyScale;
            const center = new THREE.Vector3(chestRest.x, (chestRest.y + neckRest.y) / 2 - 0.5 * bodyScale, chestRest.z + 1.2 * bodyScale);
            reach(rig, "左", center.clone().add(new THREE.Vector3(gap, 0, 0)), handRotations.左);
            reach(rig, "右", center.clone().add(new THREE.Vector3(-gap, 0, 0)), handRotations.右);
            break;
          }
          case "hat_tip": {
            const ease = (a, b) => THREE.MathUtils.smootherstep(time, a, b);
            const lift = ease(2, 3) * (1 - ease(7.1, 8.1));
            const carry = ease(3, 4.6) * (1 - ease(5.8, 7.1));
            const hold = ease(0.3, 2) * (1 - ease(8.1, 9.7));
            const bow = ease(4.6, 5) * (1 - ease(5.4, 5.9));
            bones["上半身"].rotation.x = 0.09 * bow;
            bones["頭"].rotation.set(0.07 * bow, -0.04 * hold, -0.03 * hold);
            root.updateMatrixWorld(true);
            const rotation = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.2 * carry, -0.15 * carry, -0.2 * carry));
            const target = hatRest.clone().add(new THREE.Vector3(0, 1.4 * lift, 0).multiplyScalar(bodyScale));
            target.lerp(hatRest.clone().add(new THREE.Vector3(1.65, -5.2, 3.3).multiplyScalar(bodyScale)), carry);
            if (time >= 2 && time <= 8.1) {
              bones["帽"].position.copy(bones["帽"].parent.worldToLocal(target.clone()));
              setWorldRotation(bones["帽"], rotation);
            }
            const grip = new THREE.Vector3(0.95, -0.8, 0.5).multiplyScalar(bodyScale);
            const handTarget = target.clone().add(grip.applyQuaternion(rotation));
            const before = ["腕", "ひじ", "手首"].map(joint => bones[`左${joint}`].quaternion.clone());
            reach(rig, "左", handTarget, handRotations.左);
            ["腕", "ひじ", "手首"].forEach((joint, i) => bones[`左${joint}`].quaternion.slerpQuaternions(before[i], bones[`左${joint}`].quaternion.clone(), hold));
            break;
          }
          case "swan_dance": {
            const ease = t => { const u = THREE.MathUtils.clamp(t, 0, 1); return u*u*u*(10+u*(-15+6*u)); };
            const envelope = ease(time / 1.8) * ease((definition.duration - time) / 1.8);
            const shift = phrase(time, [0, 0.18, -0.45, -0.5, 0, 0.5, 0.45, -0.12, 0]);
            const rise = phrase(time, [0, -0.32, 0.22, 0.28, -0.36, 0.28, 0.22, -0.22, 0]);
            bones["センター"].position.add(new THREE.Vector3(shift, rise, 0).multiplyScalar(bodyScale * envelope));
            bones["下半身"].rotation.set(0.015 * envelope, shift * 0.13 * envelope, -shift * 0.035 * envelope);
            bones["上半身"].rotation.set(0.025, -shift * 0.18, -shift * 0.12);
            bones["上半身2"].rotation.set(-0.035, -shift * 0.1, -shift * 0.08);
            bones["上半身3"].rotation.x = -0.025;
            bones["首"].rotation.z = shift * 0.045;
            bones["頭"].rotation.set(0.035 + rise * 0.04, -shift * 0.26, shift * 0.12);
            for (const [side, sign] of [["左", 1], ["右", -1]]) {
              const delayed = Math.max(0, time - (side === "左" ? 0 : 0.35));
              const wings = [ -0.4, 0.12, 1.35, 0.65, -0.15, 1.15, 0.85, -0.28, -0.4 ];
              const wing = phrase(delayed, wings), elbow = phrase(Math.max(0, delayed - 0.22), wings);
              const wrist = phrase(Math.max(0, delayed - 0.48), wings);
              bones[`${side}肩`].rotation.set(0, -sign * 0.025, sign * wing * 0.045);
              bones[`${side}腕`].rotation.set(-0.2 - 0.12 * Math.sin(delayed * 0.6), -sign * (0.15 + shift * 0.08), sign * wing);
              bones[`${side}ひじ`].rotation.set(-0.28, sign * 0.12, sign * (-0.34 + (elbow - wing) * 0.55));
              bones[`${side}手首`].rotation.set(0.15 + Math.sin(delayed * 0.65) * 0.12, sign * 0.13, sign * (-0.12 + (wrist - wing) * 0.6));
              // Extend the free leg to a pointed side tendu, then transfer
              // weight and mirror it. Supporting toes remain anchored.
              const extension = side === "左"
                ? phrase(time, [0, 0, 0.55, 1, 0, 0, 0, 0, 0])
                : phrase(time, [0, 0, 0, 0, 0, 1, 0.55, 0, 0]);
              const reachOut = Math.max(0, extension) * envelope;
              const heel = Math.max(0, rise) * 1.15 + reachOut * 0.24;
              placeFoot(side, new THREE.Vector3(sign * reachOut * 1.5, reachOut * 0.12, reachOut * 0.25).multiplyScalar(bodyScale), heel * envelope, sign * 0.18 * envelope);
            }
            break;
          }
        }
        const blendTime = definition.id === "swan_dance" ? 1.4 : 0.7;
        const weight = THREE.MathUtils.smoothstep(time, 0, blendTime)
          * (1 - THREE.MathUtils.smoothstep(time, definition.duration - (definition.id === "swan_dance" ? 1.4 : 0.75), definition.duration));
        animatedBones.forEach((name, i) => {
          bones[name].quaternion.slerpQuaternions(base[i], bones[name].quaternion.clone(), weight);
        });
      }
      animatedBones.forEach((name, i) => values[i].push(...bones[name].quaternion.toArray()));
      positions.push(...bones["センター"].position.toArray());
      hatPositions.push(...bones["帽"].position.toArray());
    }
    const tracks = animatedBones.map((name, i) => new THREE.QuaternionKeyframeTrack(`.bones[${name}].quaternion`, times, values[i]).optimize());
    tracks.push(new THREE.VectorKeyframeTrack(".bones[センター].position", times, positions).optimize());
    tracks.push(new THREE.VectorKeyframeTrack(".bones[帽].position", times, hatPositions).optimize());
    const json = THREE.AnimationClip.toJSON(new THREE.AnimationClip(definition.id, definition.duration, tracks));
    delete json.uuid;
    const hash = createHash("sha256").update(JSON.stringify(json)).digest("hex");
    json.uuid = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
    return { ...definition, file: `${definition.id}.motion.json`, clip: json };
  });
  return { bones: animatedBones, clips };
}

export function generate(modelFile, outputDirectory = path.join(path.dirname(modelFile), "motions")) {
  const model = parseModel(modelFile);
  const pack = bakeMotionPack(model);
  const compatibleModels = [];
  for (const filename of ["【芙宁娜】.pmx", "【芙宁娜_荒】.pmx"]) {
    const candidate = path.join(path.dirname(modelFile), filename);
    if (!fs.existsSync(candidate)) continue;
    const other = parseModel(candidate);
    if (pack.bones.every(name => {
      const first = model.bones.find(bone => bone.name === name), second = other.bones.find(bone => bone.name === name);
      return second && first.position.every((value, i) => Math.abs(value - second.position[i]) < 1e-4);
    })) compatibleModels.push(filename);
  }
  if (!compatibleModels.includes(path.basename(modelFile))) compatibleModels.push(path.basename(modelFile));
  fs.mkdirSync(outputDirectory, { recursive: true });
  for (const motion of pack.clips) fs.writeFileSync(path.join(outputDirectory, motion.file), JSON.stringify(motion.clip));
  const catalog = {
    version: 1, generator: "furina-bone-keyframes", fps: 30,
    sourceSha256: createHash("sha256").update(fs.readFileSync(modelFile)).digest("hex"),
    models: compatibleModels, bones: pack.bones,
    motions: pack.clips.map(({ clip, ...motion }) => motion),
  };
  fs.writeFileSync(path.join(outputDirectory, "catalog.json"), JSON.stringify(catalog, null, 2) + "\n");
  return catalog;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const modelFile = path.resolve(process.argv[2] || path.join(root, "assets/【芙宁娜】/【芙宁娜】.pmx"));
  const catalog = generate(modelFile);
  console.log(`已根据 ${path.basename(modelFile)} 的骨骼生成 ${catalog.motions.length} 个动作：${catalog.motions.map(motion => motion.label).join("、")}`);
  console.log(path.join(path.dirname(modelFile), "motions"));
}
