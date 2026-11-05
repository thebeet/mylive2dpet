import type { HeadAnchor } from "../speechBubble";

export type Motion = { id: string; label: string; group?: string; index?: number; url?: string; loop?: boolean };
export type MotionReference = { group: string; index: number };
export type AvatarDescriptor = {
  plugin: string;
  renderer: "live2d" | "mmd";
  modelUrl: string;
  scale: number;
  verticalOffset: number;
  expressions: string[];
  motions: Motion[];
  controls?: "resetRotation"[];
  defaultExpression?: string;
  idleMotion?: MotionReference | null;
  clickMotion?: MotionReference | null;
  rotationY?: number;
  physicsEnabled?: boolean;
  expressionMorphs?: Record<string, Record<string, number>>;
};
export type AvatarSnapshot = { revision: number; avatar: AvatarDescriptor | null };
export type AvatarCommand = { revision: number; type: "expression" | "motion" | "control"; id: string };
export interface AvatarRenderer {
  setExpression(name: string): void;
  playMotion(id: string): void;
  focus(position: { x: number; y: number }): void;
  getHeadAnchor(): HeadAnchor | null;
  resize(): void;
  hitTest(position: { x: number; y: number }): boolean;
  /** Optional model rotation, in CSS pixel deltas. */
  rotate?(deltaX: number, deltaY: number): void;
  resetRotation?(): void;
  onTap(): void;
  dispose(): void;
}
export type RendererContext = {
  mount: HTMLElement;
  descriptor: AvatarDescriptor;
  signal: AbortSignal;
};
