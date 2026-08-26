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
 * failure observable, with one resolution order for every phase of the runtime:
 *
 *   1. the nearest DOM error boundary, when the failure is anchored to a node
 *   2. the application's configured runtime error handler
 *   3. `console.error` — in production builds too, never gated on dev mode
 *
 * Every `catch` in the runtime that is not re-thrown should route here, so
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
   * an enclosing `ErrorBoundary` gets first refusal via the same
   * `sibu:error-propagate` event the rendering paths already use.
   */
  node?: unknown;
}

export type RuntimeErrorHandler = (error: unknown, context: RuntimeErrorContext) => void;

let runtimeErrorHandler: RuntimeErrorHandler | null = null;

/**
 * Install an application-wide handler for errors the runtime caught and
 * contained. Returns the previously installed handler so callers can restore
 * it (tests, nested frameworks).
 *
 * The handler replaces the default `console.error` reporting. Throwing from
 * inside the handler falls back to the default so a broken reporter cannot
 * itself silence the runtime.
 */
export function setRuntimeErrorHandler(handler: RuntimeErrorHandler | null): RuntimeErrorHandler | null {
  const prev = runtimeErrorHandler;
  runtimeErrorHandler = handler;
  return prev;
}

/** The currently installed runtime error handler, if any. */
export function getRuntimeErrorHandler(): RuntimeErrorHandler | null {
  return runtimeErrorHandler;
}

function describe(context: RuntimeErrorContext): string {
  return context.name ? `${context.phase} "${context.name}"` : context.phase;
}

function defaultReport(error: unknown, context: RuntimeErrorContext): void {
  // Deliberately NOT gated on dev mode. An application exception that the
  // runtime contained still has to reach the developer's console/telemetry in
  // production, otherwise "nothing happened" is indistinguishable from success.
  if (typeof console === "undefined") return;
  // The message goes in the FIRST argument so it survives log collectors that
  // only capture the format string, with the original error passed alongside
  // so the console still renders a stack.
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[SibuJS] Uncaught error during ${describe(context)}: ${message}`, error);
}

/**
 * Report an error the runtime caught and contained.
 *
 * Never throws — callers are inside `catch`/`finally` blocks where a secondary
 * failure would corrupt teardown or abort a drain.
 */
export function reportError(error: unknown, context: RuntimeErrorContext): void {
  // 1. Nearest error boundary. Only possible when the failure is anchored to a
  //    node; the reactive core generally has no node, so this is a no-op there.
  const node = context.node as { dispatchEvent?: (event: Event) => boolean } | undefined;
  if (node && typeof node.dispatchEvent === "function" && typeof CustomEvent !== "undefined") {
    try {
      const errorObj = error instanceof Error ? error : new Error(String(error));
      node.dispatchEvent(new CustomEvent("sibu:error-propagate", { bubbles: true, detail: { error: errorObj } }));
      return;
    } catch {
      // Detached node or a hostile dispatch — fall through to reporting.
    }
  }

  // 2. Application-configured handler.
  if (runtimeErrorHandler) {
    try {
      runtimeErrorHandler(error, context);
      return;
    } catch (handlerError) {
      if (typeof console !== "undefined") {
        const detail = handlerError instanceof Error ? handlerError.message : String(handlerError);
        console.error(`[SibuJS] runtime error handler itself threw: ${detail}`, handlerError);
      }
      // Fall through so the ORIGINAL error is still reported.
    }
  }

  // 3. Default reporting.
  defaultReport(error, context);
}
