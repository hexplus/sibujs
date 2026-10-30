// ============================================================================
// SERVER-SIDE RENDERING
// ============================================================================
//
// Security posture (see WORK_LOG.md § "SSR security hardening"):
//
//  - `renderToString` escapes attribute VALUES against both `"` and `'`,
//    validates attribute NAMES against a strict regex, drops all `on*`
//    event-handler attributes, and routes URL-bearing attributes
//    (href/src/action/formaction/...) through `sanitizeUrl` to block
//    `javascript:`, `data:`, `vbscript:`, and `blob:` URIs.
//  - `<script>` and `<style>` elements are never serialized directly —
//    their textContent is parsed as raw text by the HTML tokenizer and
//    would let any injected content execute. Use `renderToDocument`'s
//    `scripts` / `headExtra` options instead.
//  - HTML comment terminators (`-->`, `--!>`, `<!--`, trailing `--`) are
//    escaped inside both comment bodies and the SSR error comment to
//    prevent breakout.
//  - `serializeState` escapes `<`, `>`, `&`, and the ES line-terminator
//    pairs `U+2028` / `U+2029` which otherwise break out of JS string
//    literals on pre-ES2019 engines.
//  - `renderToDocument` validates meta/link/bodyAttrs keys against the
//    same strict attribute-name regex and sanitizes URL values.
//  - `suspenseSwapScript` requires IDs to match `[A-Za-z0-9_-]+` so the
//    id is safe in both a CSS attribute selector and a JS string literal
//    context. Violating IDs throw.
//  - `hydrateIslands` / `hydrateProgressively` use `hasOwnProperty.call`
//    to block prototype-pollution lookups on the islands map.

import { DEV } from "../core/dev";
import { dispose, replaceChildrenSafely } from "../core/rendering/dispose";
import { getSSRStore } from "../core/ssr-context";
import { isCodeTextElement, isForbiddenMetaSnapshot, isRefusedAnimationAttribute } from "../utils/elementPolicy";
import {
  type EmbedSerialization,
  embedSerializationTail,
  embedSerializedAttribute,
  getEmbedRecord,
} from "../utils/embedPolicy";
import { readOwnGlobal } from "../utils/guards";
import { serializeHeadEntry } from "../utils/headEntry";
import { isForbiddenMetaEntry } from "../utils/metaRefresh";
import { isEventHandlerAttr, isHtmlContentAttribute, resolveAttributeValue, sanitizeUrl } from "../utils/sanitize";

/**
 * Attributes the server must never emit at all.
 *
 * `srcdoc` is parsed by the browser as a nested HTML document, so escaping it
 * is the wrong layer entirely — `escapeAttr()` correctly produces
 * `srcdoc="&lt;script&gt;…"`, and the browser undoes that escaping before
 * parsing, yielding `<script>…` again. Omission is the only treatment that
 * holds, and it must hold identically in `renderToString`, the `renderToStream`
 * generator, and `buildAttrString`, or the documented render paths disagree
 * about what is safe.
 *
 * The rule itself lives in `utils/sanitize` so the client writers and the
 * server serializers cannot drift apart.
 */
function isForbiddenSsrAttr(lowerName: string): boolean {
  return isHtmlContentAttribute(lowerName);
}

// Attribute VALUES are resolved by `resolveAttributeValue` (utils/sanitize),
// the same "commit or omit" authority the client writers and `<head>` paths
// use: `srcset` parsed as a candidate list, `style` filtered per declaration,
// single-URL sinks through the protocol allowlist, and a refused value OMITTED.
// There are three attribute serializers here (`serializeOpenTag`, shared by
// `renderToString` and `renderToStream`, and `buildAttrString`), and each once
// carried its own inline rules. Rendering target is not a security boundary.

/** Strict attribute-name validation. HTML5 allows more, but this subset is sufficient for real elements and keeps attackers from smuggling `"`, `>`, `=`, or whitespace. */
const SAFE_ATTR_NAME = /^[A-Za-z_:][-A-Za-z0-9_.:]*$/;

function isSafeAttrName(name: string): boolean {
  return SAFE_ATTR_NAME.test(name);
}

/** Format an SSR error as an HTML comment. In production, omits the message to prevent information leakage. */
function ssrErrorComment(err: unknown): string {
  if (DEV) {
    const msg = escapeHtml(err instanceof Error ? err.message : String(err));
    return `<!--SSR error: ${safeCommentText(msg)}-->`;
  }
  return "<!--SSR error-->";
}

/** Strip every HTML comment terminator form so that embedded content cannot break out of `<!-- -->`. */
function safeCommentText(text: string): string {
  return text
    .replace(/-->/g, "--&gt;")
    .replace(/--!>/g, "--!&gt;")
    .replace(/<!--/g, "&lt;!--")
    .replace(/--$/g, "--&#45;");
}

const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

// ─── Clobber-proof DOM reads ────────────────────────────────────────────────

/**
 * Resolve the NATIVE accessor for `name`, walking up from `proto`.
 *
 * WHY: `<form>` elements expose their controls as named properties that SHADOW
 * the element's own API ([LegacyOverrideBuiltIns]). A rendered
 * `<input name="attributes">` makes `form.attributes` return that input, so a
 * serializer reading `element.attributes` emitted the form with no attributes
 * at all — `method="post"` and `action` gone, and a login form submitting by
 * GET before hydration. `name="childNodes"` emptied it, `name="tagName"` threw.
 * Control names routinely come from CMS or survey data, so the serializer reads
 * through the prototype accessors, which a named property cannot shadow.
 *
 * Falls back to the plain property when the DOM implementation defines none
 * (some server DOMs use own properties), where there is nothing to clobber.
 */
function findNativeGetter(proto: object | null, name: string): ((this: unknown) => unknown) | null {
  for (let p = proto; p; p = Object.getPrototypeOf(p)) {
    const get = Object.getOwnPropertyDescriptor(p, name)?.get;
    if (get) return get;
  }
  return null;
}

interface NativeDomAccessors {
  attributes: ((this: unknown) => unknown) | null;
  tagName: ((this: unknown) => unknown) | null;
  childNodes: ((this: unknown) => unknown) | null;
  getAttribute: (this: Element, name: string) => string | null;
}

/**
 * Accessors resolved PER REALM, keyed by the realm's `Element` constructor.
 *
 * A server that creates a fresh DOM window per request and swaps the globals
 * would otherwise keep calling getters taken from the FIRST window's
 * prototypes on nodes from every later one — which a DOM implementation that
 * brand-checks against its own realm rejects, or answers from the wrong
 * internals. Keyed on the same global `instanceof HTMLElement` reads on every
 * call, so the accessors always belong to the realm the node was checked
 * against. A WeakMap, so a discarded realm is not kept alive.
 */
