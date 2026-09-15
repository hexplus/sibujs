/**
 * scrollLock stacks body scroll locks — useful when a modal / drawer / sheet
 * stack is open and background scroll must be suppressed.
 *
 * Each `lock()` call increments an internal counter and applies
 * `overflow: hidden` + preserves the scrollbar-width padding to prevent
 * layout shift. Calling `unlock()` decrements; when the counter hits zero
 * the previous body style is restored.
 *
 * Safe to call from multiple concurrent overlays — the last one to unlock
 * releases the lock.
 *
 * @example
 * ```ts
 * const lock = scrollLock();
 * lock.lock();
 * // ... modal open
 * lock.unlock();
 * ```
 */
import { globalSingleton } from "../utils/globalSingleton";

export interface ScrollLockHandle {
  /** Activate a lock. Idempotent per-handle if called twice. */
  lock: () => void;
  /** Release this handle's lock. Idempotent. */
  unlock: () => void;
}

// Module-level counter + snapshot. The snapshot is taken EXACTLY ONCE on the
// 0 → 1 transition and restored on the N → 0 transition; nested locks never
// re-snapshot. Concurrent lock()/unlock() from multiple handles is safe as
// long as each handle obeys its own `owned` flag (enforced below).
//
// Note: we do NOT observe external mutations to `document.body.style` while
// the lock is active — if application code assigns `body.style.overflow`
// during a lock, that value will be clobbered on unlock. Keep modal state
// in scrollLock handles, not direct style writes.
// Shared via globalSingleton so a duplicated copy of this module doesn't keep
// its own counter/snapshot — otherwise one copy's N→0 unlock would restore
// `overflow` while another copy still holds an open lock.
const _lock = globalSingleton(Symbol.for("sibujs.scrollLock.v1"), () => ({
  count: 0,
  savedOverflow: null as string | null,
  savedPaddingRight: null as string | null,
}));

/**
 * Snapshot the body styles and apply the lock, all-or-nothing: if anything
 * throws, whatever was already written is restored and the error propagates.
 */
function applyBodyLock(): void {
  const body = document.body;
  if (!body) throw new Error("[scrollLock] document.body is not available yet");
  const scrollBarWidth = window.innerWidth - document.documentElement.clientWidth;
  const savedOverflow = body.style.overflow;
  const savedPaddingRight = body.style.paddingRight;
  try {
    body.style.overflow = "hidden";
    if (scrollBarWidth > 0) {
      body.style.paddingRight = `${scrollBarWidth}px`;
    }
  } catch (err) {
    try {
      body.style.overflow = savedOverflow;
      body.style.paddingRight = savedPaddingRight;
    } catch {
      // Best effort: the original failure is the one worth reporting.
    }
    throw err;
  }
  _lock.savedOverflow = savedOverflow;
  _lock.savedPaddingRight = savedPaddingRight;
}

/**
 * Acquire a reference-counted lock on document scrolling, so nested overlays
 * can each lock and unlock without one release re-enabling scroll for all.
 *
 * @returns A handle with `lock`, `unlock` and `isLocked`.
 */
export function scrollLock(): ScrollLockHandle {
  let owned = false;

  function lock() {
    if (owned) return;
    // Only the 0 → 1 transition snapshots and mutates the body; nested locks
    // increment the counter and otherwise no-op.
    //
    // The DOM work happens BEFORE ownership and the shared count are committed.
    // Committing first meant a lock that threw (no body yet, a failing style
    // write) left the count at 1 with no handle able to release it, so every
    // later lock skipped the body and scrolling was never locked again.
    if (_lock.count === 0 && typeof document !== "undefined") {
      applyBodyLock();
    }
    owned = true;
    _lock.count++;
  }

  function unlock() {
    if (!owned) return;
    owned = false;
    _lock.count = Math.max(0, _lock.count - 1);
    // Only the N → 0 transition restores the snapshot.
    if (_lock.count !== 0 || typeof document === "undefined") return;

    const body = document.body;
    body.style.overflow = _lock.savedOverflow ?? "";
    body.style.paddingRight = _lock.savedPaddingRight ?? "";
    _lock.savedOverflow = null;
    _lock.savedPaddingRight = null;
  }

  return { lock, unlock };
}
