const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const ts = require("typescript");
const { readGeneratedMotions } = require("../electron/plugins/avatar3d/motions");

test("motion catalogs retain asset URLs, reject missing clips and do not apply to other models", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pet-motions-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "assets/角色/motions");
  fs.mkdirSync(directory, { recursive: true });
  const catalog = { version: 1, models: ["model.pmx"], motions: [{ id: "idle", label: "待机", file: "idle.motion.json", loop: true }] };
  const save = () => fs.writeFileSync(path.join(directory, "catalog.json"), JSON.stringify(catalog));
  assert.equal(readGeneratedMotions(root, "assets/角色/model.pmx"), null);
  save();
  assert.equal(readGeneratedMotions(root, "assets/角色/other.pmx"), null);
  assert.throws(() => readGeneratedMotions(root, "assets/角色/model.pmx"), /ENOENT/);
  fs.writeFileSync(path.join(directory, "idle.motion.json"), "{}");
  assert.equal(readGeneratedMotions(root, "assets/角色/model.pmx")[0].url, "./assets/%E8%A7%92%E8%89%B2/motions/idle.motion.json");
  catalog.motions.push({ ...catalog.motions[0], file: "../idle.motion.json" });
  save();
  assert.throws(() => readGeneratedMotions(root, "assets/角色/model.pmx"), /无效/);
});

async function playerHarness(withPosition = false) {
  const THREE = await import("three");
  const mesh = new THREE.SkinnedMesh(new THREE.BufferGeometry());
  const head = new THREE.Bone(); head.name = "頭";
  const cloth = new THREE.Bone(); cloth.name = "cloth";
  mesh.add(head, cloth);
  mesh.bind(new THREE.Skeleton([head, cloth]));
  const clip = (name, angle) => new THREE.AnimationClip(name, 1, [new THREE.QuaternionKeyframeTrack(".bones[頭].quaternion", [0, 0.5, 1], [
    0, 0, 0, 1, ...new THREE.Quaternion().setFromEuler(new THREE.Euler(angle, 0, 0)).toArray(), 0, 0, 0, 1,
  ])]);
  const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, "../src/avatars/mmdMotions.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(source, { exports, require: () => THREE, console });
  const nod = clip("nod", 0.2);
  const idle = clip("idle", 0);
  if (withPosition) {
    idle.tracks.push(new THREE.VectorKeyframeTrack(".bones[頭].position", [0, 1], [0, 0, 0, 0, 0, 0]));
    nod.tracks.push(new THREE.VectorKeyframeTrack(".bones[頭].position", [0, 0.5, 1], [0, 0, 0, 0.5, -0.3, 0, 0, 0, 0]));
  }
  const player = exports.createMmdMotionPlayer(mesh, [
    { motion: { id: "idle", loop: true }, clip: idle },
    { motion: { id: "nod", loop: false }, clip: nod },
    { motion: { id: "bow", loop: false }, clip: clip("bow", 0.3) },
  ]);
  return { player, head, cloth };
}

test("one-shot motion blends back to idle and can be interrupted without snapping", async () => {
  const { player, head } = await playerHarness();
  assert.equal(player.play("missing"), false);
  player.play("nod");
  for (let i = 0; i < 30; i++) player.update(1 / 60);
  assert.ok(head.rotation.x > 0.15);
  const previous = head.quaternion.clone();
  player.play("bow");
  player.update(1 / 60);
  assert.ok(previous.angleTo(head.quaternion) < 0.05);
  for (let i = 0; i < 120; i++) player.update(1 / 60);
  assert.ok(Math.abs(head.rotation.x) < 1e-6);
  assert.ok(player.trackingWeight > 0.95);
  player.dispose();
  player.dispose();
  assert.equal(player.play("nod"), false);
});

test("head tracking does not accumulate into clips or overwrite unanimated cloth bones", async () => {
  const { player, head, cloth } = await playerHarness();
  cloth.rotation.z = 0.4;
  for (let i = 0; i < 300; i++) {
    head.rotation.y += 0.2;
    player.update(1 / 60);
    assert.ok(Math.abs(head.rotation.y) < 1e-6);
  }
  assert.ok(Math.abs(cloth.rotation.z - 0.4) < 1e-6);
  player.dispose();
});

test("translated dance bones ignore external pose edits and blend back when interrupted", async () => {
  const { player, head } = await playerHarness(true);
  player.play("nod");
  for (let i = 0; i < 30; i++) { head.position.x += 20; player.update(1 / 60); }
  assert.ok(head.position.x > 0.45 && head.position.x < 0.51);
  const previous = head.position.clone();
  player.play("idle");
  player.update(1 / 60);
  assert.ok(previous.distanceTo(head.position) < 0.06);
  for (let i = 0; i < 60; i++) player.update(1 / 60);
  assert.ok(head.position.length() < 1e-6);
  player.dispose();
});