const nativeAccessorsByRealm = new WeakMap<object, NativeDomAccessors>();

function nativeAccessors(): NativeDomAccessors {
  const realm = Element;
  let accessors = nativeAccessorsByRealm.get(realm);
  if (!accessors) {
    accessors = {
      attributes: findNativeGetter(Element.prototype, "attributes"),
      tagName: findNativeGetter(Element.prototype, "tagName"),
      childNodes: findNativeGetter(Node.prototype, "childNodes"),
      getAttribute: Element.prototype.getAttribute,
    };
    nativeAccessorsByRealm.set(realm, accessors);
  }
  return accessors;
}

function attributesOf(el: Element): NamedNodeMap {
  const get = nativeAccessors().attributes;
  return (get ? get.call(el) : el.attributes) as NamedNodeMap;
}

function tagNameOf(el: Element): string {
  const get = nativeAccessors().tagName;
  return (get ? get.call(el) : el.tagName) as string;
}

function childNodesOf(node: Node): NodeListOf<ChildNode> {
  const get = nativeAccessors().childNodes;
  return (get ? get.call(node) : node.childNodes) as NodeListOf<ChildNode>;
}

function getAttributeOf(el: Element, name: string): string | null {
  return nativeAccessors().getAttribute.call(el, name);
}

// ─── Foreign content (SVG, MathML) ──────────────────────────────────────────

const SVG_NS = "http://www.w3.org/2000/svg";
const MATHML_NS = "http://www.w3.org/1998/Math/MathML";
const XLINK_NS = "http://www.w3.org/1999/xlink";
const XML_NS = "http://www.w3.org/XML/1998/namespace";
const XMLNS_NS = "http://www.w3.org/2000/xmlns/";

/**
 * Where the HTML parser will be when it reads a serialized node: in HTML, or
 * inside SVG / MathML foreign content. The parser — not the DOM being
 * serialized — decides the namespace of every element it rebuilds, so the
 * serializer tracks the parser's state and emits only what the parser will
 * rebuild as the same element.
 */
enum ParseContext {
  /** HTML content: the document, an HTML element, or an integration point. */
  Html,
  /** Inside an SVG element that is not an HTML integration point. */
  Svg,
  /** Inside a MathML element that is not an integration point. */
  Math,
  /** Inside MathML `annotation-xml` without an HTML encoding: MathML, or an `<svg>` root. */
  Annotation,
}

/**
 * Start tags the HTML parser refuses to read as foreign content: inside SVG or
 * MathML they close every foreign element and continue as HTML, taking every
 * following sibling with them. `font` breaks out only with `color`, `face` or
 * `size`.
 */
const BREAKOUT_TAGS = new Set([
  "b",
  "big",
  "blockquote",
  "body",
  "br",
  "center",
  "code",
  "dd",
  "div",
  "dl",
  "dt",
  "em",
  "embed",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "head",
  "hr",
  "i",
  "img",
  "li",
  "listing",
  "menu",
  "meta",
  "nobr",
  "ol",
  "p",
  "pre",
  "ruby",
  "s",
  "small",
  "span",
  "strong",
  "strike",
  "sub",
  "sup",
  "table",
  "tt",
  "u",
  "ul",
  "var",
]);

function isBreakout(lowerName: string, element: Element): boolean {
  if (BREAKOUT_TAGS.has(lowerName)) return true;
  return (
    lowerName === "font" &&
    (element.hasAttribute("color") || element.hasAttribute("face") || element.hasAttribute("size"))
  );
}

/**
 * Will the HTML parser, in `context`, rebuild this element in the namespace it
 * has in the DOM? A foreign element outside foreign content, an HTML-named
 * foreign element inside it, or an HTML element directly inside foreign content
 * would come back as something else — an SVG-namespace `<meta>` or `<link>`,
 * inert in the client DOM and so never judged by the HTML contextual rules,
 * would become a live HTML one.
 */
function fitsParseContext(ns: string | null, lowerName: string, element: Element, context: ParseContext): boolean {
  if (ns === SVG_NS) {
    if (context === ParseContext.Svg) return !isBreakout(lowerName, element);
    return lowerName === "svg" && (context === ParseContext.Html || context === ParseContext.Annotation);
  }
  if (ns === MATHML_NS) {
    if (context === ParseContext.Math || context === ParseContext.Annotation) return !isBreakout(lowerName, element);
    return lowerName === "math" && context === ParseContext.Html;
  }
  return context === ParseContext.Html;
}

/** The parser's context for the children of an element it rebuilt. */
function childParseContext(ns: string | null, lowerName: string, element: Element): ParseContext {
  if (ns === SVG_NS) {
    // HTML integration points.
    return lowerName === "foreignobject" || lowerName === "desc" || lowerName === "title"
      ? ParseContext.Html
      : ParseContext.Svg;
  }
  if (ns === MATHML_NS) {
    // MathML text integration points read HTML start tags as HTML.
    if (lowerName === "mi" || lowerName === "mo" || lowerName === "mn" || lowerName === "ms" || lowerName === "mtext") {
      return ParseContext.Html;
    }
    if (lowerName === "annotation-xml") {
      const encoding = (element.getAttribute("encoding") ?? "").toLowerCase();
      return encoding === "text/html" || encoding === "application/xhtml+xml"
        ? ParseContext.Html
        : ParseContext.Annotation;
    }
    return ParseContext.Math;
  }
  return ParseContext.Html;
}

/**
 * The name a foreign element's attribute must be written with for the HTML
 * parser to rebuild it in the same namespace.
 *
 * In foreign content the parser maps exactly three prefixes back to their
 * namespaces (`xlink:`, `xml:`, `xmlns:`) and adjusts the case of the known
 * camelCase names (`viewBox`), so the qualified name is written as is — except
 * when `setAttributeNS` created the attribute without a prefix, where the
 * qualified name is just `href` and would come back in no namespace at all.
 */
function foreignAttrName(attr: Attr): string {
  const ns = attr.namespaceURI;
  if (ns === XLINK_NS) return `xlink:${attr.localName}`;
  if (ns === XML_NS) return `xml:${attr.localName}`;
  if (ns === XMLNS_NS) return attr.localName === "xmlns" ? "xmlns" : `xmlns:${attr.localName}`;
  return attr.name;
}

