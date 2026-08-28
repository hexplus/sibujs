/**
 * THE `<head>` entry policy — one implementation for `Head()`, `renderToDocument`,
 * and `renderRouteToDocument`.
 *
 * WHY THE POLICY IS BAKED IN RATHER THAN INJECTED
 * ----------------------------------------------
 * An earlier version of this pipeline took the name filter and the value
 * sanitizer as parameters, so each rendering target supplied its own. That is a
 * shared *function*, not a shared *decision*, and the three promptly diverged:
 *
 *   - the client classified URL attributes with a case-SENSITIVE `Set`, so
 *     `SRC`/`HREF` skipped sanitization entirely while the servers lower-cased
 *     first and refused the same value;
 *   - router SSR carried a local scheme BLOCKLIST (`javascript:`, `data:`,
 *     `vbscript:`, `blob:`) where the canonical sanitizer is an ALLOWLIST, so it
 *     happily emitted `file:`, `about:`, `chrome:` and any custom scheme;
 *   - the client kept `srcdoc` that both servers dropped;
 *   - the client published a refused URL as `href=""` where the servers omitted
 *     the attribute.
 *
 * So only VALUE RESOLUTION is parameterized now — the client has reactive
 * getters to invoke and the servers do not, and that is the entire difference
 * between them. Name canonicalization, eligibility, sanitization, duplicate
 * detection, the empty-entry rule, and the meta-refresh verdict are fixed here.
 * The three paths cannot drift because there is nothing left for them to
 * disagree about.
 */

import { type MetaRefreshDecision, resolveMetaRefreshPolicy } from "./metaRefresh";
import {
  canonicalAttrName,
  isEventHandlerAttr,
  isHtmlContentAttribute,
  isPolicyAttribute,
  sanitizeAttributeString,
} from "./sanitize";

// Re-exported so every `<head>` caller has one import site for the policy.
export { canonicalAttrName } from "./sanitize";

/**
 * Strict attribute-name validation — blocks injection via crafted keys.
 *
 * Rejects any non-ASCII name outright, which is also what makes
 * `canonicalAttrName`'s ASCII-only fold total here rather than merely careful:
 * no name reaching the classification steps can contain a code point the fold
 * leaves alone.
 */
const SAFE_HEAD_ATTR_NAME = /^[A-Za-z_:][-A-Za-z0-9_.:]*$/;

/**
 * May this attribute name be written into `<head>` at all?
 *
 * Three refusals, all on the canonical name:
 *
 *   - malformed names, which could break out of the attribute context;
 *   - `on*` event handlers, whose value is evaluated as JavaScript;
 *   - `srcdoc`, which the browser parses as a nested HTML *document*. Escaping
 *     is the wrong layer there — `srcdoc="&lt;script&gt;…"` is correctly escaped
 *     and still becomes `<script>…` once parsed — so it is omitted outright,
 *     identically on the client and both servers.
 */
export function isEmittableHeadAttrName(name: string): boolean {
  if (!SAFE_HEAD_ATTR_NAME.test(name)) return false;
  const canonical = canonicalAttrName(name);
  if (isEventHandlerAttr(canonical)) return false;
  if (isHtmlContentAttribute(canonical)) return false;
  return true;
}

/**
 * The value that will actually be committed, or `null` when the attribute must
 * be OMITTED.
 *
 * The `null` is the whole point. A refused URL is not "the empty URL": omitting
 * `href` and setting `href=""` are different documents, because an empty URL
 * attribute resolves against the current document rather than being absent
 * (`<link href="">` points at the page itself, and `<script src="">` is a
 * request, not a no-op). So a rejected value is dropped rather than replaced
 * with an empty substitute.
 *
 * `""` is only ever a rejection for a POLICY sink. For an inert text attribute
 * — `content`, `id`, `name` — an empty string is a legitimate value and is
 * committed as authored.
 *
 * The sanitization itself is delegated to `sanitizeAttributeString`, the same
 * authority the tag factory and the reactive bindings use, so `<head>` cannot
 * hold a value the rest of the framework would refuse: `srcset` is parsed as a
 * candidate list, `style` per declaration, and single-URL sinks go through the
 * protocol ALLOWLIST (`http:`, `https:`, `mailto:`, `tel:`, `ftp:`, and
 * relative URLs). Anything else — `javascript:`, `data:`, `vbscript:`, `blob:`,
 * `file:`, `about:`, unknown schemes — is refused.
 */
