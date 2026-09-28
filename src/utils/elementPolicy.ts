/**
 * THE element-level security policy.
 *
 * WHY THIS EXISTS
 * ---------------
 * `sanitizeAttributeString(name, value)` judges ONE attribute in isolation, and
 * for most attributes that is the whole question: whether `href="javascript:…"`
 * is dangerous does not depend on anything else on the element. A few verdicts
 * cannot be reached that way, because the danger is a property of the ELEMENT
 * and its OTHER attributes:
 *
 *   - `content="0;url=javascript:…"` is inert text on `<meta name="x">` and a
 *     navigation on `<meta http-equiv="refresh">`. Judged as `(name, value)`,
 *     `content` cannot know which of the two it is being written to, so every
 *     generic writer (`meta()`, reactive bindings, `html```, `enhance()`) let
 *     the refresh through while `Head()` — which assembles whole entries —
 *     refused it. Same element, same data, two verdicts depending on the API.
 *   - `src` is a resource hint on `<img>` and the choice of WHICH PROGRAM RUNS on
 *     `<script>`.
 *   - `attributeName="href"` on an SVG `<set>` / `<animate>` turns the inert
 *     `to` / `values` attributes into writes to a link target.
 *
 * So the contextual rules live here, keyed on the element, and receive the
 * element itself — never a `(name, value)` pair that has already lost the
 * context. Every framework attribute writer consults this module before it
 * mutates the DOM (`setSafeAttribute` for runtime values, `setTrustedAttribute`
 * for static template source), and the SSR serializer consults the same
 * meta-refresh authority (`utils/metaRefresh.ts`) for foreign DOM it is asked to
 * emit.
 *
 * BEFORE THE MUTATION, NEVER AFTER
 * --------------------------------
 * Every check runs against the snapshot the element WOULD have after the write,
 * and a refused write is never performed. "Write, detect, remove" is not a
 * defence for these sinks: a connected `<meta http-equiv="refresh">` schedules
 * its navigation as soon as it becomes valid, and a connected `<script>` fetches
 * its `src` immediately. Removal afterwards does not cancel either.
 *
 * HOT PATH
 * --------
 * Called on every attribute commit, so the common case must stay trivial: one
 * `localName` read and a couple of string comparisons. Only `<meta>`,
 * `<script>`, and the SVG animation elements do any further work.
 */

import { resolveMetaRefreshPolicy } from "./metaRefresh";
import {
  canonicalAttrName,
  isEventHandlerAttr,
  isHtmlContentAttribute,
  isUrlAttribute,
  stripControlChars,
} from "./sanitize";

const HTML_NS = "http://www.w3.org/1999/xhtml";
const SVG_NS = "http://www.w3.org/2000/svg";

// ─── Elements ───────────────────────────────────────────────────────────────

/**
 * Elements that execute script or embed a foreign document / plugin by their
 * mere existence, whatever their attributes say.
 *
 * THE single list. The tag factories, `svgElement()`, and `DOMPool` consult it
 * whenever the tag name is a runtime value; nothing else carries its own copy.
 * It is deliberately NOT applied to static `html``` template source — a tag
 * name the developer typed into their own template is developer-authored
 * markup. See `docs/architecture/attribute-security.md` § Trust model.
 */
const BLOCKED_ELEMENTS = new Set(["script", "iframe", "object", "embed", "frame", "frameset"]);

/**
 * Fold a tag name the way `document.createElement` does in an HTML document:
 * ASCII `A`-`Z` only. `toLowerCase()` would additionally map some non-ASCII code
 * points into ASCII letters, letting this check and the DOM disagree about
 * which element a name creates.
 */
export function canonicalTagName(tag: string): string {
  return canonicalAttrName(tag);
}

/**
 * May an element with this tag name be created from a runtime value?
 *
 * Case-insensitive and namespace-agnostic: `<script>` exists in both HTML and
 * SVG, and a conservative answer for `SCRIPT` in the case-sensitive SVG
 * namespace costs nothing.
 */
export function isBlockedElement(tag: string): boolean {
  return BLOCKED_ELEMENTS.has(canonicalTagName(tag));
}

/**
 * Elements whose TEXT CONTENT is a program: JavaScript for `<script>`, a
 * stylesheet for `<style>`.
 *
 * Text escaping does nothing for them. The HTML parser reads their contents as
 * raw text — so an SSR serializer cannot escape them without corrupting them
 * and cannot leave them unescaped without allowing `</script>` breakout — and
 * the browser executes or applies whatever text they hold. Two consequences,
 * both consumers of this one predicate:
 *
 *   - `html``` refuses a `${…}` interpolation inside them: runtime data may not
 *     become code.
 *   - SSR never serializes them; `renderToDocument`'s dedicated options exist
 *     for scripts.
 *
 * The other parser raw-text / RCDATA elements (`textarea`, `title`, `xmp`,
 * `noscript`, `noembed`, `noframes`, `iframe`, `plaintext`) do not belong here:
 * their text is displayed, not run, and every SibuJS path either builds it with
 * `createTextNode` (no parser involved) or serializes it with `<` escaped, which
 * cannot close the element.
 */
