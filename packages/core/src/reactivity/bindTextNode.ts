import { devWarn, isDev } from "../core/dev";
import { reactiveBinding } from "./track";

/**
 * Binds a reactive getter to a Text node, updating its content reactively.
 * Render errors are swallowed to preserve last displayed text.
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
      if (isDev()) {
        devWarn(`[SibuJS] bindTextNode getter threw: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }
    textNode.textContent = String(value);
  }

  // Initial render and reactive subscription. Re-tracks deps every run so a
  // signal first read on a later run is subscribed (per-run dependency tracking).
  return reactiveBinding(commit);
}