/**
 * Serialize an element's open tag — `<tag attr="…" …` without the closing `>`
 * — or return `null` when the element must not be emitted at all.
 *
 * THE single attribute serializer for server-emitted element trees, shared by
 * `renderToString` and `renderToStream`:
 *
 *   - names are validated, `on*` and `srcdoc` dropped, policy sinks sanitized
 *     through the same `sanitizeAttributeString` the client writers use;
 *   - a `<meta>` whose EMITTED attributes form a refresh directive the shared
 *     policy forbids is dropped whole, exactly as `renderToDocument`'s `meta`
 *     option and `Head()` drop such an entry. DOM built through the
 *     framework's writers can never reach this state; DOM built any other way
 *     (application code, a third-party library) could, and rendering target is
 *     not a security boundary.
 *   - on a `foreign` (SVG / MathML) element, names keep their case and their
 *     namespace prefix, and an SVG animation may not target a URL or handler
 *     attribute — its `attributeName` is omitted, as the client writers omit it.
 *   - an `<iframe>` built by `embed()` is re-judged against what `embed()`
 *     wrote (`embedSerializedAttribute`): only the attributes it writes (plus
 *     `id`, `class`, `style`, `width`, `height`, `data-*`, `aria-*`) are
 *     served, `src` must match the allowlist the frame was built under,
 *     `sandbox` / `allow` can only be narrower than what it wrote,
 *     `allowfullscreen` follows the served `allow`, and a frame without a
 *     non-blank `title` is not served — so a frame changed behind the
 *     framework's back is never served wider than `embed()` built it.
 */
/**
 * How a render path marks its output.
 * @internal
 */
export interface SerializeOptions {
  /**
   * Where `data-sibu-ssr="true"` goes: on every element (`renderToString`'s
   * historical output), on top-level elements only, or nowhere.
   */
  marker: "all" | "root" | "none";
  /** Adoption ids (`data-sibu-h`) of elements built under an adopt render. */
  ids: WeakMap<Element, string> | null;
}

const LEGACY_SERIALIZE: SerializeOptions = { marker: "all", ids: null };

function serializeOpenTag(
  element: Element,
  tag: string,
  foreign: boolean,
  opts: SerializeOptions,
  depth: number,
): string | null {
  let html = `<${tag}`;
  // Collected only for `<meta>`, and keyed by the emitted RAW names so the
  // shared policy can reject duplicate case-insensitive spellings itself.
  const meta = tag === "meta" && !foreign ? new Map<string, string>() : null;
  const embed = tag === "iframe" && !foreign ? getEmbedRecord(element) : undefined;
  const embedSeen: EmbedSerialization | null = embed
    ? { sandbox: false, referrer: false, title: false, fullscreen: false }
    : null;

  const attrs = attributesOf(element);
  for (let i = 0; i < attrs.length; i++) {
    const attr = attrs[i];
    const rawName = foreign ? foreignAttrName(attr) : attr.name;
    if (!isSafeAttrName(rawName)) continue;
    if (isEventHandlerAttr(rawName)) continue;
    if (isForbiddenSsrAttr(rawName)) continue;

    // The shared "commit or omit" authority — `null` drops the attribute.
    const lowerName = rawName.toLowerCase();
    let value = resolveAttributeValue(lowerName, attr.value);
    if (value === null) continue;
    if (foreign && isRefusedAnimationAttribute(element, rawName, value)) continue;
    if (embed && embedSeen) {
      value = embedSerializedAttribute(embed, embedSeen, lowerName, value);
      if (value === null) continue;
    }

    meta?.set(rawName, value);
    html += ` ${rawName}="${escapeAttr(value)}"`;
  }

  if (meta && isForbiddenMetaSnapshot(meta)) return null;

  if (embed && embedSeen) {
    const tail = embedSerializationTail(embed, embedSeen);
    if (tail === null) return null;
    html += tail;
  }

  // Adoption id: the client claims this element by it (see hydrate "adopt").
  const hid = opts.ids?.get(element);
  if (hid !== undefined) html += ` data-sibu-h="${hid}"`;

  // The SSR provenance marker. `dataset.sibuHydrate` was read through the
  // clobberable `dataset` property; the attribute it reflects is read directly.
  if (
    (opts.marker === "all" || (opts.marker === "root" && depth === 0)) &&
    !getAttributeOf(element, "data-sibu-hydrate")
  ) {
    html += ` data-sibu-ssr="true"`;
  }

  return html;
}

/** An element that is emitted with children: its open tag, close tag, the children to walk and their context. */
interface ElementFrame {
  open: string;
  close: string;
  children: ChildNode[];
  context: ParseContext;
}

/**
 * Serialize one node's own markup, shared by `renderToString` and
 * `renderToStream` so the two documented render paths cannot drift.
 *
 * Returns the complete markup for anything with nothing beneath it to walk
 * (text, a comment, a void or empty foreign element, a stripped element), or
 * the frame of an element whose children the caller serializes.
 *
 * HTML elements are emitted with lower-cased tag names and the HTML void rules.
 * SVG and MathML elements are emitted by local name with their case intact
 * (`linearGradient`, `foreignObject`), and an empty one self-closes
 * (`<path … />`), which the HTML parser honours in foreign content. Any other
 * node is emitted as its escaped text.
 *
 * An element the parser would rebuild in another namespace in `context` is
 * stripped with its subtree (see {@link fitsParseContext}).
 */
function serializeNode(
  node: Node,
  context: ParseContext,
  opts: SerializeOptions = LEGACY_SERIALIZE,
  depth = 0,
): string | ElementFrame {
  if (node.nodeType === 3) return escapeHtml(node.textContent || "");
  // Comment node — escape every comment-terminator form.
  if (node.nodeType === 8) return `<!--${safeCommentText(node.textContent || "")}-->`;

  let foreign = false;
  if (!(node instanceof HTMLElement)) {
    const ns = node.nodeType === 1 ? (node as Element).namespaceURI : null;
    if (ns !== SVG_NS && ns !== MATHML_NS) return escapeHtml(node.textContent || "");
    foreign = true;
  }
  const element = node as Element;
  // A foreign element's `localName` drops any prefix (`svg:path`) the HTML
  // parser would not understand, and SVG / MathML elements have no named
  // properties that could shadow it.
  const tag = foreign ? element.localName : tagNameOf(element).toLowerCase();

  // Never serialize code-text elements — their contents bypass HTML
  // escaping and would execute if injected data is present. Scripts and
  // styles must be added via `renderToDocument`'s dedicated options. SVG has
  // both elements too; the check is case-insensitive.
  if (isCodeTextElement(tag)) return DEV ? `<!--ssr:${tag}-stripped-->` : "";

  // Defense-in-depth: reject tags with unexpected characters.
  if (!/^[a-z][a-z0-9-]*$/i.test(tag)) return DEV ? "<!--ssr:invalid-tag-->" : "";

  const ns = foreign ? element.namespaceURI : null;
  const lowerName = tag.toLowerCase();
  if (!fitsParseContext(ns, lowerName, element, context)) return DEV ? `<!--ssr:${tag}-misplaced-->` : "";

  const openTag = serializeOpenTag(element, tag, foreign, opts, depth);
  if (openTag === null) return DEV ? `<!--ssr:${tag}-stripped-->` : "";

  const children = childNodesOf(element);
  if (foreign ? children.length === 0 : VOID_ELEMENTS.has(tag)) return `${openTag} />`;
  return {
    open: `${openTag}>`,
    close: `</${tag}>`,
    children: Array.from(children),
    context: childParseContext(ns, lowerName, element),
  };
}

