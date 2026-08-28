import { reportError } from "../core/errors";
import { signal } from "../core/signals/signal";

interface WakeLockSentinel extends EventTarget {
  released: boolean;
  type: "screen";
  release(): Promise<void>;
}

interface WakeLockApi {
  request(type: "screen"): Promise<WakeLockSentinel>;
}

/**
 * wakeLock wraps the Screen Wake Lock API to keep the screen awake while the
 * app is doing something the user is watching (video, timer, recipe, nav).
 *
 * Returns a reactive `active` boolean plus `request` / `release` / `dispose`.
 * The lock is automatically re-requested if the page becomes visible again
 * after being hidden (browsers auto-release wake locks on tab hide).
 *
 * Gracefully degrades on browsers without the API.
 *
 * OWNERSHIP MODEL
 * ---------------
 * A wake lock is a native handle, and the previous implementation kept exactly
 * one mutable reference to it with no notion of which request that reference
 * belonged to. Three things followed, all of them reproducible:
 *
 *   - two overlapping `request()` calls acquired two sentinels; the second to
 *     arrive overwrote the first, and `release()` then released only the
 *     survivor. The other sentinel stayed held by the platform with no reference
 *     left to release it — a leaked native handle.
 *   - `release()` set the reference to null but did nothing about a request
 *     still in flight, so a sentinel arriving afterwards installed itself and
 *     the screen stayed awake after the caller had explicitly asked it not to.
 *   - the `release` listener called `setActive(false)` unconditionally, so an
 *     *old* sentinel being released by the platform cleared the state belonging
 *     to the current one.
 *
 * The model is therefore explicit:
 *
 *   - `desire` is whether the controller currently wants a lock at all.
 *   - `generation` is bumped by `request()`, `release()` and `dispose()`. A
 *     completing request compares generations and, if it has lost ownership,
 *     releases the sentinel it was handed immediately rather than storing it.
 *     That is what makes a leak structurally impossible: every sentinel this
 *     module ever receives is either the current one or released on arrival.
 *   - concurrent `request()` calls share one in-flight acquisition, so the API
 *     is never asked for two sentinels at once, and `request()` while an
 *     unreleased sentinel is held is a no-op.
 *   - `active()` is true exactly when a current, unreleased sentinel is held.
 *   - `release()` and `dispose()` revoke the desire *before* awaiting anything,
 *     so a request already in flight is superseded rather than raced.
 *   - `dispose()` is idempotent and publishes `active(false)` exactly once, as
 *     its final act; nothing is published afterwards.
 *
 * @example
 * ```ts
 * const lock = wakeLock();
 * await lock.request();
 * // ... later
 * await lock.release();
 * ```
 */
