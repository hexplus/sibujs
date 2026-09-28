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

import { DEV, devWarn, devWarnLazy } from "../core/dev";
import { ContextualRefusal, contextualAttributeRefusal } from "./elementPolicy";
import { isEventHandlerAttr, isHtmlContentAttribute, resolveAttributeValue } from "./sanitize";

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
  /**
   * The value comes from a live binding that may rewrite it after the element
   * is connected. Contextual rules that depend on reversibility — a `<meta>`
   * with any reactive attribute may never carry a refresh directive — key off
   * this. Every reactive writer (`bindAttribute`, `bindDynamic`, `bindBoolAttr`,
   * `bindData`, `enhance()`'s `attr()`) passes `true`.
   */
  reactive?: boolean;
}

/**
 * Explain a contextual refusal. Development only: the prose lives INSIDE the
 * `devWarnLazy` callback — not in a module-level table — so a production build
 * drops it together with the callback. See `ContextualRefusal`.
 */
function warnContextualRefusal(label: string, name: string, refusal: ContextualRefusal): void {
  devWarnLazy(() => {
    const reasons = [
      "",
      'the element would become a <meta http-equiv="refresh"> directive the shared refresh policy forbids ' +
        "(a destination outside the URL allowlist, or a directive too malformed to read unambiguously)",
      "a <meta> whose http-equiv or content is reactive may never carry a refresh directive: a browser " +
        "schedules the navigation as soon as the directive is valid, and nothing can withdraw it when the state " +
        "changes back",
      "a runtime value may not choose the program a <script> runs; name the script in static template " +
        "source, or load it through Head({ script }) as an explicit trust decision",
      "an SVG animation may not target a URL, event-handler or nested-document attribute; its to / values " +
        "would be written into that attribute without passing the URL policy",
      'a runtime-chosen href may not become an applied <link rel="stylesheet">: a well-formed URL is not a ' +
        "trusted stylesheet. Name the stylesheet in static template source, or load a runtime-chosen one through " +
        "Head({ link }) as an explicit trust decision",
    ];
    return `${label}: refusing "${name}" in this element's context — ${reasons[refusal]}. The write was not performed.`;
  });
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
 *   - booleans on `aria-*` — serialized as "true"/"false" (ARIA states are
 *     enumerated tokens, so absence and `false` mean different things).
 *   - other booleans — HTML boolean-attribute semantics, via the IDL property
 *     for `checked`/`disabled`/`selected` where that is the live state.
 *   - `value`/`checked` strings — IDL property when `syncValueProperty`.
 *   - contextual rules (`utils/elementPolicy`) — REFUSED, and the slot
 *     cleared, when the element's attributes after the write would form a
 *     forbidden meta refresh, a runtime `<script>` source, or an SVG animation
 *     aimed at a URL / handler / document attribute.
 *   - everything else — `resolveAttributeValue`, which applies the URL
 *     allowlist, the `srcset` candidate parser, and the `style`
 *     declaration-list policy, then passes inert values through. A non-empty
 *     value the policy refuses is OMITTED (the attribute is removed), never
 *     written as `href=""`; an authored `""` is written as authored. "Inert" is a claim about the attributes that reach
 *     this branch, not about `setAttribute` in general — `srcdoc` is refused
 *     above precisely because the browser parses it rather than storing it.
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
    if (DEV) {
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

  // CONTEXTUAL policy — rules whose verdict depends on the element and its
  // other attributes rather than on this one `(name, value)` pair: a meta
  // refresh directive, a runtime `<script src>`, an SVG animation retargeted at
  // a link. Judged on the snapshot the element WOULD have, before anything is
  // written, because these sinks act the moment they become valid.
  //
  // The string judged is the one the branches below commit for every name the
  // contextual rules care about (`http-equiv`, `content`, `src`, `type`,
  // `attributeName`, …): none of them is boolean-IDL-synced or rewritten by
  // `sanitizeAttributeString` in a way that matters — a runtime `<script src>`
  // is refused whatever the URL sanitizer would have made of it.
  //
  // `null`/`undefined`/`false` are removals. They are still passed through: a
  // reactive binding claims its element even when its first value removes
  // the attribute, so a later static write is judged with that knowledge.
  const pending = value == null || value === false ? null : value === true ? "" : String(value);
  const refusal = contextualAttributeRefusal(el, name, pending, options.reactive ? "reactive" : "runtime");
  if (refusal !== ContextualRefusal.None) {
    warnContextualRefusal(options.label ?? "setSafeAttribute", name, refusal);
    // RECONCILE, as for `on*`: the slot this write claimed is cleared, so a
    // value that was acceptable before this write cannot keep standing beside
    // the context that now makes it dangerous. Removal can never create one of
    // these states, so it is always safe to perform.
    if (ns) el.removeAttributeNS(ns, localName);
    else el.removeAttribute(name);
    return false;
  }

  if (value == null) {
    if (ns) el.removeAttributeNS(ns, localName);
    else el.removeAttribute(name);
    return true;
  }

  if (isHtmlContentAttribute(name)) {
    if (DEV) {
      devWarn(
        `${options.label ?? "setSafeAttribute"}: refusing to set "${name}". The browser parses this ` +
          "attribute as a nested HTML document, so a generic string value cannot be made safe — " +
          "attribute escaping is undone before the parse. Build the frame's content another way.",
      );
    }
    // RECONCILE, exactly as for `on*`: taking this slot means governing it, so
    // a pre-existing document (from server markup or a third party) is removed
    // rather than left live.
    if (ns) el.removeAttributeNS(ns, localName);
    else el.removeAttribute(name);
    return false;
  }

  // HTML attribute names are case-insensitive, so the IDL decisions below must
  // fold case — `VALUE` IS `value` to the browser. SVG names are case-sensitive
  // and have no IDL form-control semantics, so neither applies there.
  const html = isHtmlElement(el);
  const idlName = html ? name.toLowerCase() : name;

  if (typeof value === "boolean") {
    // ARIA states are enumerated "true"/"false" tokens, not presence-based
    // boolean attributes: removing `aria-selected` means "not applicable", which
    // is a different statement from "not selected". Serialize the boolean so
    // `"aria-selected": () => selected()` states `false` explicitly. Only
    // `null`/`undefined` (handled above) remove an ARIA attribute.
    if (name.length > 5 && name.slice(0, 5).toLowerCase() === "aria-") {
      const token = value ? "true" : "false";
      if ((ns ? el.getAttributeNS(ns, localName) : el.getAttribute(name)) !== token) {
        if (ns) el.setAttributeNS(ns, name, token);
        else el.setAttribute(name, token);
      }
      return true;
    }
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

  // `resolveAttributeValue` keys off the attribute NAME, and the URL set it
  // consults already contains `xlink:href` — so the prefixed name is passed in
  // whole even though the write itself uses the local name plus a namespace.
  //
  // `null` means OMIT: a refused URL (or a style/srcset with nothing left) is
  // removed, never published as `href=""` — the same answer `Head()` and every
  // SSR serializer give, so a server-rendered element and its hydrated
  // replacement agree. See `resolveAttributeValue`.
  //
  // An AUTHORED empty value is not a refusal, and keeps its original meaning on
  // a live element: `a({ href: "" })` is a deliberate self-link (focusable, link
  // role, pointer cursor), and a getter toggling to `""` relies on the link
  // staying a link. Only a non-empty value the policy reduced to nothing is
  // omitted. (`Head()` and the SSR serializers omit `""` too, by their own
  // documented rule; that pre-dates this primitive and is unchanged.)
  const safe = str === "" ? "" : resolveAttributeValue(name, str, { element: el });
  if (safe === null) {
    if (ns) el.removeAttributeNS(ns, localName);
    else el.removeAttribute(name);
    return true;
  }

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

/**
 * Commit an attribute from STATIC TEMPLATE SOURCE — text the developer typed
 * into an `html``` template, never a runtime value.
 *
 * Static source is developer-authored markup, so the VALUE policies of
 * {@link setSafeAttribute} (URL allowlist, `on*`, `style` filtering) do not
 * apply: `html\`<a href="/x" onclick="…">\`` means what it says, exactly as
 * the same markup would in an HTML file. That trust model is documented in
 * `docs/architecture/attribute-security.md`.
 *
 * Two rules still apply. `srcdoc` is refused outright, as on every path. And
 * the CONTEXTUAL rules apply, because they hold regardless of where a value
 * came from and because a static attribute combines with runtime ones on the
 * same element: `<meta content=${x} http-equiv="refresh">` writes the
 * runtime `content` first, when it is still inert, and the static
 * `http-equiv` second — the write that actually creates the directive. Only a
 * check at that second write, against the whole element, can see it.
 *
 * Returns `false` when the write was refused (and not performed).
 */
export function setTrustedAttribute(el: Element, name: string, value: string): boolean {
  // `srcdoc` is refused on EVERY path, static source included. Static trust
  // covers what the developer typed; it cannot vouch for a nested DOCUMENT the
  // browser will parse after attribute decoding, and no trusted-document API
  // exists (see `isHtmlContentAttribute`). Every SSR serializer has always
  // omitted it, so keeping it here made the client and the server disagree
  // about the same template.
  if (isHtmlContentAttribute(name)) {
    if (DEV) devWarn(`html: refusing static attribute "${name}" — the browser parses it as a nested document.`);
    return false;
  }
  const refusal = contextualAttributeRefusal(el, name, value, "static");
  if (refusal !== ContextualRefusal.None) {
    warnContextualRefusal("html (static attribute)", name, refusal);
    return false;
  }
  el.setAttribute(name, value);
  return true;
}
