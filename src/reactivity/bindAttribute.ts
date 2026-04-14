import { devWarn, isDev } from "../core/dev";
import { isUrlAttribute, sanitizeUrl } from "../utils/sanitize";
import { track } from "./track";

const _isDev = isDev();

/**
 * Typed property setter — local helper to avoid `@ts-expect-error` at call
 * sites when assigning to dynamic IDL properties (checked, value, etc.).
 */
function setProp(el: Element, key: string, val: unknown): void {
  (el as unknown as Record<string, unknown>)[key] = val;
}

/**
 * Is this attribute an `on*` event handler? Event-handler attributes are
 * always a XSS vector when set via `setAttribute` (they evaluate the
 * value as JavaScript on event dispatch), so the framework refuses to
 * bind to them. Use `on: { click: fn }` on the tag factory instead —
 * that path uses `addEventListener` which is safe.
 */
function isEventHandlerAttr(name: string): boolean {
  if (name.length < 3) return false;
  const lower = name.toLowerCase();
  return lower[0] === "o" && lower[1] === "n" && lower.charCodeAt(2) >= 97 && lower.charCodeAt(2) <= 122;
}

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
      if (_isDev)
        devWarn(`bindAttribute: getter for "${attr}" threw: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    // Boolean values toggle the attribute presence (HTML boolean attribute semantics)
    if (typeof value === "boolean") {
      // For IDL properties like checked/disabled/selected, set the DOM property
      // directly — setAttribute only changes the default, not the current state.
      if (attr in el && (attr === "checked" || attr === "disabled" || attr === "selected")) {
        setProp(el, attr, value);
      } else if (value) {
        el.setAttribute(attr, "");
      } else {
        el.removeAttribute(attr);
      }
      return;
    }

    const str = String(value);

    // If binding an input value or checked state, update the property
    if ((attr === "value" || attr === "checked") && attr in el) {
      setProp(el, attr, attr === "checked" ? Boolean(value) : str);
    } else {
      // URL attributes need protocol sanitization; others are safe via setAttribute
      el.setAttribute(attr, isUrlAttribute(attr) ? sanitizeUrl(str) : str);
    }
  }

  // Initial run + reactive updates
  const teardown = track(commit);
  return teardown;
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
      if (_isDev) devWarn(`bindDynamic: name getter threw: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    // Resolve the current value
    let value: unknown;
    try {
      value = typeof valueGetter === "function" ? valueGetter() : valueGetter;
    } catch (err) {
      if (_isDev) devWarn(`bindDynamic: value getter threw: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    // Block event handler attributes (onclick, onload, onerror, etc.)
    // to prevent XSS via dynamic attribute name injection
    if ((name[0] === "o" || name[0] === "O") && (name[1] === "n" || name[1] === "N")) return;

    // If the attribute name changed, remove the old one
    if (prevName !== null && prevName !== name) {
      el.removeAttribute(prevName);
    }

    const str = String(value);

    // If binding an input value or checked state, update the property
    if ((name === "value" || name === "checked") && name in el) {
      setProp(el, name, name === "checked" ? Boolean(value) : str);
    } else {
      el.setAttribute(name, isUrlAttribute(name) ? sanitizeUrl(str) : str);
    }

    prevName = name;
  }

  // Initial run + reactive updates
  const teardown = track(commit);

  // Return a combined teardown: stop tracking and clean up the current attribute
  return () => {
    teardown();
    if (prevName !== null) {
      el.removeAttribute(prevName);
    }
  };
}