const CODE_TEXT_ELEMENTS = new Set(["script", "style"]);

export function isCodeTextElement(tag: string): boolean {
  return CODE_TEXT_ELEMENTS.has(canonicalTagName(tag));
}

// ─── Contextual attribute policy ────────────────────────────────────────────

/**
 * Where an attribute value came from, which decides how much of the policy
 * applies to it.
 *
 *   - `"static"`   — literal text in `html``` template source. Developer-authored,
 *                   so value policies (URL allowlist, `on*`) do not apply; only
 *                   the rules that hold regardless of source do.
 *   - `"runtime"`  — any other value handed to a framework writer: props, `${…}`
 *                   interpolations, `bindAttrs` statics. Untrusted by default.
 *   - `"reactive"` — a runtime value written by a live binding, which may change
 *                   AFTER the element is connected.
 */
export type AttributeWriteOrigin = "static" | "runtime" | "reactive";

/**
 * Why a write was refused — a CODE, not prose.
 *
 * The verdict ships in every production bundle; the explanation is a
 * development aid. Keeping them apart lets the writers describe a refusal only
 * inside a `devWarnLazy` callback, which a production build drops whole, so the
 * policy costs a few comparisons rather than a paragraph of English per rule.
 */
export const ContextualRefusal = {
  None: 0,
  /** The element would carry a refresh directive the shared policy forbids. */
  MetaRefreshForbidden: 1,
  /** A `<meta>` with a reactive binding may not carry any refresh directive. */
  MetaRefreshReactive: 2,
  /** A runtime value may not choose which program a `<script>` runs. */
  ScriptSource: 3,
  /** An SVG animation may not target a URL, handler or document attribute. */
  AnimationTarget: 4,
} as const;

export type ContextualRefusal = (typeof ContextualRefusal)[keyof typeof ContextualRefusal];

/**
 * Attributes of `<script>` that choose WHICH code runs: the external resource
 * (`src`, and `href` / `xlink:href` on SVG `<script>`) and the language it is
 * run as (`type`, legacy `language`). A runtime value in any of them is the
 * page loading a program the page's author did not name, so it is refused
 * whatever its scheme — `https://` is an allowed URL and a remote code
 * execution here.
 *
 * Static template source may still name a script; the trusted API for a
 * runtime-chosen script is `Head({ script: [{ src }] })`, which is documented as
 * an explicit trust decision.
 */
const SCRIPT_SOURCE_ATTRIBUTES = new Set(["src", "href", "xlink:href", "type", "language"]);

/**
 * SVG animation elements. Their `to` / `from` / `by` / `values` attributes write
 * into whatever attribute `attributeName` names — so `attributeName` decides
 * whether those values are inert numbers or a link destination.
 */
const SVG_ANIMATION_ELEMENTS = new Set(["animate", "set", "animateMotion", "animateTransform", "animateColor"]);

/**
 * `<meta>` elements whose REFRESH-RELEVANT state is reactive: a live binding
 * has written `http-equiv` or `content` (any casing).
 *
 * A browser processes a refresh directive when the element is inserted (and,
 * in some engines, when those attributes change while connected), and removing
 * the element afterwards is not a defined cancellation. A binding that could
 * later need to withdraw a directive therefore must never be allowed to hold
 * one — even a safe one, because the question is reversibility rather than
 * safety.
 *
 * WHY ONLY THOSE TWO ATTRIBUTES. Whether a `<meta>` is a refresh directive, and
 * where it points, is a function of `http-equiv` and `content` and nothing
 * else — the HTML pragma processing reads no other attribute. A reactive
 * `data-state`, `name` or `id` can therefore neither create a directive nor
 * change its destination: the directive stays exactly the static one the
 * policy already approved, and a document declaratively refreshes at most once
 * however often an engine re-processes it. Claiming on such bindings withdrew a
 * perfectly static, approved directive merely because an unrelated attribute
 * was live, which protected nothing.
 *
 * `Head()` keeps the broader rule — any reactive attribute in an entry
 * withholds a refresh — for a reason specific to it: it republishes an entry by
 * SWAPPING in a fresh element, so every reactive change re-inserts the
 * directive. The DOM writers mutate the element in place. See
 * `utils/headEntry.ts` § "NATIVE REFRESH DIRECTIVES MUST BE STATIC".
 *
 * Membership is permanent for the element's lifetime: the WeakSet never keeps
 * an element alive, and "was once reactive" is exactly the state that cannot
 * be withdrawn.
 */
const reactiveMetaElements = new WeakSet<Element>();

function isHtmlNamespace(el: Element): boolean {
  return el.namespaceURI === HTML_NS || el.namespaceURI === null;
}

/**
 * The attribute map `el` would have after `setAttribute(canonical, value)`.
 *
 * Keyed by the RAW attribute names already on the element, so a foreign
 * duplicate spelling (`HTTP-EQUIV` created through `setAttributeNS`) survives
 * into the snapshot, where `resolveMetaRefreshPolicy` rejects it rather than
 * guessing which spelling the browser honours. The pending write replaces the
 * attribute whose name is exactly the canonical one — which is precisely what
 * `setAttribute` on an HTML element does.
 */