// ─── renderToString ─────────────────────────────────────────────────────────

/**
 * Converts an element tree to an HTML string for server-side rendering.
 * HTML, SVG and MathML elements are serialized; SVG and MathML keep the case
 * of their tag and attribute names and their `xlink:` / `xml:` prefixes.
 *
 * Security: attribute names are validated, `on*` handlers are dropped,
 * URL-bearing attributes are routed through `sanitizeUrl`, attribute
 * values are escaped against both `"` and `'`, and an SVG animation may not
 * target a URL or handler attribute. `<script>` and `<style>` tags are
 * stripped from the serialized output.
 */
export function renderToString(element: HTMLElement | DocumentFragment | Node): string {
  return renderNodeToString(element, ParseContext.Html, LEGACY_SERIALIZE, 0);
}

/**
 * `renderToString` with explicit marker options — the async renderers' entry.
 * @internal
 */
export function renderToStringWith(element: Node, opts: SerializeOptions): string {
  return renderNodeToString(element, ParseContext.Html, opts, 0);
}

function renderNodeToString(element: Node, context: ParseContext, opts: SerializeOptions, depth: number): string {
  if (element instanceof DocumentFragment) {
    return Array.from(element.childNodes)
      .map((child) => {
        try {
          return renderNodeToString(child, context, opts, depth);
        } catch (err) {
          return ssrErrorComment(err);
        }
      })
      .join("");
  }

  const frame = serializeNode(element, context, opts, depth);
  if (typeof frame === "string") return frame;

  let html = frame.open;
  for (const child of frame.children) {
    try {
      html += renderNodeToString(child, frame.context, opts, depth + 1);
    } catch (err) {
      html += ssrErrorComment(err);
    }
  }
  return html + frame.close;
}

// ─── hydrate ────────────────────────────────────────────────────────────────

export interface HydrateOptions {
  /**
   * Enable dev-mode hydration diagnostics. When true, the walker
   * compares the server-rendered tree against the client tree and
   * logs the first tag mismatch, attribute difference, or child count
   * mismatch to the console. Disabled by default.
   */
  diagnostics?: boolean;
  /**
   * Called for each detected mismatch instead of the default console
   * warning. Useful for routing diagnostics to a telemetry system.
   */
  onMismatch?: (report: HydrationMismatch) => void;
}

export interface HydrationMismatch {
  kind: "tag" | "attribute" | "child-count" | "text";
  path: string;
  serverValue: string;
  clientValue: string;
  message: string;
}

/**
 * Activates a server-rendered SibuJS application by building the live client
 * tree and **replacing** the inert server-rendered subtree with it.
 *
 * SibuJS uses replacement hydration rather than DOM adoption: the server markup
 * is discarded, not attached to. It is not the case that listeners and bindings
 * are wired onto the existing server nodes — reactive bindings belong to the
 * nodes `component()` produced, and adopting server nodes would leave the
 * visible DOM permanently frozen.
 *
 * Consequences worth knowing before deploying SSR:
 *
 *  - DOM node identity is not preserved.
 *  - Pre-hydration user input, checkbox state, and focus are discarded.
 *  - Conversely, partial-adoption mismatch bugs are avoided by this design —
 *    the client tree is always authoritative.
 *
 * Re-hydrating the same container disposes the previous client tree first.
 *
 * When `options.diagnostics` is true, the walker reports the first
 * server/client mismatch it finds. This is a dev-mode tool — pass
 * `diagnostics: false` (or omit it) in production.
 *
 * @see docs/architecture/hydration.md
 */
export function hydrate(component: () => HTMLElement, container: HTMLElement, options: HydrateOptions = {}): void {
  const clientTree = component();

  if (options.diagnostics) {
    const mismatches: HydrationMismatch[] = [];
    collectMismatches(container.firstElementChild as HTMLElement | null, clientTree, "", mismatches);
    if (mismatches.length > 0) {
      const first = mismatches[0];
      if (options.onMismatch) {
        options.onMismatch(first);
      } else if (DEV) {
        console.warn(
          `[SibuJS hydration] ${first.message}\n  at ${first.path}\n  server: ${first.serverValue}\n  client: ${first.clientValue}`,
        );
      }
    }
  }

  // Replace the server-rendered subtree with the client tree so that all
  // reactive bindings created by `component()` actually drive the visible
  // DOM. In-place attribute reconciliation cannot adopt those bindings —
  // they remain wired to the client subtree, so leaving the server DOM in
  // place would silently freeze updates.
  // Route through replaceChildrenSafely rather than a bare replaceChildren:
  // on a re-hydration the outgoing children are a SibuJS-owned client tree
  // whose bindings, listeners and lifecycle hooks must be torn down. A native
  // replace would detach them unreachable and leak. First-time hydration is
  // unaffected — inert server markup has nothing to dispose.
  replaceChildrenSafely(container, clientTree);
  container.setAttribute("data-sibu-hydrated", "true");
}

// hydrateNode was the in-place reconciler used before the replace-strategy
// fix. Both `hydrate()` and `hydrateProgressively()` now use replaceChildren/
// replaceWith because in-place attr copy can't adopt reactive bindings on
// the server tree. Function intentionally removed — kept this comment for
// future readers grepping for it.

/**
 * Walk two DOM trees in lock-step and collect the first mismatches.
 * Stops early after the first `max` mismatches to avoid log spam.
 * This is opt-in — running it on a large tree has non-zero cost.
 */
/**
 * Concatenated direct text-node children of `node`, whitespace-normalised.
 *
 * Only *direct* children, so text owned by a descendant element is attributed
 * to that descendant rather than reported twice. Normalising whitespace avoids
 * false positives from HTML source formatting.
 */
function directTextOf(node: HTMLElement): string {
  let out = "";
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3 /* TEXT_NODE */) out += child.nodeValue ?? "";
  }
  return out.replace(/\s+/g, " ").trim();
}

/** Dispose a SibuJS-owned node, then swap `next` into its place. */
function disposeAndReplace(outgoing: HTMLElement, next: Node): void {
  dispose(outgoing);
  outgoing.replaceWith(next);
}

