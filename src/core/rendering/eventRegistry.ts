/**
 * Development-only record of the event types the framework attached to each
 * element (`on: { click }` in tag factories, `on:click` in `html`). Listeners
 * added with `addEventListener` leave no trace in the DOM, so tooling such as
 * `checkKeyboardAccess` could not see framework handlers at all.
 *
 * The writers inline `DEV && recordListener(...)`-shaped expressions against the
 * expando key below (see tagFactory.ts and htm.ts), so the whole statement folds
 * away in production bundles instead of leaving a helper behind.
 */
export type ListenerRecord = Element & { __sibuListeners?: Set<string> };

/** Event types the framework attached to `el` (empty outside development). */
export function frameworkListenerTypes(el: Element): ReadonlySet<string> {
  return (el as ListenerRecord).__sibuListeners ?? new Set();
}
