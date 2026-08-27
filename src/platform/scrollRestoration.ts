/** Default history-state slot used to identify which entry a popstate landed on. */
const DEFAULT_STATE_KEY = "__sibuScrollKey";

export interface ScrollRestorationOptions {
  /**
   * `"auto"` (default) saves the outgoing entry and RESTORES the destination
   * entry on `popstate`. `"manual"` attaches no listener — you call
   * `save()` / `restore()` yourself.
   */
  mode?: "auto" | "manual";
  /**
   * Identifies the entry the user is currently on. Called once at construction
   * to seed the current entry, and consulted as a fallback when nothing has
   * been saved yet.
   *
   * Point it at whatever your app treats as a history identity — e.g.
   * `() => router.location().key`. Pathname alone is usually wrong: `?page=2`
   * and `#section` are distinct scroll positions to a user.
   */
  getKey?: () => string | null;
  /**
   * History-state property used to tag entries so a `popstate` can name its
   * DESTINATION. `popstate` reports the state of the entry being restored, and
   * that is the only reliable way to know where the user just landed.
   */
  stateKey?: string;
}

/**
 * Manages scroll position saving and restoration keyed by route/key.
 *
 * AUTO MODE
 * ---------
 * `"auto"` previously attached a `popstate` listener that only ever called
 * `save()` — so the documented "save/restore on popstate" behaviour was half
 * implemented, and going Back never returned the viewport anywhere. The whole
 * point of the feature was the half that was missing.
 *
 * A real restore needs to know WHICH entry the user landed on, so `save()` in
 * auto mode tags the current history entry with its key (`stateKey`), and the
 * `popstate` handler reads that tag off `event.state`. On each pop it:
 *
 *   1. saves the position of the entry being LEFT (unless it is also the
 *      destination — a same-key pop is not a departure, and saving there would
 *      overwrite the stored position with the current one, destroying exactly
 *      the value about to be restored)
 *   2. restores the destination's saved position, if one exists
 *
 * An unknown or absent destination key is a safe no-op: the browser's own
 * scroll behaviour applies rather than a guessed position.
 */
export function scrollRestoration(options?: ScrollRestorationOptions): {
  save: (key: string) => void;
  restore: (key: string) => void;
  getPosition: (key: string) => { x: number; y: number } | undefined;
  dispose: () => void;
} {
  const mode = options?.mode ?? "auto";
  const stateKey = options?.stateKey ?? DEFAULT_STATE_KEY;
  const positions = new Map<string, { x: number; y: number }>();

  let popstateHandler: ((event: PopStateEvent) => void) | null = null;
  let currentKey: string | null = null;

  if (options?.getKey) {
    try {
      currentKey = options.getKey();
    } catch {
      currentKey = null;
    }
  }

  /** Record a position without touching history state. */
  const record = (key: string): void => {
    if (typeof window !== "undefined") {
      positions.set(key, { x: window.scrollX, y: window.scrollY });
    }
    currentKey = key;
  };

  /**
   * Tag the CURRENT history entry so a later popstate can recognise it as a
   * destination. Merged into the existing state rather than replacing it, so a
   * router's own history state survives.
   */
  const tagCurrentEntry = (key: string): void => {
    if (typeof window === "undefined" || typeof history === "undefined") return;
    try {
      const existing = (history.state ?? {}) as Record<string, unknown>;
      if (existing[stateKey] === key) return;
      history.replaceState({ ...existing, [stateKey]: key }, "");
    } catch {
      // A cross-origin or otherwise restricted history is not a reason to fail
      // a scroll save — the position is still recorded in `positions`.
    }
  };

  const save = (key: string): void => {
    record(key);
    if (mode === "auto") tagCurrentEntry(key);
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

  // In auto mode, save the outgoing entry and restore the destination
  // (client-only).
  if (mode === "auto" && typeof window !== "undefined") {
    popstateHandler = (event: PopStateEvent) => {
      const state = (event.state ?? null) as Record<string, unknown> | null;
      const rawDestination = state ? state[stateKey] : undefined;
      const destination = typeof rawDestination === "string" ? rawDestination : null;

      let outgoing = currentKey;
      if (outgoing === null && options?.getKey) {
        try {
          outgoing = options.getKey();
        } catch {
          outgoing = null;
        }
      }

      // Save where we were — but never when it is the same entry we are about
      // to restore, or the save would clobber the position with the current
      // (pre-restore) scroll offset.
      if (outgoing !== null && outgoing !== destination) {
        record(outgoing);
      }

      if (destination !== null) restore(destination);
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
