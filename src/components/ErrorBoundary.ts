import { normalizeError, reportError } from "../core/errors";
import { dispose, registerDisposer, replaceChildrenSafely } from "../core/rendering/dispose";
import { div, span, style } from "../core/rendering/html";
import { takePendingError } from "../core/rendering/lazy";
import { onMount } from "../core/rendering/lifecycle";
import { effect } from "../core/signals/effect";
import { signal } from "../core/signals/signal";
import { untracked } from "../reactivity/track";
import { ErrorDisplay } from "./ErrorDisplay";

export interface ErrorBoundaryOptions {
  /**
   * Fallback renderer, called with this boundary's Error and its own `retry`.
   *
   * Safe to share one fallback function across many boundaries: the Error and
   * the retry callback always belong to the boundary that invoked it, even when
   * two boundaries fail with identical messages. It is re-invoked whenever the
   * boundary re-renders its error state; do not rely on it running only once.
   */
  fallback?: (error: Error, retry: () => void) => Element;
  /**
   * Called when an error is caught (sync or async).
   */
  onError?: (error: Error) => void;
  /**
   * A list of reactive getters. Whenever any of these values change
   * after an error has been caught, the boundary automatically resets
   * (clears the error and re-renders). Useful for recovering from a
   * failed render after the user navigates, changes filters, or
   * otherwise picks a new input that might not fail this time.
   *
   * @example
   * ```ts
   * const [route, setRoute] = signal("/");
   * ErrorBoundary(
   *   { resetKeys: [route] },
   *   () => div(riskyPageFor(route())),
   * );
   * ```
   */
  resetKeys?: Array<() => unknown>;
}

/** @deprecated Renamed to `ErrorBoundaryOptions`; kept for typing compatibility. */
export type ErrorBoundaryProps = ErrorBoundaryOptions;

// CSS styles for ErrorBoundary
const errorBoundaryStyles = `
  .sibu-error-boundary {
    position: relative;
  }

  .sibu-error-fallback {
    border: 1px solid #e5484d;
    border-radius: 8px;
    padding: 0;
    margin: 10px 0;
    background: #1a1a2e;
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.4);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    color: #e1e1e6;
    overflow: hidden;
  }

  .sibu-error-fallback .sibu-error-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 16px;
    background: #e5484d;
    color: white;
  }

  .sibu-error-fallback .sibu-error-title {
    margin: 0;
    font-size: 0.95em;
    font-weight: 600;
  }

  .sibu-error-fallback .sibu-error-source {
    margin-left: auto;
    font-size: 0.8em;
    opacity: 0.9;
    font-family: 'SF Mono', 'Fira Code', 'Roboto Mono', monospace;
  }

  .sibu-error-fallback .sibu-error-body {
    padding: 16px;
  }

  .sibu-error-fallback .sibu-error-message {
    font-family: 'SF Mono', 'Fira Code', 'Roboto Mono', monospace;
    margin: 0 0 12px 0;
    color: #f1a9a0;
    word-break: break-word;
    font-size: 0.9em;
    line-height: 1.5;
  }

  .sibu-error-fallback .sibu-error-stack-container {
    position: relative;
    margin: 0 0 12px 0;
    border-radius: 6px;
    border: 1px solid #2a2a3e;
    background: #12121f;
    overflow: hidden;
  }

  .sibu-error-fallback .sibu-error-stack-label {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 12px;
    background: #1e1e32;
    border-bottom: 1px solid #2a2a3e;
    font-size: 0.75em;
    color: #888;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .sibu-error-fallback .sibu-error-copy-btn {
    background: transparent;
    border: 1px solid #3a3a4e;
    border-radius: 4px;
    color: #888;
    cursor: pointer;
    padding: 2px 8px;
    font-size: 1em;
    transition: all 0.15s ease;
  }

  .sibu-error-fallback .sibu-error-copy-btn:hover {
    background: #2a2a3e;
    color: #ccc;
    border-color: #4a4a5e;
  }

  .sibu-error-fallback .sibu-error-stack pre {
    margin: 0;
    padding: 12px;
    overflow-x: auto;
    font-family: 'SF Mono', 'Fira Code', 'Roboto Mono', monospace;
    font-size: 0.82em;
    line-height: 1.6;
    color: #a0a0b0;
  }

  .sibu-error-fallback .sibu-error-stack .sibu-line-num {
    display: inline-block;
    width: 3ch;
    margin-right: 12px;
    color: #555;
    text-align: right;
    user-select: none;
  }

  .sibu-error-fallback .sibu-error-stack .sibu-stack-fn {
    color: #7ec8e3;
  }

  .sibu-error-fallback .sibu-error-stack .sibu-stack-loc {
    color: #666;
  }

  .sibu-error-fallback .sibu-error-actions {
    display: flex;
    gap: 8px;
  }

  .sibu-error-fallback .sibu-error-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 18px;
    border: none;
    border-radius: 6px;
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
    transition: all 0.15s ease;
  }

  .sibu-error-fallback .sibu-error-btn-retry {
    background: #e5484d;
    color: white;
  }

  .sibu-error-fallback .sibu-error-btn-retry:hover {
    background: #d13438;
  }

  .sibu-error-fallback .sibu-error-btn-reload {
    background: #2a2a3e;
    color: #ccc;
    border: 1px solid #3a3a4e;
  }

  .sibu-error-fallback .sibu-error-btn-reload:hover {
    background: #3a3a4e;
  }
`;

