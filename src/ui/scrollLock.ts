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

export function scrollLock(): ScrollLockHandle {
  let owned = false;

  function lock() {
    if (owned) return;
    owned = true;
    _lock.count++;
    // Only the 0 → 1 transition snapshots and mutates the body; nested locks
    // increment the counter and otherwise no-op.
    if (_lock.count !== 1 || typeof document === "undefined") return;

    const body = document.body;
    const scrollBarWidth = window.innerWidth - document.documentElement.clientWidth;
    _lock.savedOverflow = body.style.overflow;
    _lock.savedPaddingRight = body.style.paddingRight;
    body.style.overflow = "hidden";
    if (scrollBarWidth > 0) {
      body.style.paddingRight = `${scrollBarWidth}px`;
    }
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
