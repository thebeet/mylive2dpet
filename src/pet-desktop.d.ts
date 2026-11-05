import type { AvatarSnapshot, AvatarCommand } from "./avatars/types";
export {};

type BubblePayload =
  | { type: "expression"; expression: string }
  | { type: "say"; text: string; expression?: string }
  | { type: "tts"; state: "start" | "end" | "error" }
  | { type: "error"; text: string }
  | { type: "hide" };

declare global {
  interface Window {
    petDesktop?: {
      isElectron: true;
      moveWindow: (dx: number, dy: number) => void;
      forcePaint: () => void;
      captureScreenshot: () => Promise<{
        id: string;
        uri: string;
        size: number;
        mimeType: string;
        capturedAt: string;
        filename: string;
        width: number;
        height: number;
      }>;
      chatNow: () => Promise<{ ok: boolean }>;
      openContextMenu: (pos?: { x?: number; y?: number }) => void;
      getAvatarConfig: () => Promise<AvatarSnapshot>;
      avatarReady: (revision: number) => void;
      onAvatarChanged: (callback: (snapshot: AvatarSnapshot) => void) => () => void;
      onAvatarCommand: (callback: (command: AvatarCommand) => void) => () => void;
      onBubble: (callback: (payload: BubblePayload) => void) => () => void;
      onGlobalPointerMove: (
        callback: (position: { x: number; y: number }) => void,
      ) => () => void;
    };
  }
}