function collectMismatches(
  serverNode: HTMLElement | null,
  clientNode: HTMLElement | null,
  path: string,
  out: HydrationMismatch[],
  max = 5,
): void {
  if (out.length >= max) return;
  const nodePath = path || clientNode?.tagName?.toLowerCase() || "(root)";

  if (!serverNode && clientNode) {
    out.push({
      kind: "child-count",
      path: nodePath,
      serverValue: "(missing)",
      clientValue: clientNode.tagName.toLowerCase(),
      message: "Client rendered a node that the server did not emit.",
    });
    return;
  }
  if (serverNode && !clientNode) {
    out.push({
      kind: "child-count",
      path: nodePath,
      serverValue: serverNode.tagName.toLowerCase(),
      clientValue: "(missing)",
      message: "Server rendered a node that the client did not produce.",
    });
    return;
  }
  if (!serverNode || !clientNode) return;

  // Tag mismatch — stop descending since structure diverges.
  if (serverNode.tagName !== clientNode.tagName) {
    out.push({
      kind: "tag",
      path: nodePath,
      serverValue: serverNode.tagName.toLowerCase(),
      clientValue: clientNode.tagName.toLowerCase(),
      message: "Element tag mismatch — server and client disagree on the element type.",
    });
    return;
  }

  // Attribute diff — ignore sibujs-internal markers that only exist on one side.
  const skipAttrs = new Set(["data-sibu-ssr", "data-sibu-hydrated", "data-sibu-island"]);
  const serverAttrs = new Map<string, string>();
  for (const a of Array.from(serverNode.attributes)) {
    if (!skipAttrs.has(a.name)) serverAttrs.set(a.name, a.value);
  }
  const clientAttrs = new Map<string, string>();
  for (const a of Array.from(clientNode.attributes)) {
    if (!skipAttrs.has(a.name)) clientAttrs.set(a.name, a.value);
  }

  for (const [name, value] of serverAttrs) {
    if (out.length >= max) return;
    if (!clientAttrs.has(name)) {
      out.push({
        kind: "attribute",
        path: `${nodePath}[${name}]`,
        serverValue: value,
        clientValue: "(missing)",
        message: `Attribute "${name}" present on server but missing on client.`,
      });
    } else if (clientAttrs.get(name) !== value) {
      out.push({
        kind: "attribute",
        path: `${nodePath}[${name}]`,
        serverValue: value,
        clientValue: clientAttrs.get(name) ?? "",
        message: `Attribute "${name}" differs between server and client.`,
      });
    }
  }
  for (const [name, value] of clientAttrs) {
    if (out.length >= max) return;
    if (!serverAttrs.has(name)) {
      out.push({
        kind: "attribute",
        path: `${nodePath}[${name}]`,
        serverValue: "(missing)",
        clientValue: value,
        message: `Attribute "${name}" present on client but missing on server.`,
      });
    }
  }

  // Direct text content. Compared before descending so a leaf whose text
  // differs is reported once, at the node that owns the text, rather than
  // being silently skipped — text divergence is the most common real-world
  // mismatch (server and client disagreeing on data).
  const serverText = directTextOf(serverNode);
  const clientText = directTextOf(clientNode);
  if (serverText !== clientText) {
    out.push({
      kind: "text",
      path: nodePath,
      serverValue: serverText,
      clientValue: clientText,
      message: "Text content differs between server and client.",
    });
    if (out.length >= max) return;
  }

  // Descend into children. We only descend through element children —
  // per-text-node diffs would be noisy, so the aggregate check above covers
  // text divergence instead.
  const serverChildren = Array.from(serverNode.children) as HTMLElement[];
  const clientChildren = Array.from(clientNode.children) as HTMLElement[];
  const max2 = Math.max(serverChildren.length, clientChildren.length);
  for (let i = 0; i < max2; i++) {
    if (out.length >= max) return;
    const childPath = `${nodePath} > ${clientChildren[i]?.tagName?.toLowerCase() ?? serverChildren[i]?.tagName?.toLowerCase() ?? "?"}:nth-child(${i + 1})`;
    collectMismatches(serverChildren[i] ?? null, clientChildren[i] ?? null, childPath, out, max);
  }
}

// ─── Trusted HTML ────────────────────────────────────────────────────────────

/**
 * Branded type for raw HTML that has been explicitly marked as trusted.
 * Use `trustHTML()` to create a value of this type. This prevents
 * accidental injection of unsanitized user input into `headExtra`.
 */
export type TrustedHTML = string & { readonly __brand: "TrustedHTML" };

/**
 * Mark an HTML string as trusted for use in contexts that accept raw HTML
 * (e.g. `renderToDocument({ headExtra })`). Only call this on
 * developer-controlled strings — never on user input.
 *
 * @example
 * ```ts
 * const extra = trustHTML('<link rel="preconnect" href="https://fonts.googleapis.com">');
 * renderToDocument(App, { headExtra: extra });
 * ```
 */
export function trustHTML(html: string): TrustedHTML {
  return html as TrustedHTML;
}

// ─── renderToDocument ───────────────────────────────────────────────────────

/**
 * Build a set of `key="value"` pairs for emission into an HTML open tag.
 * Rejects unsafe attribute names, drops `on*` event handlers, and routes
 * URL-bearing keys through `sanitizeUrl`.
 */
function buildAttrString(
  attrs: Record<string, string> | undefined,
  { allowEventHandlers = false }: { allowEventHandlers?: boolean } = {},
): string {
  if (!attrs) return "";
  const out: string[] = [];
  for (const rawKey of Object.keys(attrs)) {
    if (!Object.hasOwn(attrs, rawKey)) continue;
    if (!isSafeAttrName(rawKey)) continue;
    if (!allowEventHandlers && isEventHandlerAttr(rawKey)) continue;
    if (isForbiddenSsrAttr(rawKey)) continue;
    const value = resolveAttributeValue(rawKey.toLowerCase(), String(attrs[rawKey]));
    if (value === null) continue;
    out.push(`${rawKey}="${escapeAttr(value)}"`);
  }
  return out.join(" ");
}

/**
 * Should this meta entry be dropped entirely?
 *
 * Delegates to the SHARED meta-refresh policy. This used to be a private copy
 * of four `includes()` checks that happened to match the client's private copy
 * — two implementations of one rule, so a fix to either would silently diverge
 * from the other. The exported name is kept for back-compat; the policy is no
 * longer local.
 *
 * Returns true for a forbidden refresh directive AND for an entry carrying
 * duplicate case-insensitive attribute names, since there the value validated
 * would not be the value the browser ends up honouring.
 */
export function isDangerousMetaRefresh(metaProps: Record<string, string>): boolean {
  return isForbiddenMetaEntry(metaProps);
}

/**
 * Renders a component to a full HTML document string.
 *
 * `headExtra` requires a `TrustedHTML` value created via `trustHTML()`.
 * This prevents accidental injection of unsanitized user input.
 *
 * Security: meta/link/bodyAttrs keys are validated against
 * `SAFE_ATTR_NAME` (rejecting crafted keys that would break out of the
 * attribute context). URL attributes in meta/link/scripts/bodyAttrs pass
 * through `sanitizeUrl`. The page `title` is HTML-escaped.
 */