// Inject styles only once
let stylesInjected = false;
function injectStyles() {
  if (!stylesInjected && typeof document !== "undefined") {
    const styleElement = style({ nodes: errorBoundaryStyles });
    document.head.appendChild(styleElement);
    stylesInjected = true;
  }
}

// ---------------------------------------------------------------------------
// There is deliberately NO fallback cache.
//
// A previous revision memoized fallbacks in a module-global
// `WeakMap<fallbackFn, Map<error.message, factory>>`. That modelled ownership
// wrongly in two ways at once:
//
//   1. The cached factory closed over a SPECIFIC Error and a SPECIFIC
//      boundary's `retry`, but the cache was shared by every boundary using
//      that fallback function. Sharing one `AppErrorFallback` across an app is
//      the idiomatic use, so two sibling boundaries whose errors happened to
//      carry the same message aliased each other: B's fallback was handed A's
//      Error and A's retry callback. `retry()` compounded it by deleting the
//      shared entry by message, wiping the OTHER boundary's state.
//   2. It never actually memoized any rendering. The cached value was a
//      closure that was invoked on every call, so the fallback element was
//      rebuilt each time regardless — the cache bought a skipped closure
//      allocation on an ERROR path, in exchange for a correctness bug.
//
// Elaborating the key (message + stack + name + …) would not have fixed it:
// boundary-specific state simply does not belong in global storage.
// Configuration may be shared; failure state may not.
//
// The boundary's own reactive `error` signal already governs when the fallback
// re-renders, so no additional memoization layer is needed.
// ---------------------------------------------------------------------------

// Stack parsing is now handled by ErrorDisplay. The helper used to
// live here but was removed along with the inline legacy renderer.

/**
 * ErrorBoundary component using SibuJS reactive pattern.
 *
 * Features:
 * - Catches sync errors thrown by children
 * - Catches the rejection of a Promise *returned* by children (async components)
 *   — it does NOT observe fire-and-forget async errors (rejections from timers,
 *   event handlers, or detached/unawaited promises), which surface as global
 *   `unhandledrejection` events instead.
 * - Supports nested ErrorBoundaries (inner catches first, outer catches propagation)
 * - Retry functionality to clear error and re-render children
 * - Fallback state is per-boundary: a shared fallback function never leaks one
 *   boundary's Error or retry callback into another
 * - onError callback for logging/telemetry
 * - Improved CSS styling
 */
