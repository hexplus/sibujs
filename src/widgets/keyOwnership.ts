// ---------------------------------------------------------------------------
// Keyboard ownership for headless widgets.
//
// A widget's key handler and a page-level shortcut handler see the SAME
// keydown: the event reaches the widget first and then bubbles on to the
// document. Without a convention, arrowing through a dropdown also nudged the
// canvas layer the page bound to arrows, and Escape that closed the dropdown
// also closed the panel around it.
//
// The convention: when a widget acts on a key, it CLAIMS the event. Page-level
// handlers ask `isWidgetKeyEvent(e)` and leave claimed events alone, and every
// widget in `sibujs/widgets` ignores an event a nested widget already claimed
// (a select menu inside a popover: Escape closes the menu, not the popover).
//
// Claiming marks the event; it does not stop propagation. Stopping it would
// also blind listeners that legitimately observe keys — focus traps, key
// loggers, analytics — and there would be no way to opt back in. The mark is a
// `Symbol.for` property so two copies of the runtime on one page agree on it.
// ---------------------------------------------------------------------------

const CLAIM = Symbol.for("sibujs.widgetKey");

type ClaimedEvent = Event & { [CLAIM]?: string };

/**
 * Mark `event` as handled by a widget. Called by every `sibujs/widgets` key
 * handler for each key it acts on.
 *
 * @param event The keyboard event the widget consumed.
 * @param widget Name of the claiming widget, reported by {@link widgetKeyOwner}.
 * @returns Nothing.
 * @internal
 */
export function claimWidgetKey(event: Event, widget: string): void {
  (event as ClaimedEvent)[CLAIM] = widget;
}

/**
 * Whether a `sibujs/widgets` widget already acted on this key event. Page-level
 * shortcuts test it so a key the user pressed INSIDE a widget (an arrow in a
 * select menu, Escape in a popover) does not also trigger the page's binding.
 *
 * @param event Any event; only key events are ever claimed.
 * @returns `true` when a widget consumed the event.
 *
 * @example
 * ```ts
 * document.addEventListener("keydown", (e) => {
 *   if (isWidgetKeyEvent(e)) return; // the dropdown already handled it
 *   if (e.key === "ArrowLeft") nudgeSelectedLayer(-1, 0);
 *   if (e.key === "Escape") deselect();
 * });
 * ```
 */
export function isWidgetKeyEvent(event: Event): boolean {
  return (event as ClaimedEvent)[CLAIM] !== undefined;
}

/**
 * Name of the widget that claimed `event` (`"selectMenu"`, `"tabs"`, …), or
 * `null` when no widget did.
 *
 * @param event Any event.
 * @returns The claiming widget's name, or `null`.
 */
export function widgetKeyOwner(event: Event): string | null {
  return (event as ClaimedEvent)[CLAIM] ?? null;
}