/** Document options shared by `renderToDocument` and `renderToDocumentAsync`. */
export interface DocumentOptions {
  title?: string;
  meta?: Record<string, string>[];
  links?: Record<string, string>[];
  /**
   * External script URLs appended to `<body>`. Each passes the scheme
   * allowlist; an allowed URL is still code that runs with the page's
   * authority, so this option is an explicit trust decision — first-party
   * or pinned URLs only, never request-derived values.
   */
  scripts?: string[];
  bodyAttrs?: Record<string, string>;
  /**
   * Raw HTML injected into `<head>`. Must be wrapped in `trustHTML()`
   * to confirm the content is developer-controlled.
   */
  headExtra?: TrustedHTML;
}

export function renderToDocument(component: () => HTMLElement, options: DocumentOptions = {}): string {
  let content: string;
  try {
    content = renderToString(component());
  } catch (err) {
    content = ssrErrorComment(err);
  }
  return assembleDocument(content, options, "", "");
}

/**
 * The document `renderToDocument` emits, around already-rendered `content`.
 * `head` and `bodyEnd` are framework-generated markup (collected head tags,
 * the transfer script), escaped by their producers.
 * @internal
 */
export function assembleDocument(content: string, options: DocumentOptions, head: string, bodyEnd: string): string {
  // Names filtered, values sanitized, duplicate casings rejected, and dangerous
  // `<meta http-equiv="refresh" content="0;url=javascript:...">` entries dropped
  // — all by the one shared pipeline the client also runs.
  const metaTags = (options.meta || [])
    .map((attrs) => serializeHeadEntry("meta", attrs))
    .filter(Boolean)
    .join("\n    ");

  const linkTags = (options.links || [])
    .map((attrs) => serializeHeadEntry("link", attrs))
    .filter(Boolean)
    .join("\n    ");

  const scriptTags = (options.scripts || [])
    .map((src) => {
      const safe = sanitizeUrl(String(src));
      if (!safe) return "";
      return `<script src="${escapeAttr(safe)}"></script>`;
    })
    .filter(Boolean)
    .join("\n    ");

  const bodyAttrPairs = buildAttrString(options.bodyAttrs);
  const bodyAttrs = bodyAttrPairs ? ` ${bodyAttrPairs}` : "";

  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    ${options.title != null ? `<title>${escapeHtml(options.title)}</title>` : ""}
    ${metaTags}
    ${linkTags}
    ${options.headExtra || ""}${
      head
        ? `
    ${head}`
        : ""
    }
  </head>
  <body${bodyAttrs}>
    <div id="app">${content}</div>${
      bodyEnd
        ? `
    ${bodyEnd}`
        : ""
    }
    ${scriptTags}
  </body>
</html>`;
}

// ─── Streaming SSR ──────────────────────────────────────────────────────────

/**
 * Renders a component tree to an async iterable of HTML chunks.
 * Enables progressive server-side rendering — the consumer can write
 * each chunk to a response stream as it becomes available.
 *
 * Same security posture as `renderToString`.
 */
export function renderToStream(element: HTMLElement | DocumentFragment | Node): AsyncGenerator<string> {
  return streamNode(element, ParseContext.Html);
}

async function* streamNode(element: Node, context: ParseContext): AsyncGenerator<string> {
  if (element instanceof DocumentFragment) {
    for (const child of Array.from(element.childNodes)) {
      try {
        yield* streamNode(child, context);
      } catch (err) {
        yield ssrErrorComment(err);
      }
    }
    return;
  }

  // The SAME node serializer `renderToString` uses — attribute policy,
  // meta-refresh verdict, foreign-content rules and the SSR provenance marker
  // included. The two documented render paths used to carry two copies of this
  // logic, which is the shape that lets them drift; someone streaming in
  // production while snapshotting with renderToString in tests would never see
  // the difference.
  const frame = serializeNode(element, context);
  if (typeof frame === "string") {
    if (frame) yield frame;
    return;
  }

  yield frame.open;

  for (const child of frame.children) {
    try {
      yield* streamNode(child, frame.context);
    } catch (err) {
      yield ssrErrorComment(err);
    }
  }

  yield frame.close;
}

/**
 * Collects the full output of renderToStream into a string.
 */
export async function collectStream(stream: AsyncGenerator<string> | AsyncIterable<string>): Promise<string> {
  let result = "";
  for await (const chunk of stream) {
    result += chunk;
  }
  return result;
}

// ─── ReadableStream Adapter ──────────────────────────────────────────────────

/**
 * Renders a component tree to a Web `ReadableStream<string>`.
 *
 * Uses pull-based backpressure — chunks are produced on demand.
 *
 * **Environment.** Supported on SibuJS's declared Node runtime (`>=22.3.0`) and
 * on any other environment providing both the Web Streams API *and* a DOM
 * implementation. Streaming SSR requires the same server DOM as every other
 * SibuJS SSR API: this function takes real `Node` objects and walks them, so a
 * DOM-less runtime cannot produce the input, let alone render it. Do not read
 * "returns a Web stream" as "runs anywhere Web streams exist".
 *
 * **Semantics.** Suspense boundaries encountered during the walk are resolved
 * as a batch before the affected chunk is emitted — the shell is not flushed
 * ahead of individually-completing boundaries. See
 * `docs/architecture/ssr.md` for the precise streaming and failure semantics.
 */
export function renderToReadableStream(element: HTMLElement | DocumentFragment | Node): ReadableStream<string> {
  const generator = renderToStream(element);

  return new ReadableStream<string>({
    async pull(controller) {
      const { value, done } = await generator.next();
      if (done) {
        controller.close();
      } else {
        controller.enqueue(value);
      }
    },
    async cancel() {
      await generator.return(undefined);
    },
  });
}

// ─── Partial / Selective Hydration (Islands) ────────────────────────────────

/**
 * Marks an element as a hydration island. During partial hydration
 * only elements marked with `data-sibu-island` will be hydrated.
 */
/** Allowlist for island ids — they appear in attribute selectors and object lookups. */
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

export function island(id: string, component: () => HTMLElement): HTMLElement {
  if (!SAFE_ID.test(id)) {
    throw new Error(`[SibuJS SSR] island: id must match [A-Za-z0-9_-]+ (got: ${JSON.stringify(id.slice(0, 32))})`);
  }
  const el = component();
  el.setAttribute("data-sibu-island", id);
  return el;
}

/**
 * Hydrate only elements marked as islands (`data-sibu-island`).
 * Non-island content keeps its server-rendered HTML untouched.
 *
 * Security: uses `hasOwnProperty.call` to guard against prototype-pollution
 * lookups (e.g. an island id of `__proto__` must not resolve to `Object.prototype`).
 */
/**
 * Has this island already been activated by some hydration pass?
 *
 * `data-sibu-hydrated` is the authoritative marker and every hydration entry
 * point must consult it — including the one that wrote it. A hydrated client
 * tree deliberately KEEPS its `data-sibu-island` attribute so consumers can
 * re-query it, which means marker-blind candidate selection re-finds live
 * islands and replaces them, destroying their state and listeners.
 */
function isAlreadyHydrated(element: Element): boolean {
  return element.hasAttribute("data-sibu-hydrated");
}

export function hydrateIslands(container: HTMLElement, islands: Record<string, () => HTMLElement>): void {
  const markers = container.querySelectorAll("[data-sibu-island]");
  for (const marker of Array.from(markers)) {
    if (isAlreadyHydrated(marker)) continue;
    const id = marker.getAttribute("data-sibu-island") ?? "";
    if (!Object.hasOwn(islands, id)) continue;
    const factory = islands[id];
    if (typeof factory !== "function") continue;

    const clientTree = factory();
    // Preserve island marker so consumers can re-query and so progressive
    // hydration loops don't re-process already-hydrated islands.
    (clientTree as HTMLElement).setAttribute("data-sibu-island", id);
    (clientTree as HTMLElement).setAttribute("data-sibu-hydrated", "true");
    disposeAndReplace(marker as HTMLElement, clientTree);
  }
  container.setAttribute("data-sibu-hydrated", "partial");
}

/**
 * Progressively hydrate islands only when they enter the viewport.
 * Uses IntersectionObserver to defer hydration of off-screen islands,
 * reducing initial JavaScript execution cost.
 *
 * Returns a cleanup function that disconnects all observers.
 */
export function hydrateProgressively(
  container: HTMLElement,
  islands: Record<string, () => HTMLElement>,
  options?: IntersectionObserverInit,
): () => void {
  const markers = container.querySelectorAll("[data-sibu-island]");
  const cleanups: Array<() => void> = [];

  for (const marker of Array.from(markers)) {
    if (isAlreadyHydrated(marker)) continue;
    const id = marker.getAttribute("data-sibu-island") ?? "";
    if (!Object.hasOwn(islands, id)) continue;
    const factory = islands[id];
    if (typeof factory !== "function") continue;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            // Disconnect first: if factory() throws, the observer must still be
            // torn down, otherwise it stays live and re-fires the failing
            // hydration on every subsequent intersection (leak + repeat error).
            observer.disconnect();
            // Re-check at EXECUTION time, not only at discovery: the observer
            // fires asynchronously, so another hydration pass may have
            // activated this island while this trigger was pending.
            //
            // Two ways that shows up. The marker may have gained the hydrated
            // attribute; or — because activation REPLACES the marker node — the
            // node this observer captured may already be the detached original,
            // in which case the live island is a different element carrying the
            // attribute and this one has no parent. Hydrating a detached node
            // would build a second island nobody can see and leak it.
            if (isAlreadyHydrated(marker) || marker.parentNode === null) break;
            const clientTree = factory();
            // Replace strategy: same fix as `hydrate()` — in-place attribute
            // copy leaves reactive bindings wired to the orphan client tree
            // and the visible DOM never updates. Preserve the island marker
            // + data-sibu-hydrated for downstream re-queries.
            (clientTree as HTMLElement).setAttribute("data-sibu-island", id);
            (clientTree as HTMLElement).setAttribute("data-sibu-hydrated", "true");
            disposeAndReplace(marker as HTMLElement, clientTree);
            break;
          }
        }
      },
      { rootMargin: "200px", ...options },
    );

    observer.observe(marker as HTMLElement);
    cleanups.push(() => observer.disconnect());
  }

  container.setAttribute("data-sibu-hydrated", "progressive");

  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}

// ─── SSR Suspense Streaming ──────────────────────────────────────────────────

/**
 * Reset SSR state between requests. Call at the start of each SSR render
 * to prevent ID drift in long-lived server processes.
 *
 * When running inside `runInSSRContext`, each request already owns its
 * own counter via AsyncLocalStorage — this hook only touches the
 * module-global fallback used outside that context.
 */
export function resetSSRState(): void {
  getSSRStore().suspenseIdCounter = 0;
}

/** No-op used as a .catch handler to prevent unhandledRejection. */
function noop(): void {}

/**
 * Create a suspense boundary for SSR streaming.
 * Renders fallback HTML inline and returns a promise for the resolved content.
 *
 * The returned element contains the fallback UI with a `data-sibu-suspense-id`
 * marker. The promise resolves to `{ id, html }` once async content is ready.
 *
 * The promise never rejects. Any failure to produce the content HTML — the
 * content factory throwing synchronously, its promise rejecting, the timeout,
 * or rendering the resolved element throwing — resolves it with the fallback
 * HTML, so the stream still produces a deterministic swap payload.
 */
export function ssrSuspense(props: {
  fallback: () => HTMLElement;
  content: () => Promise<HTMLElement>;
  /** Milliseconds before the content promise is rejected. Defaults to 30000. */
  timeoutMs?: number;
}): {
  element: HTMLElement;
  promise: Promise<{ id: string; html: string }>;
} {
  const store = getSSRStore();
  const id = `sibu-sus-${store.suspenseIdCounter++}`;
  const timeoutMs = props.timeoutMs ?? 30_000;

  const fallbackEl = props.fallback();
  const wrapper = document.createElement("div");
  wrapper.setAttribute("data-sibu-suspense-id", id);
  wrapper.appendChild(fallbackEl);

  const fallbackHtml = renderToString(fallbackEl);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<HTMLElement>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`[SibuJS SSR] ssrSuspense timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  // Evaluate the content factory inside a guard. Passing `props.content()`
  // straight to Promise.race() let a synchronous throw escape ssrSuspense()
  // itself — crashing the request — while an async rejection of the same
  // content became fallback output. `Promise.resolve` also contains a thenable
  // whose `then` getter throws (it becomes a rejection).
  let contentPromise: Promise<HTMLElement>;
  try {
    contentPromise = Promise.resolve(props.content());
  } catch (err) {
    contentPromise = Promise.reject(err);
  }

  const toFallback = (err: unknown) => {
    // Emit the fallback HTML on timeout/error so the stream still
    // produces a deterministic swap payload instead of hanging.
    if (DEV) console.warn("[SibuJS SSR] ssrSuspense rejected:", err);
    return { id, html: fallbackHtml };
  };
  // `!== undefined`: a timer handle of 0 is a real handle and must be cleared.
  const clearTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
  };

  const raced = Promise.race([contentPromise, timeoutPromise]);
  const promise = raced.then(
    (resolvedEl) => {
      clearTimer();
      try {
        return { id, html: renderToString(resolvedEl) };
      } catch (err) {
        return toFallback(err);
      }
    },
    (err) => {
      clearTimer();
      return toFallback(err);
    },
  );

  // Prevent unhandledRejection when the caller never awaits the promise.
  promise.catch(noop);

  return { element: wrapper, promise };
}