export function ErrorBoundary(children: () => Element): Element;
export function ErrorBoundary(options: ErrorBoundaryOptions, children: () => Element): Element;
export function ErrorBoundary(
  optionsOrChildren: ErrorBoundaryOptions | (() => Element),
  maybeChildren?: () => Element,
): Element {
  const children: () => Element =
    typeof optionsOrChildren === "function" ? optionsOrChildren : (maybeChildren as () => Element);
  const options: ErrorBoundaryOptions = typeof optionsOrChildren === "function" ? {} : optionsOrChildren;
  const { fallback, onError, resetKeys } = options;

  injectStyles();

  const [error, setError] = signal<Error | null>(null);

  // Closes over THIS boundary's error signal and nothing else, so a fallback
  // can never be handed another boundary's retry.
  const retry = () => {
    setError(null);
  };

  // Wire `resetKeys` — when any listed getter changes after an error has
  // been caught, clear the error and re-render. Skip the first run so we
  // do not retry before an error has even occurred.
  // Capture the effect teardown so it can be disposed with the boundary.
  let resetKeysTeardown: (() => void) | null = null;
  if (resetKeys && resetKeys.length > 0) {
    let initialized = false;
    resetKeysTeardown = effect(() => {
      // Read every key so each one is tracked as a dependency
      for (const k of resetKeys) {
        try {
          k();
        } catch (err) {
          // A key getter that throws is still a valid dependency — the value is
          // ignored and the effect keeps going. But the getter is APPLICATION
          // code, so its exception goes through the central pipeline rather
          // than a bare console.warn that no handler could ever observe.
          //
          // Deliberately NO node: this failure happens while the boundary is
          // evaluating its own reset conditions, so offering it to this very
          // boundary would let it catch its own internal bookkeeping error —
          // and, once it is showing a fallback, its resetKeys effect is exactly
          // what is meant to get it out again. It resolves to the runtime
          // handler or the console instead.
          reportError(err, { phase: "effect", name: "ErrorBoundary.resetKeys" });
        }
      }
      if (!initialized) {
        initialized = true;
        return;
      }
      // Reset keys are TRIGGERS; the boundary's error is STATE this watcher
      // inspects when a trigger fires. Reading `error()` reactively here would
      // subscribe the watcher to `setError()` — and because the initialization
      // guard above returns early, that subscription was acquired on the first
      // NON-initial run, i.e. the first time a reset key changed. From then on
      // any later, unrelated failure re-ran this watcher, which saw a non-null
      // error and called retry(), clearing the failure it had just been told
      // about. The boundary un-failed itself with no reset key involved.
      //
      //   reset key changed -> maybe retry   (correct)
      //   error changed     -> retry         (wrong)
      if (untracked(error) !== null) retry();
    });
  }

  const handleError = (e: unknown): Error => {
    // Shared normalization: an existing Error passes through by reference
    // (stack/cause/instanceof preserved) and a non-Error throw keeps its
    // original value as `cause` rather than being flattened to a string.
    const errorObj = normalizeError(e);
    setError(errorObj);
    if (onError) {
      try {
        onError(errorObj);
      } catch (cbErr) {
        // The user's own onError callback failed. Route it through the central
        // pipeline instead of only logging, and WITHOUT a node: this boundary
        // is mid-handling and must not be offered its own callback's failure.
        reportError(cbErr, { phase: "render", name: "ErrorBoundary onError callback" });
      }
    }
    return errorObj;
  };

  const defaultFallback = (err: Error, retryFn: () => void): Element => {
    // Delegate to the shared ErrorDisplay component. It handles the
    // dev/prod split, copy-to-clipboard, stack parsing, Error.cause
    // chain, metadata, and action buttons.
    return ErrorDisplay({ error: err, severity: "error", onRetry: retryFn });
  };

  const tryRenderFallback = (err: Error): Element => {
    const fn = fallback || defaultFallback;
    try {
      // `err` and `retry` both belong to THIS boundary instance.
      return fn(err, retry);
    } catch (fallbackError) {
      // The fallback renderer itself failed. This second error must not vanish:
      // route it through the central pipeline so an OUTER boundary can claim it
      // and, failing that, the runtime handler or console still sees it.
      //
      // Dispatching from `container` is safe against self-capture: by now
      // `error()` is set, so this boundary's own listener declines and lets the
      // event bubble past itself rather than re-entering its broken fallback.
      //
      // Deferred by one microtask so `container` is attached to its parent
      // first — bubbling walks parentNode chains, and a boundary mounted above
      // us cannot be found before we are linked to it.
      queueMicrotask(() => {
        reportError(fallbackError, {
          phase: "render",
          name: "ErrorBoundary fallback",
          node: container.parentNode ? container : undefined,
        });
      });
      return document.createComment("error-boundary-failed") as unknown as Element;
    }
  };

  const container = div({
    class: "sibu-error-boundary",
    nodes: () => {
      const currentError = error();

      if (currentError) {
        return tryRenderFallback(currentError);
      }

      try {
        const result = children();

        // Handle async children (Promise-returning components)
        if (result && typeof (result as unknown as Promise<Element>).then === "function") {
          const asyncContainer = div({ class: "sibu-error-async" }) as Element;
          asyncContainer.appendChild(span({ class: "sibu-lazy-loading", nodes: "Loading..." }));

          // An async completion may not mutate a boundary that has already been
          // disposed: the container is detached by then, so anything committed
          // into it is unreachable by any future dispose-walk and leaks.
          let asyncDisposed = false;
          registerDisposer(asyncContainer, () => {
            asyncDisposed = true;
          });

          (result as unknown as Promise<Element>)
            .then((el: Element) => {
              if (asyncDisposed) {
                // The subtree was built before we could bail — dispose it here,
                // since nothing else owns it.
                dispose(el);
                return;
              }
              replaceChildrenSafely(asyncContainer, el);
            })
            .catch((e: unknown) => {
              // Swallowed rather than reported: the boundary that would have
              // shown this error no longer exists. Returning keeps the
              // rejection handled, so it never surfaces as an unhandled one.
              if (asyncDisposed) return;
              const err = handleError(e);
              replaceChildrenSafely(asyncContainer, tryRenderFallback(err));
            });

          return asyncContainer;
        }

        return result;
      } catch (e) {
        const errorObj = handleError(e);
        return tryRenderFallback(errorObj);
      }
    },
  }) as Element;

  // Listen for error propagation from nested ErrorBoundaries.
  // Store the handler so it can be removed via registerDisposer to avoid
  // leaking the listener when the boundary itself is disposed.
  const propagateListener = (e: Event) => {
    // DECLINE, do not claim: a boundary already showing a fallback cannot show
    // another one, so the event must stay un-cancelled and keep bubbling to an
    // outer boundary. Calling preventDefault() before establishing that this
    // boundary can actually handle the error would strand it here.
    if (error()) return;

    const customEvent = e as CustomEvent;
    const propagatedError = customEvent.detail?.error;
    // Nothing to handle — leave the event alone so it is reported normally.
    if (!propagatedError) return;

    // CLAIM. `preventDefault()` is the acknowledgement `reportError()` reads:
    // it means this boundary took responsibility, so the global handler and the
    // console fallback must not also fire. `stopPropagation()` additionally
    // keeps outer boundaries from double-handling the same error.
    e.preventDefault();
    e.stopPropagation();
    handleError(propagatedError);
  };
  container.addEventListener("sibu:error-propagate", propagateListener);

  // After mount, scan descendants for errors that were stashed by lazy()/etc.
  // when their dispatch fired before any parent existed (silent-loss path).
  // Collect every pending error so siblings aren't dropped.
  onMount(() => {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT);
    const collected: Error[] = [];
    // walker.currentNode starts at the container root — include it.
    let node: Node | null = walker.currentNode;
    while (node) {
      const pending = takePendingError(node as Element);
      if (pending) collected.push(pending);
      node = walker.nextNode();
    }
    if (collected.length === 1) {
      handleError(collected[0]);
    } else if (collected.length > 1) {
      const Agg = (globalThis as { AggregateError?: typeof AggregateError }).AggregateError;
      handleError(
        Agg
          ? new Agg(collected, `${collected.length} pre-mount errors caught by ErrorBoundary`)
          : // AggregateError is ES2021 and present in every supported runtime
            // (matches the browserslist targets), so this fallback is defensive.
            /* v8 ignore next */
            new Error(collected.map((e) => e.message).join("; ")),
      );
    }
    return undefined;
  }, container as HTMLElement);

  // Tear down resetKeys effect + remove the propagation listener when the
  // boundary root is disposed (via when/match/each/dispose).
  registerDisposer(container, () => {
    if (resetKeysTeardown) resetKeysTeardown();
    container.removeEventListener("sibu:error-propagate", propagateListener);
  });

  return container;
}