const modelFile = path.join(__dirname, "../assets/【芙宁娜】/【芙宁娜】.pmx");
test("generated Furina clips fit named bones, animate dance legs and return to a shared idle pose", { skip: !fs.existsSync(modelFile) }, async () => {
  const THREE = await import("three");
  const { bakeMotionPack, parseModel } = await import("../scripts/generate-furina-motions.mjs");
  const model = parseModel(modelFile);
  const pack = bakeMotionPack(model);
  assert.equal(pack.clips.length, 9);
  assert.equal(new Set(pack.clips.map(motion => motion.clip.uuid)).size, 9, "clips need distinct identities for the animation mixer");
  const dance = THREE.AnimationClip.parse(pack.clips.find(motion => motion.id === "swan_dance").clip);
  for (const side of ["左", "右"]) {
    const arm = dance.tracks.find(track => track.name === `.bones[${side}腕].quaternion`);
    const sample = arm.createInterpolant();
    const low = new THREE.Quaternion().fromArray(sample.evaluate(1.8));
    const high = new THREE.Quaternion().fromArray(sample.evaluate(4));
    assert.ok(low.angleTo(high) > 0.9, "both wings must rise through a visible arc");
    let previous = new THREE.Quaternion().fromArray(sample.evaluate(0));
    for (let frame = 1; frame <= dance.duration * 30; frame++) {
      const current = new THREE.Quaternion().fromArray(sample.evaluate(frame / 30));
      assert.ok(previous.angleTo(current) < 0.08, "swan arms must move smoothly without sudden jumps");
      previous = current;
    }
  }
  const names = new Set(model.bones.map(bone => bone.name));
  for (const motion of pack.clips) {
    const clip = THREE.AnimationClip.parse(motion.clip);
    assert.ok(clip.validate());
    assert.ok(clip.tracks.some(track => track.times.length > 2), `${motion.id} must contain movement`);
    for (const track of clip.tracks) {
      const [, name, property] = /^\.bones\[(.+)\]\.(quaternion|position)$/.exec(track.name) || [];
      assert.ok(names.has(name));
      assert.ok(!/髪|スカート|全ての親/.test(name), "cloth and display root stay outside animation control");
      if (property === "position") {
        assert.equal(name, "センター");
        const start = new THREE.Vector3().fromArray(track.values);
        const end = new THREE.Vector3().fromArray(track.values, track.values.length - 3);
        assert.ok(start.distanceTo(end) < 1e-6);
        if (motion.id !== "swan_dance") for (let i = 0; i < track.values.length; i += 3) assert.ok(start.distanceTo(new THREE.Vector3().fromArray(track.values, i)) < 1e-6);
        continue;
      }
      if (motion.id !== "swan_dance" && /足|ひざ|下半身|センター/.test(name)) {
        for (let i = 0; i < track.values.length; i += 4) assert.ok(new THREE.Quaternion().fromArray(track.values, i).angleTo(new THREE.Quaternion()) < 0.001);
      }
      for (let i = 0; i < track.values.length; i += 4) {
        assert.ok(Math.abs(new THREE.Quaternion().fromArray(track.values, i).length() - 1) < 1e-6);
      }
      const first = new THREE.Quaternion().fromArray(track.values);
      const last = new THREE.Quaternion().fromArray(track.values, track.values.length - 4);
      assert.ok(first.angleTo(last) < 0.001, "loop and one-shot endpoints must meet without a pose jump");
    }
  }
});

test("swan dance bends deforming knees and keeps supporting forefeet planted", { skip: !fs.existsSync(modelFile) }, async () => {
  const THREE = await import("three");
  const { bakeMotionPack, parseModel } = await import("../scripts/generate-furina-motions.mjs");
  const model = parseModel(modelFile);
  const rig = new THREE.Group();
  const list = model.bones.map(data => { const bone = new THREE.Bone(); bone.name = data.name; bone.position.fromArray(data.position); if (data.parentIndex >= 0) bone.position.sub(new THREE.Vector3().fromArray(model.bones[data.parentIndex].position)); return bone; });
  list.forEach((bone, i) => (list[model.bones[i].parentIndex] || rig).add(bone));
  rig.updateMatrixWorld(true);
  const clip = THREE.AnimationClip.parse(bakeMotionPack(model).clips.find(motion => motion.id === "swan_dance").clip);
  const samples = clip.tracks.map(track => ({ name: /^\.bones\[(.+)\]/.exec(track.name)[1], property: track.name.endsWith(".position") ? "position" : "quaternion", sample: track.createInterpolant() }));
  const toeOffsets = Object.fromEntries(["左", "右"].map(side => [side, new THREE.Vector3().fromArray(model.bones.find(b=>b.name===`${side}つま先`).position).sub(new THREE.Vector3().fromArray(model.bones.find(b=>b.name===`${side}足首`).position))]));
  const toeRest = Object.fromEntries(["左", "右"].map(side => [side, new THREE.Vector3().fromArray(model.bones.find(b=>b.name===`${side}つま先`).position)]));
  for (const [time, side] of [[2, "左"], [4, "右"], [6, "右"], [8, "左"], [10, "左"], [12, "左"]]) {
    for (const entry of samples) rig.getObjectByName(entry.name)[entry.property].fromArray(entry.sample.evaluate(time));
    rig.updateMatrixWorld(true);
    const ankle = rig.getObjectByName(`${side}足首D`);
    const toe = ankle.localToWorld(toeOffsets[side].clone());
    assert.ok(toe.distanceTo(toeRest[side]) < 0.025, `supporting ${side} toes must stay anchored at ${time}s`);
    assert.ok(rig.getObjectByName(`${side}ひざD`).quaternion.angleTo(new THREE.Quaternion()) > 0.05, "knees must flex as weight shifts");
  }
});
