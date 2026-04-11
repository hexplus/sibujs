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

let lockCount = 0;
let savedOverflow: string | null = null;
let savedPaddingRight: string | null = null;

export function scrollLock(): ScrollLockHandle {
  let owned = false;

  function lock() {
    if (owned) return;
    owned = true;
    lockCount++;
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
    if (lockCount !== 0 || typeof document === "undefined") return;

    const body = document.body;
    body.style.overflow = savedOverflow ?? "";
    body.style.paddingRight = savedPaddingRight ?? "";
    savedOverflow = null;
    savedPaddingRight = null;
  }

  return { lock, unlock };
}