export function sanitizeHeadAttrValue(canonical: string, value: string): string | null {
  if (!isPolicyAttribute(canonical)) return value;
  const safe = sanitizeAttributeString(canonical, value);
  return safe === "" ? null : safe;
}

/**
 * The first attribute name that appears twice under the canonical fold, or `null`.
 *
 * Operates on RAW authored names — before any filtering, resolution, or
 * sanitization — because that is the only point at which every path sees the
 * same input. Filtering first is what made them disagree: the client dropped
 * `onload`/`ONLOAD` as event handlers and then saw no duplicate, while the
 * servers checked the raw record and rejected the entry.
 *
 * The rule is REJECTION, not precedence. Last-write-wins would also be sound if
 * the validated value were provably the committed one, but rejection removes the
 * class of bug rather than re-parameterising it.
 */
export function findDuplicateAttributeName(names: Iterable<string>): string | null {
  const seen = new Set<string>();
  for (const name of names) {
    const canonical = canonicalAttrName(name);
    if (seen.has(canonical)) return canonical;
    seen.add(canonical);
  }
  return null;
}

/**
 * How one rendering target turns an authored value into a string.
 *
 * This is the ONLY thing that differs between the client and the servers, and
 * the only thing this module lets a caller supply.
 */
export interface HeadValueResolver<V> {
  /** Coerce an authored value to its string form (invoking getters on the client). */
  resolveValue(name: string, value: V): string;
  /** Does this authored value change over time? Only the client has these. */
  isReactiveValue?(value: V): boolean;
}

export type HeadEntryPlan =
  | { kind: "drop"; reason: string }
  | { kind: "publish"; attributes: Map<string, string>; refresh: MetaRefreshDecision };

/**
 * Plan ONE `<head>` entry. The single pipeline every rendering target runs:
 *
 *   1. reject duplicate case-insensitive names, on the RAW authored names
 *   2. canonicalize each name
 *   3. drop names that may not be emitted (malformed, `on*`, `srcdoc`)
 *   4. resolve values (invoking reactive getters on the client)
 *   5. sanitize values, OMITTING rejected ones rather than emptying them
 *   6. drop the entry entirely when nothing effective remains
 *   7. for `<meta>`, validate the complete effective snapshot against the
 *      meta-refresh policy — what is judged is exactly what is committed
 *
 * The resulting map is keyed by CANONICAL names, so the client's DOM and both
 * servers' HTML are directly comparable rather than merely equivalent. `<meta>`,
 * `<link>`, and `<script>` in `<head>` are always HTML elements — never foreign
 * content — so lower-casing is precisely what the parser does anyway.
 *
 * NATIVE REFRESH DIRECTIVES MUST BE STATIC (step 7, meta only). A browser
 * processes a meta refresh when the element is INSERTED: it records the pending
 * navigation there and then. Removing or replacing the element afterwards is not
 * a defined cancellation mechanism, so once a reactive entry has published one,
 * a later state change that ought to withdraw it has nothing left to withdraw.
 * A reactive entry therefore never publishes a refresh snapshot — even a
 * perfectly safe one, because the question is reversibility rather than safety.
 * See https://html.spec.whatwg.org/multipage/semantics.html#attr-meta-http-equiv-refresh
 */
