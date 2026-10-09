export {};

type BubblePayload =
  | { type: "thinking" }
  | { type: "expression"; expression: string }
  | { type: "stream"; text: string; expression?: string }
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
        path: string;
        filename: string;
        width: number;
        height: number;
      }>;
      chatNow: () => Promise<{ ok: boolean }>;
      openContextMenu: (pos?: { x?: number; y?: number }) => void;
      onBubble: (callback: (payload: BubblePayload) => void) => () => void;
    };
  }
}
