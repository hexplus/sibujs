/**
 * Central runtime error pipeline.
 *
 * WHY THIS EXISTS
 * ---------------
 * The reactive runtime has to *contain* application exceptions: a subscriber
 * that throws must not abort the notification drain, or one broken component
 * would freeze every unrelated binding on the page. Containment, however, was
 * previously implemented as a bare `catch` that only warned when a dev-mode
 * flag was on — so in a production build an application exception thrown from
 * an effect re-run became literally nothing: no log, no handler, no signal that
 * anything had happened.
 *
 * Containment is not silence. This module keeps the containment and makes the
 * failure observable, with ONE resolution order for every phase of the runtime:
 *
 *   1. the nearest `ErrorBoundary`, but only if it EXPLICITLY claims the error
 *   2. the application's configured runtime error handler
 *   3. `console.error` — in production builds too, never gated on dev mode
 *
 * Every `catch` in the runtime that is not re-thrown routes here, so
 * applications have exactly one place to install reporting/telemetry.
 */

/** The runtime activity that was executing when the error escaped. */
export type RuntimeErrorPhase =
  | "effect"
  | "binding"
  | "derived"
  | "cleanup"
  | "event"
  | "async"
  | "render"
  | "scheduler";

export interface RuntimeErrorContext {
  /** Which part of the runtime was executing. */
  phase: RuntimeErrorPhase;
  /** Debug label of the failing effect/computed/binding, when it has one. */
  name?: string;
  /**
   * DOM node the failure is associated with, when one is known. Given a node,
   * an enclosing `ErrorBoundary` gets first refusal — but only a boundary that
   * explicitly claims the error stops the fallback chain. See `reportError`.
   */
  node?: unknown;
}

export type RuntimeErrorHandler = (error: unknown, context: RuntimeErrorContext) => void;

// ---------------------------------------------------------------------------
// Duplicate-instance-safe state
//
// WHY: bundler dependency pre-bundling routinely materializes SibuJS twice on
// one page. The reactive core already handles that by publishing its
// implementation on a `globalThis` registry so the second copy delegates to the
// first (see ../reactivity/track.ts). The error handler must follow the same
// rule: with module-local state, an application that calls
// `setRuntimeErrorHandler` through copy B would install it on B, while a
// subscriber error contained by the SHARED engine (owned by copy A) would look
// up A's null handler and fall through to the console. The application's
// telemetry would silently never fire.
//
// The `.v1` suffix is the LAYOUT version of this state, matching the sibling
// reactive/batch registries. Two layout-compatible SibuJS 4 copies are
// SUPPOSED to share one application-level handler; bump the suffix only on an
// incompatible change to the shape below, so a future incompatible major does
// not adopt this one's state.
// ---------------------------------------------------------------------------

interface RuntimeErrorState {
  handler: RuntimeErrorHandler | null;
  /**
   * Non-zero while the configured handler is executing. The handler is user
   * code: it may itself write signals and trigger another contained error. A
   * depth counter (reset in `finally`, so nothing is suppressed permanently)
   * bounds that recursion — a nested report skips the handler and goes
   * straight to the console rather than re-entering it forever.
   */
  handlerDepth: number;
}

const ERROR_STATE_KEY = Symbol.for("sibujs.runtime-errors.v1");

// Resolved on every access rather than cached in a module-local. The registry
// entry is the single source of truth, so a copy that loaded earlier must not
// keep pointing at a state object that has since been replaced — otherwise two
// copies silently diverge again, which is the exact failure this registry
// exists to prevent. Every caller here is on a cold path (installing a handler,
// or reporting an error that already happened), so one property lookup costs
// nothing worth optimizing.
function state(): RuntimeErrorState {
  const g = globalThis as typeof globalThis & { [ERROR_STATE_KEY]?: RuntimeErrorState };
  const existing = g[ERROR_STATE_KEY];
  if (existing) return existing;
  const created: RuntimeErrorState = { handler: null, handlerDepth: 0 };
  g[ERROR_STATE_KEY] = created;
  return created;
}

