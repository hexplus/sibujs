/**
 * THE attribute-commit primitive.
 *
 * WHY THIS EXISTS
 * ---------------
 * Every way an application can write an attribute must reach the same security
 * verdict. Before this module, four writers each re-implemented "commit an
 * attribute" and drifted:
 *
 *   tagFactory static prop      guarded `on*`, sanitized url/style/srcset
 *   bindAttribute (reactive)    guarded `on*`, sanitized url/style/srcset
 *   bindAttrs static value      RAW setAttribute — no guard, no sanitizer
 *   svgElement                  RAW setAttribute — no guard, no sanitizer
 *
 * So `bindAttrs(a, { href: url })` and `bindAttrs(a, { href: () => url })`
 * disagreed about `javascript:`, and `svgElement("svg", { onload: "…" })`
 * installed a live event handler the HTML factory would have refused. The
 * divergence — not any single missing check — is the vulnerability: an
 * application that refactors a static value into a getter, or renders the same
 * icon through the SVG helper, silently changes its security posture.
 *
 * This module is the one place an attribute value becomes DOM. The policy
 * itself still lives in `./sanitize` (`isEventHandlerAttr`,
 * `sanitizeAttributeString`); nothing here re-implements a sanitizer, it only
 * guarantees every writer runs the existing one.
 */

import { devWarn, isDev } from "../core/dev";
import { isEventHandlerAttr, sanitizeAttributeString } from "./sanitize";

const _isDev = isDev();

const HTML_NS = "http://www.w3.org/1999/xhtml";
const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";
const XML_NS = "http://www.w3.org/XML/1998/namespace";

/**
 * Attributes whose CURRENT state lives on the IDL property, not the content
 * attribute. `setAttribute("checked")` only moves the *default*, so a live
 * update would leave the rendered control showing a stale value.
 */
const BOOLEAN_IDL_ATTRS = new Set(["checked", "disabled", "selected"]);

/**
 * Is `el` in the HTML namespace?
 *
 * Decides two things that must NOT be applied to foreign content:
 *   - attribute-name case folding (HTML names are case-insensitive, SVG's are
 *     not — `viewBox`, `preserveAspectRatio` and `patternUnits` are meaningless
 *     lowercased), and
 *   - IDL-property synchronisation, which is an HTML form-control concept.
 *
 * `createElement` in an HTML document yields the XHTML namespace; a null
 * namespace (detached/foreign-free nodes in some engines) is treated as HTML
 * because that is where the case-insensitive parser rules apply.
 */
function isHtmlElement(el: Element): boolean {
  return el.namespaceURI === null || el.namespaceURI === HTML_NS;
}

export interface SafeAttributeOptions {
  /**
   * Write string `value`/`checked` through the IDL property instead of the
   * content attribute.
   *
   * `true` (default) is what a live/reactive update needs: after a user has
   * typed, the content attribute no longer reflects the control's state.
   * `tagFactory` passes `false` because on FIRST render the content attribute
   * is the correct sink — it seeds the default value and survives form reset.
   */
  syncValueProperty?: boolean;
  /** Label used in the dev warning when an event-handler attribute is refused. */
  label?: string;
}

/** Typed property setter — avoids `@ts-expect-error` at each call site. */
function setProp(el: Element, key: string, val: unknown): void {
  (el as unknown as Record<string, unknown>)[key] = val;
}

/**
 * Resolve the namespace a prefixed attribute must be written in.
 *
 * `xlink:href` is the legacy SVG link attribute and a historic `javascript:`
 * vector on `<a>`/`<use>`. A plain `setAttribute("xlink:href", …)` creates an
 * attribute whose *literal name* contains a colon and whose namespace is null —
 * which SVG renderers do not honour, so the icon silently fails to resolve.
 * Only `setAttributeNS(XLINK_NS, …)` produces the attribute authors mean.
 *
 * Applied only inside the SVG namespace: in HTML, `xlink:*` has no special
 * meaning and changing its sink would alter existing markup semantics.
 */
function namespaceFor(el: Element, name: string): string | null {
  if (el.namespaceURI !== SVG_NS) return null;
  const lower = name.toLowerCase();
  if (lower.startsWith("xlink:")) return XLINK_NS;
  if (lower.startsWith("xml:")) return XML_NS;
  return null;
}

