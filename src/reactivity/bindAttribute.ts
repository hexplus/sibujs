import { devWarn, isDev } from "../core/dev";
import { reportError } from "../core/errors";
// `isEventHandlerAttr` is the single shared `on*` guard — event-handler
// attributes evaluate their value as JS via setAttribute, so the framework
// refuses to bind them (use `on: { click: fn }`, which uses addEventListener).
import { isEventHandlerAttr } from "../utils/sanitize";
import { setSafeAttribute } from "../utils/setSafeAttribute";
import { reactiveBinding } from "./track";

const _isDev = isDev();

/**
 * Bind a reactive getter to an element attribute.
 * Returns a teardown that stops all future updates.
 *
 * Sanitization:
 *  - `on*` event-handler attributes are refused (defense-in-depth).
 *  - URL attributes (href, src, action, etc.) go through protocol
 *    validation (blocks javascript:, data:, vbscript:, blob:).
 *  - All other attributes are passed through `setAttribute`, which is
 *    XSS-safe — the browser stores the value as text, never code.
 */
export function bindAttribute(el: HTMLElement, attr: string, getter: () => unknown): () => void {
  if (isEventHandlerAttr(attr)) {
    if (_isDev)
      devWarn(
        `bindAttribute: refusing to bind event-handler attribute "${attr}". Use on:{ ${attr.slice(2)}: fn } instead.`,
      );
    return () => {};
  }

  function commit() {
    let value: unknown;
    try {
      value = getter();
    } catch (err) {
      // User getter threw: keep the attribute at its last value, but report
      // centrally so the failure is observable in production too.
      reportError(err, { phase: "binding", name: `bindAttribute("${attr}")`, node: el });
      return;
    }

    // One shared commit primitive: boolean/IDL semantics, srcset per-candidate
    // validation, URL protocol allowlist, and the style declaration-list policy
    // all live in `setSafeAttribute`, so this path can never drift from the
    // static tag-factory path or the `bindAttrs` path.
    setSafeAttribute(el, attr, value, { label: `bindAttribute("${attr}")` });
  }

  // Initial run + reactive updates. Re-tracks deps every run so a signal first
  // read on a later run is subscribed (per-run dependency tracking).
  return reactiveBinding(commit, el);
}

/**
 * Bind a dynamic attribute where both name and value can change reactively.
 * Useful for `:attr.name` style dynamic keys.
 *
 * When the attribute name changes, the old attribute is removed and the
 * new one is set. Returns a teardown function that stops reactive tracking
 * and removes the current attribute from the element.
 */
export function bindDynamic(
  el: HTMLElement,
  nameGetter: string | (() => string),
  valueGetter: string | (() => unknown),
): () => void {
  // Track the previously applied attribute name so we can remove it on change
  let prevName: string | null = null;

  function commit() {
    // Resolve the current attribute name
    let name: string;
    try {
      name = typeof nameGetter === "function" ? nameGetter() : nameGetter;
    } catch (err) {
      reportError(err, { phase: "binding", name: "bindDynamic (name getter)", node: el });
      return;
    }

    // Resolve the current value
    let value: unknown;
    try {
      value = typeof valueGetter === "function" ? valueGetter() : valueGetter;
    } catch (err) {
      reportError(err, { phase: "binding", name: "bindDynamic (value getter)", node: el });
      return;
    }

    // If the attribute name changed, remove the old one. Done BEFORE the
    // commit so a refused name still clears the attribute it replaced rather
    // than leaving the previous value stranded on the element.
    if (prevName !== null && prevName !== name) {
      el.removeAttribute(prevName);
      prevName = null;
    }

    // Event-handler attribute names (onclick, onload, …) are refused inside the
    // shared primitive — dynamic attribute-name injection is exactly the case
    // it exists for.
    if (!setSafeAttribute(el, name, value, { label: "bindDynamic" })) return;

    prevName = name;
  }

  // Initial run + reactive updates. Re-tracks deps every run so a signal first
  // read on a later run is subscribed (per-run dependency tracking).
  const teardown = reactiveBinding(commit, el);

  // Return a combined teardown: stop tracking and clean up the current attribute
  return () => {
    teardown();
    if (prevName !== null) {
      el.removeAttribute(prevName);
    }
  };
}