function metaSnapshot(el: Element, canonical: string | null, value: string | null): Map<string, string> {
  const snapshot = new Map<string, string>();
  const attrs = el.attributes;
  for (let i = 0; i < attrs.length; i++) {
    const attr = attrs[i];
    if (attr.name === canonical) continue;
    snapshot.set(attr.name, attr.value);
  }
  if (canonical !== null && value !== null) snapshot.set(canonical, value);
  return snapshot;
}

/**
 * Record that `el`'s refresh-relevant state is reactive, and withdraw any
 * refresh directive it already holds — from server markup, from a static prop
 * written a moment earlier, or from anything else. After this call the element
 * can never hold a directive again. See {@link reactiveMetaElements}.
 */
function claimReactiveMeta(el: Element): void {
  if (reactiveMetaElements.has(el)) return;
  reactiveMetaElements.add(el);
  if (el.getAttribute("content") === null) return;
  if (resolveMetaRefreshPolicy(metaSnapshot(el, null, null)).kind !== "not-refresh") {
    el.removeAttribute("content");
  }
}

function metaRefusal(el: Element, name: string, value: string | null, origin: AttributeWriteOrigin): ContextualRefusal {
  if (!isHtmlNamespace(el)) return ContextualRefusal.None;

  const canonical = canonicalAttrName(name);
  // Any other attribute cannot participate in a refresh directive, so it is
  // neither judged nor allowed to claim the element. See `reactiveMetaElements`.
  if (canonical !== "http-equiv" && canonical !== "content") return ContextualRefusal.None;
  // Claimed BEFORE the value is judged — and even when the write is a removal —
  // so a reactive binding owns the element from its first run, whatever order
  // it and the static attributes arrive in.
  if (origin === "reactive") claimReactiveMeta(el);
  // Removing either half of a directive can never create one.
  if (value === null) return ContextualRefusal.None;
  // Fast path for the overwhelmingly common `<meta name=… content=…>`: with no
  // `http-equiv` attribute there is no directive to judge. `hasAttribute`
  // matches exactly the attribute the browser honours (an HTML element's
  // lowercase `http-equiv`); a foreign `HTTP-EQUIV` spelling created through
  // `setAttributeNS` is not one the browser reads either.
  if (canonical === "content" && !el.hasAttribute("http-equiv")) return ContextualRefusal.None;

  const decision = resolveMetaRefreshPolicy(metaSnapshot(el, canonical, value));
  if (decision.kind === "forbidden") return ContextualRefusal.MetaRefreshForbidden;
  if (decision.kind !== "not-refresh" && reactiveMetaElements.has(el)) return ContextualRefusal.MetaRefreshReactive;
  return ContextualRefusal.None;
}

function animationRefusal(name: string, value: string | null): ContextualRefusal {
  if (value === null || canonicalAttrName(name) !== "attributename") return ContextualRefusal.None;
  // Conservative reading: every character a parser might ignore is removed, so
  // ` href` / `hr\tef` cannot slip past a comparison the browser would not make.
  const target = stripControlChars(value);
  return isUrlAttribute(target) || isEventHandlerAttr(target) || isHtmlContentAttribute(target)
    ? ContextualRefusal.AnimationTarget
    : ContextualRefusal.None;
}

/**
 * The contextual verdict for ONE pending attribute write.
 *
 * @param el     The element the write targets, in its CURRENT state.
 * @param name   The attribute name as the writer will pass it.
 * @param value  The exact string the writer will commit, or `null` for removal.
 * @param origin Where the value came from; see {@link AttributeWriteOrigin}.
 * @returns `ContextualRefusal.None` (`0`) when the write may proceed, otherwise
 *          the code of the rule that refuses it. The caller must not perform a
 *          refused write.
 */
export function contextualAttributeRefusal(
  el: Element,
  name: string,
  value: string | null,
  origin: AttributeWriteOrigin,
): ContextualRefusal {
  const local = el.localName;
  if (local === "meta") return metaRefusal(el, name, value, origin);
  if (local === "script") {
    if (origin === "static" || value === null) return ContextualRefusal.None;
    return SCRIPT_SOURCE_ATTRIBUTES.has(canonicalAttrName(name))
      ? ContextualRefusal.ScriptSource
      : ContextualRefusal.None;
  }
  if (SVG_ANIMATION_ELEMENTS.has(local) && el.namespaceURI === SVG_NS) return animationRefusal(name, value);
  return ContextualRefusal.None;
}

/**
 * Would serializing this `<meta>` attribute map publish a refresh directive the
 * shared policy forbids?
 *
 * For the SSR serializer, which receives DOM it did not necessarily build — a
 * node created by application code or a third-party library never passed
 * through the framework's writers. Delegates to the same authority as every
 * other path.
 */
export function isForbiddenMetaSnapshot(attributes: ReadonlyMap<string, string>): boolean {
  return resolveMetaRefreshPolicy(attributes).kind === "forbidden";
}