/**
 * Commit one attribute to `el`, applying the framework's shared security
 * policy. Returns `true` if a write (or a deliberate removal) happened, and
 * `false` if the attribute was refused.
 *
 * Handled, in order:
 *   - `on*` event-handler attributes — REFUSED. Their value is evaluated as
 *     JavaScript on dispatch, so no string may ever reach one. Use
 *     `on: { click: fn }` (addEventListener), which is unaffected.
 *   - `null`/`undefined` — removes the attribute.
 *   - booleans — HTML boolean-attribute semantics, via the IDL property for
 *     `checked`/`disabled`/`selected` where that is the live state.
 *   - `value`/`checked` strings — IDL property when `syncValueProperty`.
 *   - everything else — `sanitizeAttributeString`, which applies the URL
 *     allowlist, the per-candidate `srcset` split, and the `style`
 *     declaration-list policy, then passes inert values through.
 */
export function setSafeAttribute(
  el: Element,
  name: string,
  value: unknown,
  options: SafeAttributeOptions = {},
): boolean {
  const ns = namespaceFor(el, name);
  const localName = ns ? name.slice(name.indexOf(":") + 1) : name;

  if (isEventHandlerAttr(name)) {
    if (_isDev) {
      devWarn(
        `${options.label ?? "setSafeAttribute"}: refusing to set event-handler attribute "${name}". ` +
          `Its value would be evaluated as JavaScript. Use on:{ ${name.slice(2)}: fn } instead.`,
      );
    }
    // RECONCILE, don't merely decline. A binding that names an `on*` slot now
    // OWNS that slot, and the caller's expectation is that the framework
    // governs it. Leaving a pre-existing `onclick="alert(1)"` — from server
    // markup, a third-party widget, or anything `enhance()` was pointed at —
    // would satisfy "I did not create a handler" while the page still has one.
    // Security here is a postcondition on the attribute, not a property of this
    // particular write.
    if (ns) el.removeAttributeNS(ns, localName);
    else el.removeAttribute(name);
    return false;
  }

  if (value == null) {
    if (ns) el.removeAttributeNS(ns, localName);
    else el.removeAttribute(name);
    return true;
  }

  // HTML attribute names are case-insensitive, so the IDL decisions below must
  // fold case — `VALUE` IS `value` to the browser. SVG names are case-sensitive
  // and have no IDL form-control semantics, so neither applies there.
  const html = isHtmlElement(el);
  const idlName = html ? name.toLowerCase() : name;

  if (typeof value === "boolean") {
    if (html && BOOLEAN_IDL_ATTRS.has(idlName) && idlName in el) {
      setProp(el, idlName, value);
    } else if (value) {
      if (ns) el.setAttributeNS(ns, name, "");
      else el.setAttribute(name, "");
    } else if (ns) {
      el.removeAttributeNS(ns, localName);
    } else {
      el.removeAttribute(name);
    }
    return true;
  }

  const str = String(value);

  if (options.syncValueProperty !== false && html && (idlName === "value" || idlName === "checked") && idlName in el) {
    setProp(el, idlName, idlName === "checked" ? Boolean(value) : str);
    return true;
  }

  // `sanitizeAttributeString` keys off the attribute NAME, and the URL set it
  // consults already contains `xlink:href` — so the prefixed name is passed in
  // whole even though the write itself uses the local name plus a namespace.
  const safe = sanitizeAttributeString(name, str);

  // No-op check on the SANITIZED result, never on the caller's raw input.
  //
  // This is the primitive's own write-elision, and it exists here so that no
  // caller has to implement one. A caller comparing its RAW desired value
  // against the DOM before delegating would skip the sanitizer exactly when the
  // DOM already holds that raw value — which is precisely the dangerous case:
  // `<a href="javascript:…">` re-bound to the same string would never be
  // cleaned. Comparing post-policy makes the elision safe by construction.
  const current = ns ? el.getAttributeNS(ns, localName) : el.getAttribute(name);
  if (current === safe) return true;

  if (ns) el.setAttributeNS(ns, name, safe);
  else el.setAttribute(name, safe);
  return true;
}
