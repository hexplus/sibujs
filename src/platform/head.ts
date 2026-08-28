import { registerDisposer } from "../core/rendering/dispose";
import { effect } from "../core/signals/effect";
import { acquireBase, acquireTitle, type BaseSpec, type ResourceLease } from "../utils/documentResources";
import {
  type HeadValueResolver,
  planHeadElementEntry,
  planMetaEntry,
  STATIC_VALUE_RESOLVER as STATIC_HEAD_RESOLVER,
} from "../utils/headEntry";
import { sanitizeUrl } from "../utils/sanitize";

// ============================================================================
// HEAD COMPONENT - Meta tag management for SEO
// ============================================================================
//
// Security: every URL-bearing attribute is routed through the CANONICAL
// `sanitizeUrl` protocol allowlist — `http:`, `https:`, `mailto:`, `tel:`,
// `ftp:`, and relative URLs — and a value it refuses is OMITTED rather than
// published as an empty substitute. The `<base>` tag's `href` is sanitized too:
// overlooking it previously meant an attacker-controlled base href could rewrite
// every relative URL on the page into a javascript: URI.

// `content` is deliberately NOT a URL slot: it is free text for most meta tags
// (description, keywords, og:title, …) and running it through `sanitizeUrl`
// would strip legitimate whitespace. The one truly dangerous `content` form —
// `<meta http-equiv="refresh" content="0;url=javascript:...">` — is filtered by
// `planMetaEntry()`, which parses the directive structurally instead of
// substring-matching it.
//
// Every other classification — which names are URL sinks, which are event
// handlers, which the browser parses as nested HTML — lives in
// `utils/headEntry.ts` and is keyed on the CANONICAL (ASCII-lower-cased)
// attribute name. `head.ts` used to carry a private `Set(["href", "src"])` and
// test it against the authored spelling, so `Head({ script: [{ SRC: "data:…" }] })`
// skipped sanitization entirely while both SSR paths refused the same value.

/**
 * Escape a JSON string for safe embedding inside a `<script>` tag. Matches
 * the implementation in `platform/ssr.ts#escapeScriptJson` — duplicated
 * here so `head.ts` does not need to pull in the full SSR module.
 */
