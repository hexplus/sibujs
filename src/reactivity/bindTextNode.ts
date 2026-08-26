import { reportError } from "../core/errors";
import { reactiveBinding } from "./track";

/**
 * Binds a reactive getter to a Text node, updating its content reactively.
 * A throwing getter is contained — the last displayed text stays — and the
 * failure is reported through the central runtime error pipeline.
 *
 * textContent is inherently XSS-safe — it sets plain text, never parsing HTML.
 *
 * @param textNode Target Text node whose content will be updated
 * @param getter Function returning string or number to display
 * @returns Teardown function to cancel the binding
 */
export function bindTextNode(textNode: Text, getter: () => string | number): () => void {
  function commit() {
    let value: string | number;
    try {
      value = getter();
    } catch (err) {
      // Keep the previously rendered text (containment) but never silently:
      // the getter is user code, so the failure goes through the central
      // pipeline rather than a dev-only warning.
      reportError(err, { phase: "binding", name: "bindTextNode", node: textNode });
      return;
    }
    textNode.textContent = String(value);
  }

  // Initial render and reactive subscription. Re-tracks deps every run so a
  // signal first read on a later run is subscribed (per-run dependency tracking).
  return reactiveBinding(commit, textNode);
}
