import * as THREE from "three";
import type { Motion } from "./types";

export interface MmdMotionPlayer {
  play(id: string): boolean;
  update(delta: number): void;
  readonly trackingWeight: number;
  dispose(): void;
}

export async function loadMmdMotions(mesh: THREE.SkinnedMesh, motions: Motion[], signal: AbortSignal): Promise<MmdMotionPlayer | undefined> {
  const assets = motions.filter(motion => motion.url);
  if (!assets.length) return undefined;
  const clips = await Promise.all(assets.map(async motion => {
    // Three's FileLoader also supports Electron's file:// assets.
    const data = await new THREE.FileLoader().loadAsync(motion.url!);
    signal.throwIfAborted();
    const clip = THREE.AnimationClip.parse(JSON.parse(data as string));
    // Some Three clip exporters omit UUIDs or reuse them across files. The
    // mixer caches by UUID, so each loaded asset needs its own identity.
    clip.uuid = THREE.MathUtils.generateUUID();
    clip.name = motion.id;
    if (!clip.validate() || clip.duration <= 0) throw new Error(`3D 动作无效：${motion.label}`);
    return { motion, clip };
  }));
  signal.throwIfAborted();
  return createMmdMotionPlayer(mesh, clips);
}

export function createMmdMotionPlayer(mesh: THREE.SkinnedMesh, clips: { motion: Motion; clip: THREE.AnimationClip }[]): MmdMotionPlayer {
  const mixer = new THREE.AnimationMixer(mesh);
  const animated = new Map<string, THREE.Bone>();
  const entries = new Map(clips.map(({ motion, clip }) => {
    for (const track of clip.tracks) {
      const match = /^\.bones\[([^\]]+)\]\.(?:quaternion|position)$/.exec(track.name);
      const bone = match && mesh.skeleton.getBoneByName(match[1]);
      if (!bone) throw new Error(`3D 动作骨骼不匹配：${track.name}`);
      animated.set(bone.name, bone);
    }
    const action = mixer.clipAction(clip);
    action.setLoop(motion.loop ? THREE.LoopRepeat : THREE.LoopOnce, motion.loop ? Infinity : 1);
    action.clampWhenFinished = !motion.loop;
    return [motion.id, { action, motion }] as const;
  }));
  const idle = entries.get("idle");
  if (!idle) throw new Error("3D 动作缺少待机片段");
  const savedPose = [...animated.values()].map(bone => ({ bone, quaternion: bone.quaternion.clone(), position: bone.position.clone() }));
  let active = idle;
  let trackingWeight = 1;
  let disposed = false;
  idle.action.play();
  function restorePose() { for (const entry of savedPose) { entry.bone.quaternion.copy(entry.quaternion); entry.bone.position.copy(entry.position); } }
  function savePose() { for (const entry of savedPose) { entry.quaternion.copy(entry.bone.quaternion); entry.position.copy(entry.bone.position); } }
  mixer.update(0);
  savePose();
  const player: MmdMotionPlayer = {
    play(id) {
      const next = entries.get(id);
      if (disposed || !next) return false;
      if (next === active && next.motion.loop) return true;
      if (next === active) { next.action.reset().play(); return true; }
      next.action.reset().setEffectiveTimeScale(1).setEffectiveWeight(1).play();
      active.action.crossFadeTo(next.action, 0.3, false);
      active = next;
      return true;
    },
    update(delta) {
      if (disposed) return;
      const elapsed = Number.isFinite(delta) ? THREE.MathUtils.clamp(delta, 0, 0.05) : 0;
      // Restore the animation result before mixing again: head tracking and
      // physics modify the displayed bones and must not feed back into clips.
      restorePose();
      mixer.update(elapsed);
      savePose();
      trackingWeight += ((active === idle ? 1 : 0) - trackingWeight) * (1 - Math.exp(-elapsed / 0.2));
    },
    get trackingWeight() { return trackingWeight; },
    dispose() {
      if (disposed) return;
      disposed = true;
      mixer.removeEventListener("finished", finished);
      mixer.stopAllAction();
      mixer.uncacheRoot(mesh);
    },
  };
  const finished = (event: { action: THREE.AnimationAction }) => {
    if (event.action === active.action && active !== idle) player.play("idle");
  };
  mixer.addEventListener("finished", finished);
  return player;
}
