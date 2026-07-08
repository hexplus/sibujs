export interface ScrollRestorationOptions {
  mode?: "auto" | "manual";
}

/**
 * Manages scroll position saving and restoration keyed by route/key.
 * Uses a Map to store positions and window.scrollTo to restore them.
 */
export function scrollRestoration(options?: ScrollRestorationOptions): {
  save: (key: string) => void;
  restore: (key: string) => void;
  getPosition: (key: string) => { x: number; y: number } | undefined;
  dispose: () => void;
} {
  const mode = options?.mode ?? "auto";
  const positions = new Map<string, { x: number; y: number }>();

  let popstateHandler: (() => void) | null = null;
  let currentKey: string | null = null;

  const save = (key: string): void => {
    if (typeof window !== "undefined") {
      positions.set(key, { x: window.scrollX, y: window.scrollY });
    }
    currentKey = key;
  };

  const restore = (key: string): void => {
    const pos = positions.get(key);
    if (pos && typeof window !== "undefined") {
      window.scrollTo(pos.x, pos.y);
    }
    currentKey = key;
  };

  const getPosition = (key: string): { x: number; y: number } | undefined => {
    return positions.get(key);
  };

  // In auto mode, save/restore on popstate events (client-only).
  if (mode === "auto" && typeof window !== "undefined") {
    popstateHandler = () => {
      if (currentKey) {
        save(currentKey);
      }
    };
    window.addEventListener("popstate", popstateHandler);
  }

  const dispose = (): void => {
    if (popstateHandler) {
      window.removeEventListener("popstate", popstateHandler);
      popstateHandler = null;
    }
    positions.clear();
  };

  return { save, restore, getPosition, dispose };
}