function escapeScriptJsonLocal(json: string): string {
  return json
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * How `Head()` turns an authored value into a string.
 *
 * This is the ONLY thing `Head()` contributes to the shared pipeline — the
 * client has reactive getters to invoke and the servers do not, and that is the
 * entire difference between them. Name canonicalization, eligibility, URL
 * sanitization, duplicate detection, the empty-entry rule, and the meta-refresh
 * verdict all live in `utils/headEntry.ts`, so the three rendering paths have
 * nothing left to disagree about.
 */
const CLIENT_RESOLVER: HeadValueResolver<string | (() => string)> = {
  resolveValue: (_name, value) => (typeof value === "function" ? String(value()) : String(value)),
  isReactiveValue: (value) => typeof value === "function",
};

/**
 * Render ONE meta entry, transactionally.
 *
 * WHY ONE EFFECT PER ENTRY
 * ------------------------
 * An earlier implementation created one effect per reactive ATTRIBUTE, so every
 * write was judged on its own. That lets the combination become dangerous while
 * no individual write ever looks wrong:
 *
 *     { "http-equiv": () => equiv(), content: "0;url=javascript:alert(1)" }
 *
 * With `equiv()` initially `"x-custom"` the entry is not a refresh directive, so
 * the static content is accepted. `setEquiv("refresh")` then re-runs only the
 * `http-equiv` effect — the content is never revalidated, and the element is now
 * a live redirect that nothing ever approved.
 *
 * Security decisions are properties of the WHOLE entry, so the whole entry is
 * the unit of work: one effect resolves every attribute and `planMetaEntry`
 * judges the assembled snapshot.
 *
 * WHY THE ELEMENT IS BUILT DETACHED AND SWAPPED IN
 * -----------------------------------------------
 * Validating a whole snapshot is not enough if the snapshot is then applied to a
 * CONNECTED element one attribute at a time. Reconciling
 *
 *     http-equiv="x-custom"  content="0;url=javascript:alert(1)"   (old, connected)
 *
 * into the perfectly valid
 *
 *     http-equiv="refresh"   content="5;url=/safe"                 (new, approved)
 *
 * writes `http-equiv="refresh"` while the element still carries the old content,
 * so for the duration of one `setAttribute` the document contains a live
 * `<meta http-equiv="refresh" content="0;url=javascript:alert(1)">`. Nothing
 * approved that pair; it exists only because two safe states were interpolated
 * through the DOM. Ordering the writes differently would only move the hole —
 * attribute order is not a security mechanism.
 *
 * So an accepted snapshot is materialised on a FRESH element while it is
 * detached, and published with a single `replaceWith()` (or `appendChild()` when
 * nothing is attached yet). Every intermediate state is unobservable because it
 * never touches the document.
 *
 * Returns a teardown that stops the effect and removes the published element.
 */
function applyMetaEntry(
  metaProps: Record<string, string | (() => string)>,
  managedElements: HTMLElement[],
): () => void {
  /** The element currently published for this entry, if any. */
  let current: HTMLMetaElement | null = null;

  /** Withdraw the entry entirely: nothing in the document, nothing counted. */
  const retract = (): void => {
    if (!current) return;
    const index = managedElements.indexOf(current);
    if (index !== -1) managedElements.splice(index, 1);
    current.remove();
    current = null;
  };

  /** Is `attributes` already exactly what is published? */
  const alreadyPublished = (attributes: ReadonlyMap<string, string>): boolean => {
    if (!current || current.attributes.length !== attributes.size) return false;
    for (const [name, value] of attributes) {
      if (current.getAttribute(name) !== value) return false;
    }
    return true;
  };

  /** Publish an approved snapshot in ONE DOM operation. */
  const publish = (attributes: ReadonlyMap<string, string>): void => {
    if (alreadyPublished(attributes)) return;

    const next = document.createElement("meta");
    for (const [name, value] of attributes) next.setAttribute(name, value);

    const index = current ? managedElements.indexOf(current) : -1;
    if (current?.parentNode) {
      current.replaceWith(next);
    } else {
      // Never attached, or removed from under us — either way there is nothing
      // to swap, so append.
      current?.remove();
      document.head.appendChild(next);
    }

    // Update the managed reference in the same step, so disposal always removes
    // the element that is actually live and never leaks the one it replaced.
    if (index !== -1) managedElements[index] = next;
    else managedElements.push(next);
    current = next;
  };

  const stopEffect = effect(() => {
    // Resolving every attribute here is also what subscribes this single effect
    // to all of them, so any change re-runs the whole validation.
    const plan = planMetaEntry(metaProps, CLIENT_RESOLVER);
    if (plan.kind === "drop") {
      // Withdraw rather than merely skipping the write: an element already in
      // the head would otherwise stay live with its previous — now unapproved —
      // attributes.
      retract();
      return;
    }
    publish(plan.attributes);
  });

  return () => {
    stopEffect();
    retract();
  };
}

interface HeadProps {
  title?: string | (() => string);
  meta?: Record<string, string | (() => string)>[];
  link?: Record<string, string>[];
  script?: Record<string, string>[];
  base?: { href?: string; target?: string };
}

/**
 * Head() manages document <head> tags reactively.
 *
 * META SECURITY: each meta entry is committed TRANSACTIONALLY. All of its
 * attributes — static and reactive — are resolved into one snapshot, duplicate
 * case-insensitive names are rejected, and the assembled snapshot is validated
 * against the shared meta-refresh policy before anything reaches the DOM. An
 * approved snapshot is then materialised on a fresh `<meta>` element while it is
 * still detached and swapped in with a single `replaceWith()`, so no partially
 * updated element is ever connected. A snapshot that fails validation withdraws
 * the element entirely. See `utils/metaRefresh.ts`; the same policy governs SSR.
 *
 * NATIVE REFRESH DIRECTIVES MUST BE STATIC. A browser processes a meta refresh
 * when the element is INSERTED — it records the pending navigation there and
 * then, and removing or replacing the element afterwards is not a defined way to
 * cancel it. `Head()` therefore never publishes a snapshot whose effective
 * `http-equiv` is `refresh` from an entry that contains any reactive attribute,
 * even when the destination is allowed: what cannot be withdrawn must not be
 * handed over. Static refresh directives work as before, and every other
 * reactive meta entry — description, keywords, Open Graph, non-refresh
 * `http-equiv` — is unaffected.
 *
 * Supports dynamic title, meta tags, link tags, and structured data.
 * Each instance tracks its own elements and effects for independent cleanup.
 */
export function Head(props: HeadProps): Comment {
  const anchor = document.createComment("sibu-head");
  const managedElements: HTMLElement[] = [];
  const effectCleanups: Array<() => void> = [];

  // Cleanup this instance's managed elements and effects
  const cleanup = () => {
    for (const el of managedElements) {
      if (el.parentNode) el.parentNode.removeChild(el);
    }
    managedElements.length = 0;
    for (const cleanupFn of effectCleanups) cleanupFn();
    effectCleanups.length = 0;
  };

  const apply = () => {
    cleanup();

    // Title — a GLOBAL singleton, leased from the shared owner stack rather
    // than assigned. Assigning meant a Head never gave the title back on
    // dispose (the page kept a title belonging to an unmounted component) and
    // that overlapping Heads/`title()` calls silently overwrote each other.
    if (props.title) {
      if (typeof props.title === "function") {
        const getter = props.title as () => string;
        let lease: ResourceLease<string> | null = null;
        const stopEffect = effect(() => {
          const next = getter();
          if (lease) lease.set(next);
          else lease = acquireTitle(next);
        });
        effectCleanups.push(() => {
          stopEffect();
          lease?.release();
          lease = null;
        });
      } else {
        const lease = acquireTitle(props.title);
        effectCleanups.push(() => lease.release());
      }
    }

    // Meta tags — each entry is committed TRANSACTIONALLY. See `applyMetaEntry`.
    if (props.meta) {
      for (const metaProps of props.meta) {
        const stop = applyMetaEntry(metaProps, managedElements);
        effectCleanups.push(stop);
      }
    }

    // Link and script tags — the SAME shared plan the meta entries and both SSR
    // paths run, so `HREF`/`SRC` are classified on the canonical name and a
    // refused URL is omitted rather than published as `href=""`. Built fully
    // while detached, then appended, so no partially-populated element is ever
    // connected.
    //
    // Inline script bodies are never written here; only attributes are.
    for (const [tag, entries] of [
      ["link", props.link],
      ["script", props.script],
    ] as const) {
      if (!entries) continue;
      for (const entryProps of entries) {
        const plan = planHeadElementEntry(entryProps, STATIC_HEAD_RESOLVER);
        if (plan.kind === "drop") continue;
        const el = document.createElement(tag);
        for (const [name, value] of plan.attributes) el.setAttribute(name, value);
        document.head.appendChild(el);
        managedElements.push(el);
      }
    }

    // Base tag — href is sanitized. An attacker-controlled base href
    // could otherwise rewrite every relative URL on the page into a
    // `javascript:` URI, so this fix closes a significant XSS vector.
    //
    // Leased, not created-and-deleted. HTML honours only one <base>, so this is
    // a singleton resource: the previous code DELETED whatever base it found
    // (typically the server-rendered one) and, on cleanup, removed its own
    // without putting anything back — permanently changing how every relative
    // URL on the page resolved, for the rest of the session.
    if (props.base) {
      const spec: BaseSpec = {};
      if (props.base.href) {
        const safeHref = sanitizeUrl(props.base.href);
        if (safeHref) spec.href = safeHref;
      }
      if (props.base.target) spec.target = props.base.target;
      const lease = acquireBase(spec);
      effectCleanups.push(() => lease.release());
    }
  };

  apply();

  // Tie cleanup to the anchor so disposing the enclosing subtree (`dispose()`)
  // removes this instance's injected <head> elements and stops its title/meta
  // effects. Without this, every Head() leaked its elements + effects forever.
  registerDisposer(anchor, cleanup);

  return anchor;
}

/**
 * Sets structured data (JSON-LD) for SEO.
 *
 * Security: the serialized JSON is passed through `escapeScriptJsonLocal`
 * which unicode-escapes `<`, `>`, `&`, `U+2028`, and `U+2029`. This is
 * defense-in-depth: when the element is inserted via `document.createElement`
 * + `textContent` the browser will NOT re-parse the body, so `</script>`
 * cannot break out of the tag at insertion time. However, tools that
 * later serialize `document.head.innerHTML` DO re-parse, and the server
 * side of any SSR roundtrip would see the raw text. Escaping here makes
 * both paths safe.
 */
export function setStructuredData(data: Record<string, unknown>): void {
  // Remove existing structured data
  const existing = document.head.querySelector('script[type="application/ld+json"][data-sibu]');
  if (existing) existing.remove();

  const script = document.createElement("script");
  script.type = "application/ld+json";
  script.setAttribute("data-sibu", "true");
  script.textContent = escapeScriptJsonLocal(JSON.stringify(data));
  document.head.appendChild(script);
}

/**
 * Sets the canonical URL for the page.
 */
export function setCanonical(url: string): void {
  let link = document.head.querySelector('link[rel="canonical"]') as HTMLLinkElement;
  if (!link) {
    link = document.createElement("link");
    link.rel = "canonical";
    document.head.appendChild(link);
  }
  // A refused URL is OMITTED, never published as `href=""`. The two are not the
  // same document: an empty URL attribute resolves against the current page, so
  // `<link rel="canonical" href="">` declares the page canonical to itself,
  // which is a claim nobody made. Any previously accepted value is cleared too,
  // so a rejected update cannot leave a stale canonical standing.
  const safe = sanitizeUrl(url);
  if (safe) link.setAttribute("href", safe);
  else link.removeAttribute("href");
}