/**
 * Install an application-wide handler for errors the runtime caught and
 * contained. Returns the previously installed handler so callers can restore
 * it (tests, nested frameworks). Pass `null` to clear.
 *
 * The handler replaces the default `console.error` reporting. Throwing from
 * inside the handler falls back to the default, so a broken reporter cannot
 * itself silence the runtime.
 *
 * This is application/runtime-global state, NOT request-scoped: under SSR it is
 * shared by every concurrent request in the process. Install it once at startup
 * and derive any request-specific detail from the error/context instead.
 */
export function setRuntimeErrorHandler(handler: RuntimeErrorHandler | null): RuntimeErrorHandler | null {
  const s = state();
  const prev = s.handler;
  s.handler = handler;
  return prev;
}

/** The currently installed runtime error handler, if any. */
export function getRuntimeErrorHandler(): RuntimeErrorHandler | null {
  return state().handler;
}

/**
 * Normalize a thrown value to an `Error` WITHOUT disturbing one that already is.
 *
 * An existing `Error` is returned by reference: wrapping it would break `stack`,
 * `cause`, custom properties, `instanceof` checks and telemetry identity. Only a
 * non-Error throw (`throw "boom"`, `throw 42`, `throw null`) is wrapped, with
 * the original preserved as `cause` so nothing is lost.
 */
export function normalizeError(value: unknown): Error {
  if (value instanceof Error) return value;
  const message = typeof value === "string" ? value : `Non-Error value thrown: ${safeStringify(value)}`;
  return new Error(message, { cause: value });
}

function safeStringify(value: unknown): string {
  if (typeof value === "symbol") return value.toString();
  try {
    return typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
  } catch {
    // Circular or hostile `toJSON`/`toString` — the type is still useful.
    return Object.prototype.toString.call(value);
  }
}

function describe(context: RuntimeErrorContext): string {
  return context.name ? `${context.phase} "${context.name}"` : context.phase;
}

// ---------------------------------------------------------------------------
// Reporting must not run inside a tracking context.
//
// A report is frequently raised from INSIDE a subscriber's tracking run (a
// binding whose getter threw is still within its own `retrack`). Everything the
// report then invokes — an ErrorBoundary's listener, the application's handler —
// is ordinary code that may READ signals. Without suspension those reads are
// attributed to the failing subscriber, which silently subscribes it to signals
// it never asked for.
//
// That is not theoretical: `ErrorBoundary`'s listener calls `error()` to decide
// whether it can still handle an error. Attributed to the throwing binding, the
// binding became a subscriber of the boundary's own error signal, so setting
// that signal re-ran the binding, which threw again and reported a SECOND time —
// the first claimed by the boundary, the second falling through to the global
// handler. Suspending here makes a report observation-only.
//
// The reactive core publishes `untracked` on the shared registry (see
// ../reactivity/track.ts). Reading it from there rather than importing keeps
// this module free of an import cycle with the core that calls into it, and
// degrades to a plain call if the core is not loaded.
// ---------------------------------------------------------------------------
const REACTIVE_REGISTRY_KEY = Symbol.for("sibujs.reactive.v1");

function untrackedRun<T>(fn: () => T): T {
  const api = (globalThis as typeof globalThis & { [REACTIVE_REGISTRY_KEY]?: { untracked?: <R>(f: () => R) => R } })[
    REACTIVE_REGISTRY_KEY
  ];
  return api?.untracked ? api.untracked(fn) : fn();
}

/**
 * The event an `ErrorBoundary` listens for.
 *
 * INTERNAL: this event is an implementation detail of boundary routing, not a
 * supported public extension point. Applications should use `ErrorBoundary` or
 * `setRuntimeErrorHandler`; the event's name and detail may change.
 */
const PROPAGATE_EVENT = "sibu:error-propagate";

/**
 * Give the nearest enclosing `ErrorBoundary` a chance to claim this error.
 *
 * Returns true ONLY when a boundary explicitly claimed it.
 *
 * dispatchEvent() returning false — i.e. a listener called preventDefault() —
 * is the acknowledgement that a SibuJS ErrorBoundary accepted responsibility.
 * Merely bubbling an event through a DOM tree does NOT make an error handled:
 * treating dispatch itself as success meant that any error carrying a node
 * vanished whenever no boundary was mounted above it, which is precisely the
 * silent-failure mode this module exists to remove.
 */
