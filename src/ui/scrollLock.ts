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
let lockCount = 0;
let savedOverflow: string | null = null;
let savedPaddingRight: string | null = null;

export function scrollLock(): ScrollLockHandle {
  let owned = false;

  function lock() {
    if (owned) return;
    owned = true;
    lockCount++;
    // Only the 0 → 1 transition snapshots and mutates the body; nested locks
    // increment the counter and otherwise no-op.
    if (lockCount !== 1 || typeof document === "undefined") return;

    const body = document.body;
    const scrollBarWidth = window.innerWidth - document.documentElement.clientWidth;
    savedOverflow = body.style.overflow;
    savedPaddingRight = body.style.paddingRight;
    body.style.overflow = "hidden";
    if (scrollBarWidth > 0) {
      body.style.paddingRight = `${scrollBarWidth}px`;
    }
  }

  function unlock() {
    if (!owned) return;
    owned = false;
    lockCount = Math.max(0, lockCount - 1);
    // Only the N → 0 transition restores the snapshot.
    if (lockCount !== 0 || typeof document === "undefined") return;

    const body = document.body;
    body.style.overflow = savedOverflow ?? "";
    body.style.paddingRight = savedPaddingRight ?? "";
    savedOverflow = null;
    savedPaddingRight = null;
  }

  return { lock, unlock };
}
