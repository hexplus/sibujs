import { signal } from "../core/signals/signal";
import { track } from "./track";

// ============================================================================
// CONCURRENT PRIMITIVES
// ============================================================================
//
// Two primitives that keep the UI responsive under heavy updates:
//
//   1. A derived value that is expensive to compute should be able to lag
//      behind its source so the source's own dependents (the input the
//      user is typing into) re-render first.
//   2. A batched mutation should be able to yield to the browser between
//      its reactive effects when it would otherwise block the main thread.
//
// Fine-grained reactivity already avoids the need for an interruptible
// reconciler — each updated signal touches only its dependents, so there
// is no giant tree diff to tear down. These primitives exist purely to
// defer WHEN the trigger fires, not to interrupt work already in flight.
//
// `defer()` solves #1 by wrapping a getter into a deferred mirror signal
// that only updates on a microtask + rAF tick. `transition()` solves #2
// by scheduling the body on the next idle callback (or rAF fallback).
//
// Both primitives are pure JS — no compiler, no VDOM, zero dependencies.
// They rely only on existing `signal()` and `track()` APIs.

/**
 * Create a deferred mirror of a reactive getter. The returned accessor
 * eventually converges to the source value, but updates on a microtask
 * + `requestAnimationFrame` pair — so if the source changes repeatedly
 * in the same frame, only the latest value is ever surfaced.
 *
 * Use this for expensive derived views (filtered lists, rich charts)
 * that should not block fast state changes (typing, cursor movement).
 *
 * @example
 * ```ts
 * const [query, setQuery] = signal("");
 * const deferredQuery = defer(query);
 *
 * // input stays instant — it reads query()
 * input({ on: { input: e => setQuery(e.target.value) } });
 *
 * // heavy list reads deferredQuery() and updates one frame later
 * each(() => heavyFilter(items, deferredQuery()), row => li(row.name));
 * ```
 */
export function defer<T>(getter: () => T): (() => T) & { dispose: () => void } {
  const [value, setValue] = signal<T>(getter());
  let pending = false;
  let disposed = false;
  let latest: T = value();

  const flush = () => {
    pending = false;
    if (disposed) return;
    setValue(latest);
  };

  const schedule = () => {
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      if (typeof requestAnimationFrame === "function") {
        requestAnimationFrame(flush);
      } else {
        flush();
      }
    });
  };

  const teardown = track(() => {
    latest = getter();
    schedule();
  });

  const accessor = (() => value()) as (() => T) & { dispose: () => void };
  accessor.dispose = () => {
    if (disposed) return;
    disposed = true;
    teardown();
  };
  return accessor;
}

// ─── transition() ──────────────────────────────────────────────────────────

interface TransitionState {
  pending: () => boolean;
  start: (fn: () => void | Promise<void>) => void;
}

const IDLE_FALLBACK_MS = 16;

function scheduleIdle(fn: () => void): void {
  const g = globalThis as unknown as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number;
  };
  if (typeof g.requestIdleCallback === "function") {
    g.requestIdleCallback(fn, { timeout: IDLE_FALLBACK_MS * 4 });
    return;
  }
  // Fallback: run on next frame
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => fn());
    return;
  }
  setTimeout(fn, IDLE_FALLBACK_MS);
}

/**
 * Create a transition handle. `start(fn)` runs `fn` on the next idle
 * callback so expensive reactive updates do not block immediate input
 * events. `pending()` is a reactive boolean that is `true` while a
 * transition is in flight.
 *
 * There is no "interruption" — the runtime has no concept of partial
 * renders. The transition is cooperative: its body runs when the browser
 * reports spare time via `requestIdleCallback`. That is sufficient for
 * the 90% case (defer a heavy update so a click handler can finish first)
 * and avoids the complexity of an interruptible reconciler.
 *
 * Async callbacks are supported: `pending()` stays `true` until the
 * returned promise resolves OR rejects.
 *
 * @example
 * ```ts
 * const t = transition();
 * button({
 *   disabled: t.pending,
 *   on: { click: () => t.start(() => setFilter(nextFilter)) },
 * });
 * ```
 */
export function transition(): TransitionState {
  const [pending, setPending] = signal(false);

  function start(fn: () => void | Promise<void>): void {
    setPending(true);
    scheduleIdle(() => {
      let result: void | Promise<void>;
      try {
        result = fn();
      } catch {
        setPending(false);
        return;
      }
      if (result && typeof (result as Promise<void>).then === "function") {
        (result as Promise<void>).then(
          () => setPending(false),
          () => setPending(false),
        );
      } else {
        setPending(false);
      }
    });
  }

  return { pending, start };
}