function claimedByBoundary(error: Error, context: RuntimeErrorContext): boolean {
  const raw = context.node as Node | null | undefined;
  if (!raw || typeof CustomEvent === "undefined") return false;

  // Text/Comment anchors are legal event targets, but boundary listeners are
  // installed on Elements; retargeting to the nearest Element parent keeps
  // bubbling behaviour uniform across the anchor-based primitives.
  const target = resolveEventTarget(raw);
  if (!target) return false;

  try {
    const event = new CustomEvent(PROPAGATE_EVENT, {
      bubbles: true,
      cancelable: true,
      detail: { error, context },
    });
    // `false` means preventDefault() was called => a boundary claimed it.
    return target.dispatchEvent(event) === false;
  } catch {
    // Detached or hostile node — treat as unclaimed so reporting continues.
    return false;
  }
}

function resolveEventTarget(node: Node): (Node & { dispatchEvent(event: Event): boolean }) | null {
  const ELEMENT_NODE = 1;
  let current: Node | null = node;
  while (current) {
    if (current.nodeType === ELEMENT_NODE && typeof (current as Element).dispatchEvent === "function") {
      return current as Element;
    }
    current = current.parentNode;
  }
  // No Element ancestor: fall back to the original node if it can dispatch at
  // all (a detached Comment still lets a directly-attached listener see it).
  const self = node as Node & { dispatchEvent?: (event: Event) => boolean };
  return typeof self.dispatchEvent === "function" ? (self as Node & { dispatchEvent(event: Event): boolean }) : null;
}

function defaultReport(error: Error, context: RuntimeErrorContext): void {
  // Deliberately NOT gated on dev mode. An application exception that the
  // runtime contained still has to reach the developer's console/telemetry in
  // production, otherwise "nothing happened" is indistinguishable from success.
  if (typeof console === "undefined") return;
  // The message goes in the FIRST argument so it survives log collectors that
  // only capture the format string; the Error object is passed alongside so
  // DevTools keeps the stack and lets the value be inspected.
  console.error(`[SibuJS] Uncaught error during ${describe(context)}: ${error.message}`, error);
}

/**
 * Report an error the runtime caught and contained.
 *
 * Resolution order: nearest claiming `ErrorBoundary` → configured runtime
 * handler → `console.error`. Exactly one of those runs for a given report.
 *
 * Never throws — callers are inside `catch`/`finally` blocks where a secondary
 * failure would corrupt teardown or abort a drain.
 *
 * @public Framework primitive, also usable by plugin/integration code that
 * catches an application exception on SibuJS's behalf (custom rendering
 * primitives, adapters) and wants it to follow the same boundary/handler
 * resolution as a built-in one. Ordinary application code should prefer
 * `ErrorBoundary` or `setRuntimeErrorHandler`.
 */
export function reportError(error: unknown, context: RuntimeErrorContext): void {
  const err = normalizeError(error);

  untrackedRun(() => {
    // 1. Nearest error boundary — only when it explicitly claims the error.
    if (claimedByBoundary(err, context)) return;

    // 2. Application-configured handler. Skipped when we are already inside it,
    //    which bounds handler-triggered recursion without ever latching off.
    const s = state();
    const handler = s.handler;
    if (handler && s.handlerDepth === 0) {
      s.handlerDepth++;
      try {
        // The handler receives the ORIGINAL error object for anything that was
        // already an Error, so stack/cause/instanceof survive the trip.
        handler(error instanceof Error ? error : err, context);
        return;
      } catch (handlerError) {
        if (typeof console !== "undefined") {
          const detail = handlerError instanceof Error ? handlerError.message : String(handlerError);
          console.error(`[SibuJS] runtime error handler itself threw: ${detail}`, handlerError);
        }
        // Fall through so the ORIGINAL error is still reported.
      } finally {
        s.handlerDepth--;
      }
    }

    // 3. Default reporting.
    defaultReport(err, context);
  });
}