function planEntry<V>(
  props: Record<string, V>,
  resolver: HeadValueResolver<V>,
  applyRefreshPolicy: boolean,
): HeadEntryPlan {
  // 1 — raw names, before anything is filtered away or resolved.
  const rawNames = Object.keys(props);
  const duplicate = findDuplicateAttributeName(rawNames);
  if (duplicate !== null) {
    return { kind: "drop", reason: `duplicate case-insensitive attribute ${JSON.stringify(duplicate)}` };
  }

  // 2/3/4/5 — canonical name, eligibility, resolution, sanitization.
  const attributes = new Map<string, string>();
  let reactive = false;
  for (const name of rawNames) {
    if (!Object.hasOwn(props, name)) continue;
    if (!isEmittableHeadAttrName(name)) continue;
    const authored = props[name];
    // Reactivity is recorded BEFORE sanitization: a getter whose value the
    // sanitizer happens to reject is still a subscription, so the entry can
    // still be republished later.
    if (resolver.isReactiveValue?.(authored)) reactive = true;
    const canonical = canonicalAttrName(name);
    const sanitized = sanitizeHeadAttrValue(canonical, resolver.resolveValue(name, authored));
    if (sanitized === null) continue;
    attributes.set(canonical, sanitized);
  }

  // 6 — ONE shared answer for "nothing survived". An attribute-less `<meta>` or
  //     `<link>` is meaningless markup, and letting each path decide for itself
  //     is how the client came to emit `<meta>` where both servers emitted
  //     nothing at all.
  if (attributes.size === 0) return { kind: "drop", reason: "no effective attributes remain" };

  // 7 — judge the assembled snapshot, never a partial or pre-sanitization one.
  // A fresh literal rather than a shared constant: a plan is handed to callers,
  // and one aliased object reachable from every plan is an invitation to a
  // cross-entry mutation bug that would be very hard to trace.
  const refresh: MetaRefreshDecision = applyRefreshPolicy
    ? resolveMetaRefreshPolicy(attributes)
    : { kind: "not-refresh" };
  if (refresh.kind === "forbidden") return { kind: "drop", reason: refresh.reason };
  if (reactive && (refresh.kind === "allowed" || refresh.kind === "delay-only")) {
    return { kind: "drop", reason: "a reactive meta entry may not publish a native refresh directive" };
  }

  return { kind: "publish", attributes, refresh };
}

/** Plan a `<meta>` entry, including the meta-refresh policy. */
export function planMetaEntry<V>(props: Record<string, V>, resolver: HeadValueResolver<V>): HeadEntryPlan {
  return planEntry(props, resolver, true);
}

/**
 * Plan a `<link>` or `<script>` entry.
 *
 * Identical to `planMetaEntry` minus the refresh step: `http-equiv` has no
 * meaning on these elements, so applying refresh semantics to them would be an
 * invented rule rather than a shared one.
 */
export function planHeadElementEntry<V>(props: Record<string, V>, resolver: HeadValueResolver<V>): HeadEntryPlan {
  return planEntry(props, resolver, false);
}

/** Values are already strings — the resolver both servers use. */
export const STATIC_VALUE_RESOLVER: HeadValueResolver<string> = {
  resolveValue: (_name, value) => String(value),
};

/**
 * Escape an attribute VALUE for emission inside a double-quoted HTML attribute.
 *
 * Byte-identical to the escapers `platform/ssr.ts` and `plugins/routerSSR.ts`
 * each used to carry privately. Escaping is not a policy, but two copies of it
 * beside one shared policy is exactly the shape that let those two modules drift
 * in the first place.
 */
function escapeHeadAttrValue(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Serialize one `<head>` entry to HTML, or `""` when the shared policy refuses
 * it.
 *
 * Both `renderToDocument` and `renderRouteToDocument` call THIS function rather
 * than each maintaining a serializer of their own, so there is one place where
 * a planned entry becomes markup.
 */
export function serializeHeadEntry(tag: "meta" | "link", attrs: Record<string, string>): string {
  const plan =
    tag === "meta" ? planMetaEntry(attrs, STATIC_VALUE_RESOLVER) : planHeadElementEntry(attrs, STATIC_VALUE_RESOLVER);
  if (plan.kind === "drop") return "";
  const pairs = Array.from(plan.attributes, ([name, value]) => `${name}="${escapeHeadAttrValue(value)}"`).join(" ");
  return `<${tag} ${pairs} />`;
}
