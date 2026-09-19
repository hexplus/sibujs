import { reportError } from "../errors";

/**
 * Run a directive's first render, deferred because its anchor had no parent
 * yet. Called from a microtask, so a throwing condition or factory has no caller
 * to reach: it used to escape as an uncaught exception, bypassing the error
 * pipeline and any ErrorBoundary. It is reported with the anchor as its node, as
 * a failure on a scheduled run is.
 *
 * Lives in its own module so the public barrel, which re-exports the directive
 * modules wholesale, does not publish it.
 *
 * @internal
 */
export function deferredFirstRender(pending: () => boolean, update: () => void, anchor: Comment, name: string): void {
  if (!pending() || !anchor.parentNode) return;
  try {
    update();
  } catch (err) {
    reportError(err, { phase: "binding", name, node: anchor });
  }
}