/** Allowlist for suspense IDs. They appear in both HTML attribute selectors and JS string literals — restricting to `[A-Za-z0-9_-]` removes every injection vector in one step. */
const SAFE_SUSPENSE_ID = /^[A-Za-z0-9_-]+$/;

/**
 * Generate an inline script that swaps a suspense fallback with resolved content.
 *
 * Security: the `id` is validated against a strict allowlist. Values that
 * do not match throw, so an attacker-controlled id cannot inject context
 * breakers into the selector or the JS string. `ssrSuspense()`'s internal
 * generator always produces allowlist-safe ids.
 */
export function suspenseSwapScript(id: string, nonce?: string): string {
  if (!SAFE_SUSPENSE_ID.test(id)) {
    throw new Error(
      `[SibuJS SSR] suspenseSwapScript: id must match [A-Za-z0-9_-]+ (got: ${JSON.stringify(id.slice(0, 32))})`,
    );
  }
  const nonceAttr = nonce ? ` nonce="${escapeAttr(nonce)}"` : "";
  return (
    `<script${nonceAttr}>(function(){` +
    `var t=document.getElementById("sibu-resolved-${id}");` +
    `var f=document.querySelector('[data-sibu-suspense-id="${id}"]');` +
    // Clear the fallback FIRST, then move the resolved nodes in. Appending
    // without clearing left the loading UI sitting above the real content
    // (ST-004). Node moves rather than innerHTML, to avoid DOM-based XSS.
    // Idempotent: a second execution finds no payload (`t`) and does nothing.
    "if(t&&f){while(f.firstChild)f.removeChild(f.firstChild);" +
    "while(t.firstChild)f.appendChild(t.firstChild);" +
    `t.remove();f.removeAttribute("data-sibu-suspense-id");}` +
    "})()</script>"
  );
}

