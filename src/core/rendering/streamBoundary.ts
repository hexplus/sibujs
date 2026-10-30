/**
 * Suspense boundaries of a streaming server render.
 *
 * `renderToReadableStream(() => App())` (in `sibujs/ssr`) flushes the page
 * shell as soon as everything OUTSIDE the `Suspense` boundaries has settled,
 * then streams each boundary's content when that boundary is ready. To know
 * which pending work belongs to which boundary, a boundary's content is built
 * inside its context: work registered while it is current (`trackPending`) is
 * attributed to it, and a `lazy()` created inside it renders its chunk inside
 * it too.
 *
 * The core only carries this slot; the streaming renderer installs the hook.
 */

/** A boundary as the streaming renderer sees it. */
export interface StreamBoundary {
  /** Run `fn` with this boundary current. */
  enter<T>(fn: () => T): T;
  /** The boundary's content is in place. */
  done(): void;
}

type BoundaryHook = (container: Element) => StreamBoundary | null;

const slot = ((globalThis as Record<symbol, { hook: BoundaryHook | null; current: StreamBoundary | null } | undefined>)[
  Symbol.for("sibujs.streamBoundary.v1")
] ??= { hook: null, current: null });

/** Register a `Suspense` container with the streaming render in progress, if any. */
export function openBoundary(container: Element): StreamBoundary | null {
  return slot.hook ? slot.hook(container) : null;
}

/** The boundary whose content is being built right now, if any. */
export function currentBoundary(): StreamBoundary | null {
  return slot.current;
}

/** Run `fn` with `boundary` current (the streaming renderer's `enter`). @internal */
export function runInBoundary<T>(boundary: StreamBoundary | null, fn: () => T): T {
  const prev = slot.current;
  slot.current = boundary;
  try {
    return fn();
  } finally {
    slot.current = prev;
  }
}

/** Install the streaming renderer's hook. @internal */
export function setBoundaryHook(hook: BoundaryHook | null): void {
  slot.hook = hook;
}