export function wakeLock(): {
  active: () => boolean;
  request: () => Promise<void>;
  release: () => Promise<void>;
  dispose: () => void;
} {
  const [active, setActive] = signal(false);

  if (typeof navigator === "undefined" || !("wakeLock" in navigator) || typeof document === "undefined") {
    return {
      active,
      request: async () => {},
      release: async () => {},
      dispose: () => {},
    };
  }

  const api = (navigator as unknown as { wakeLock: WakeLockApi }).wakeLock;

  /** The sentinel this controller currently owns, if any. */
  let current: WakeLockSentinel | null = null;
  /** Does the controller want to be holding a lock right now? */
  let desire = false;
  /** Bumped by every request/release/dispose. Identifies the owning attempt. */
  let generation = 0;
  /** The acquisition in flight, so concurrent requests share one native call. */
  let inflight: Promise<void> | null = null;
  let disposed = false;

  /** Publish reactive state. Silent after disposal — see `dispose`. */
  function publishActive(value: boolean): void {
    if (disposed) return;
    setActive(value);
  }

  /**
   * Drop `current` if it is no longer live.
   *
   * The `release` event is the normal signal, but it is not the only one: a
   * sentinel can report `released === true` without this controller having seen
   * an event — a missed dispatch, or a platform that only flips the flag.
   * Relying solely on the event left `current` pointing at a dead sentinel, and
   * because re-acquisition is gated on "do we already hold one", the lock would
   * then never come back after a tab switch. `released` is the authority;
   * the event is just the fast path to noticing.
   */
  function syncReleasedState(): void {
    if (current?.released) {
      current = null;
      publishActive(false);
    }
  }

  /** Release a sentinel we are not going to keep. Never rejects. */
  function discard(sentinel: WakeLockSentinel): void {
    if (sentinel.released) return;
    sentinel.release().catch((err) => {
      reportError(err, { phase: "async", name: "wakeLock(discard)" });
    });
  }

  async function request(): Promise<void> {
    if (disposed) return;
    desire = true;
    syncReleasedState();

    // Already holding a live lock — idempotent.
    if (current && !current.released) {
      publishActive(true);
      return;
    }
    // An acquisition is already running; share it rather than asking the
    // platform for a second sentinel we would then have to release.
    if (inflight) return inflight;

    const myGeneration = ++generation;
    const attempt = (async () => {
      try {
        const sentinel = await api.request("screen");

        // Ownership check AFTER the await. Any of dispose(), release() or a
        // newer request() may have run while we were suspended; in every one of
        // those cases this sentinel is not ours to keep, and holding it without
        // a reference is exactly the leak this guard exists to prevent.
        if (disposed || !desire || generation !== myGeneration) {
          discard(sentinel);
          return;
        }

        current = sentinel;
        sentinel.addEventListener("release", () => {
          // Only the CURRENT sentinel may clear the state. A stale sentinel
          // being released by the platform says nothing about the live one.
          if (current !== sentinel) return;
          current = null;
          publishActive(false);
        });
        publishActive(true);
      } catch (err) {
        // A failed acquisition leaves consistent state: nothing held, not
        // active. The desire stays, so a later visibility change may retry.
        if (generation === myGeneration) publishActive(false);
        reportError(err, { phase: "async", name: "wakeLock(request)" });
      }
    })();

    inflight = attempt;
    // Clear the slot when this attempt finishes, but only if it is still the
    // one installed — release()/dispose() may have replaced or cleared it.
    // `attempt` contains its own errors, so this derived promise cannot reject.
    void attempt
      .finally(() => {
        if (inflight === attempt) inflight = null;
      })
      // `attempt` contains its own errors, so this is belt-and-braces: nothing
      // observes this derived promise, and an unobserved rejection here would be
      // reported as an unhandled one.
      .catch(() => {});
    return attempt;
  }

  async function release(): Promise<void> {
    // Revoke the desire BEFORE awaiting anything, so an acquisition already in
    // flight is superseded and will discard its sentinel on arrival rather than
    // re-activating a lock the caller has just given up.
    desire = false;
    generation++;
    // Drop the shared acquisition too. Without this, a later request() would
    // adopt an attempt that has already lost ownership and will discard its
    // sentinel on arrival — so request() → release() → request() would leave the
    // caller with no lock at all. The superseded attempt still discards its own
    // sentinel, so starting fresh work here cannot leak one.
    inflight = null;

    const held = current;
    current = null;
    publishActive(false);

    if (held && !held.released) {
      await held.release();
    }
  }

  // Re-acquire on visibility return (browsers auto-release when hidden).
  const onVisibility = () => {
    // Only when the controller still WANTS a lock and does not hold a live one.
    // Reading `desire` is what stops an explicit release() from being undone by
    // the user switching tabs.
    syncReleasedState();
    if (!desire || current || document.hidden) return;
    // `request()` contains its own errors and never rejects; the handler is
    // defensive.
    /* v8 ignore next 3 */
    request().catch((err) => {
      reportError(err, { phase: "async", name: "wakeLock(visibility re-acquire)" });
    });
  };
  document.addEventListener("visibilitychange", onVisibility);

  function dispose(): void {
    if (disposed) return;

    desire = false;
    generation++;
    inflight = null;
    document.removeEventListener("visibilitychange", onVisibility);

    const held = current;
    current = null;
    // The final publication, made while still permitted. `disposed` is set
    // immediately afterwards so nothing — including a request still in flight —
    // can publish again.
    setActive(false);
    disposed = true;

    if (held && !held.released) {
      held.release().catch((err) => {
        reportError(err, { phase: "async", name: "wakeLock(dispose release)" });
      });
    }
  }

  return { active, request, release, dispose };
}
