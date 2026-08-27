import { acquireScrollRestorationMode, type ResourceLease } from "../utils/documentResources";

/** Default history-state slot used to identify which entry a popstate landed on. */
const DEFAULT_STATE_KEY = "__sibuScrollKey";

export interface ScrollRestorationOptions {
  /**
   * `"auto"` (default) manages history-entry identity and restores the
   * destination on `popstate`. It tags the entry the page started on, tags each
   * entry you announce with `onNavigation()`, saves the outgoing position, and
   * takes over `history.scrollRestoration` so the browser does not restore in
   * parallel.
   *
   * What auto mode CANNOT do is notice a `history.pushState` it was not told
   * about — no library can, short of monkey-patching `history` globally. Entries
   * created without `onNavigation()` carry no identity and are simply not
   * restored (a safe no-op, not a wrong position).
   *
   * `"manual"` attaches no listener, claims no native restoration, and tags
   * nothing — you call `save()` / `restore()` yourself.
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
 * A real restore needs to know WHICH entry the user landed on, so auto mode
 * tags history entries with their key (`stateKey`) and the `popstate` handler
 * reads that tag off `event.state`. On each pop it:
 *
 *   1. saves the position of the entry being LEFT (unless it is also the
 *      destination — a same-key pop is not a departure, and saving there would
 *      overwrite the stored position with the current one, destroying exactly
 *      the value about to be restored)
 *   2. restores the destination's saved position, if one exists
 *
 * An unknown or absent destination key is a safe SibuJS no-op: no guessed
 * position is applied. Note this is not a hand-off to the browser — auto mode
 * leases `history.scrollRestoration` to `"manual"` while active, so nothing
 * else is restoring either. The viewport simply stays where the engine left it.
 *
 * WHAT "AUTO" MEANS, EXACTLY
 * --------------------------
 * Reacting to `popstate` automatically is not enough on its own: the handler
 * can only restore an entry that HAS an identity, and originally nothing ever
 * gave one to the entry the page started on. The first Back a user pressed
 * therefore restored nothing. Auto mode now owns identity as well as reaction:
 *
 *   - the INITIAL entry is tagged at construction, and
 *   - `onNavigation(key)` tags each entry the application creates.
 *
 * That second half is an explicit hook rather than magic, and deliberately so:
 * a library cannot observe arbitrary `history.pushState` calls without patching
 * `history` globally, which would surprise every other consumer of it. So the
 * honest contract is:
 *
 *   > Auto mode restores any entry it was given identity for, and never guesses
 *   > about entries it was not told about.
 *
 * Auto mode also leases `history.scrollRestoration = "manual"` while active, so
 * the browser is not restoring the viewport at the same time SibuJS is. The
 * previous value is restored when the last controller is disposed.
 */
export function scrollRestoration(options?: ScrollRestorationOptions): {
  save: (key: string) => void;
  restore: (key: string) => void;
  /**
   * Tell auto mode that the application created a new history entry.
   *
   * Records the outgoing entry's position, tags the new entry with `key`, and
   * makes it current. Call it immediately after your `pushState` (before any
   * scrolling), so the position captured is the one the user is leaving.
   */
  onNavigation: (key: string) => void;
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

  /**
   * Tell auto mode a new history entry was created by the application.
   *
   * SibuJS cannot observe a third party calling `history.pushState` without
   * monkey-patching it globally, which would be a far worse trade than an
   * explicit hook. This is that hook, and it is what keeps the invariant true:
   * every entry auto mode expects to restore carries its identity in
   * `history.state`.
   */
  const onNavigation = (key: string): void => {
    // Auto-mode only. Manual mode's contract is that nothing happens unless the
    // caller asks: no listener, no native claim, no tagging. Doing this work
    // there would rewrite `history.state`, move the internal current key, and
    // record a position the caller never requested. The method stays on the
    // returned object in both modes — removing it would be a pointless API
    // asymmetry — it simply does nothing outside auto.
    if (mode !== "auto") return;

    // The outgoing entry is the one the user is leaving, and at this moment the
    // viewport still shows it — hence "call me right after pushState".
    if (currentKey !== null && currentKey !== key) record(currentKey);
    currentKey = key;
    tagCurrentEntry(key);
  };

  // Auto mode owns the browser's own restoration for as long as it is active.
  // Leaving it on means two independent things move the viewport on the same
  // popstate and the result depends on which lands last. Leased rather than
  // assigned so overlapping controllers cannot hand `"auto"` back while another
  // is still restoring.
  let nativeModeLease: ResourceLease<ScrollRestoration> | null = null;

  // In auto mode, save the outgoing entry and restore the destination
  // (client-only).
  if (mode === "auto" && typeof window !== "undefined") {
    nativeModeLease = acquireScrollRestorationMode("manual");

    // Tag the entry the page STARTED on. Without this the first Back — the one
    // a user is most likely to press — arrives at an entry with no identity,
    // and auto mode has nothing to look the position up by.
    if (currentKey !== null) tagCurrentEntry(currentKey);

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
    nativeModeLease?.release();
    nativeModeLease = null;
    positions.clear();
  };

  return { save, restore, onNavigation, getPosition, dispose };
}