/**
 * Renders a component tree with suspense boundaries as a stream.
 * Yields the main tree HTML first (including fallback content for suspended
 * boundaries), then flushes resolved content with inline swap scripts.
 *
 * Supports an optional `nonce` that is propagated to the resolved-content
 * swap scripts so the stream works with strict CSP.
 */
export async function* renderToSuspenseStream(
  element: HTMLElement | DocumentFragment | Node,
  pendingBoundaries: Promise<{ id: string; html: string }>[] = [],
  options?: { nonce?: string },
): AsyncGenerator<string> {
  yield* renderToStream(element);

  if (pendingBoundaries.length > 0) {
    const resolved = await Promise.all(pendingBoundaries);
    for (const { id, html } of resolved) {
      // Drop any boundary whose id fails the allowlist — never emit
      // attacker-controlled attribute content into the stream.
      if (!SAFE_SUSPENSE_ID.test(id)) continue;
      yield `<div hidden id="sibu-resolved-${id}">${html}</div>`;
      yield suspenseSwapScript(id, options?.nonce);
    }
  }
}

// ─── SSR Data Serialization ─────────────────────────────────────────────────

const SSR_DATA_ATTR = "__SIBU_SSR_DATA__";

/**
 * Escape a JSON string for safe embedding inside a `<script>` tag. This
 * goes beyond the usual `</script>` concern:
 *
 *  - `<`, `>`, `&` are unicode-escaped so nothing inside a string literal
 *    can close the script tag or start a new one.
 *  - `U+2028` (LINE SEPARATOR) and `U+2029` (PARAGRAPH SEPARATOR) are
 *    unicode-escaped. Before ES2019 these were illegal inside a JS string
 *    literal, so including them verbatim would cause a SyntaxError on
 *    older engines and could break out of string context.
 */
export function escapeScriptJson(json: string): string {
  return json
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * Serialize application state into an HTML script tag for SSR.
 * The serialized data is embedded in the document and picked up
 * on the client with `deserializeState()`.
 *
 * Security: the serialized JSON is escaped against `<`/`>`/`&` so nothing
 * can close the `<script>` tag, plus `U+2028` / `U+2029` which otherwise
 * break out of string literals on pre-ES2019 engines. Supports a `nonce`
 * attribute so the script is compatible with strict CSP.
 */
/** Default maximum size of a serialized SSR payload (1 MB). */
const DEFAULT_MAX_SSR_BYTES = 1024 * 1024;

/** A window global name `serializeState` may assign: an identifier, nothing else. */
const SAFE_GLOBAL_NAME = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export function serializeState(
  state: Record<string, unknown>,
  nonce?: string,
  options?: {
    maxBytes?: number;
    /**
     * The window global to assign (default `__SIBU_SSR_DATA__`). Must be a
     * plain identifier; anything else throws.
     */
    global?: string;
  },
): string {
  const globalName = options?.global ?? SSR_DATA_ATTR;
  if (!SAFE_GLOBAL_NAME.test(globalName)) {
    throw new Error(`[SibuJS SSR] serializeState: global must be an identifier (got: ${JSON.stringify(globalName)})`);
  }
  const rawJson = JSON.stringify(state);
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_SSR_BYTES;
  // Count bytes, not characters — multibyte strings still count correctly.
  const byteLen =
    typeof TextEncoder !== "undefined"
      ? new TextEncoder().encode(rawJson).byteLength
      : Buffer.byteLength(rawJson, "utf8");
  if (byteLen > maxBytes) {
    throw new Error(`[SibuJS SSR] serializeState: payload (${byteLen} bytes) exceeds maxBytes (${maxBytes})`);
  }
  const json = escapeScriptJson(rawJson);
  const nonceAttr = nonce ? ` nonce="${escapeAttr(nonce)}"` : "";
  return `<script${nonceAttr}>window.${globalName}=${json}</script>`;
}

/**
 * Retrieve state that was embedded by `serializeState()` during SSR.
 *
 * When a `validate` function is provided, it acts as a type guard —
 * only data that passes validation is returned. This prevents
 * tampered SSR payloads from being trusted by the client.
 *
 * @param validate Optional type guard to verify data integrity
 */
export function deserializeState<T = Record<string, unknown>>(validate?: (data: unknown) => data is T): T | undefined {
  if (typeof window === "undefined") return undefined;
  if (DEV && !validate) {
    console.warn(
      "[SibuJS SSR] deserializeState() called without a validate guard — tampered SSR payloads will not be detected.",
    );
  }
  // Own property only: `window[SSR_DATA_ATTR]` also answers with an element
  // whose id is that name, which user content can render. See `readOwnGlobal`.
  const raw = readOwnGlobal(SSR_DATA_ATTR);
  if (raw === undefined) return undefined;
  if (validate && !validate(raw)) return undefined;
  return raw as T;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
