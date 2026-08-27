import { registerDisposer } from "../core/rendering/dispose";
import { effect } from "../core/signals/effect";
import { acquireBase, acquireTitle, type BaseSpec, type ResourceLease } from "../utils/documentResources";
import { normalizeMetaAttributes, resolveMetaRefreshPolicy } from "../utils/metaRefresh";
import { isEventHandlerAttr, sanitizeUrl } from "../utils/sanitize";

// ============================================================================
// HEAD COMPONENT - Meta tag management for SEO
// ============================================================================
//
// Security: all URL-bearing attributes (href/src, and meta `content`
// when it carries a URL like og:image) are routed through `sanitizeUrl`
// to block `javascript:` / `data:` / `vbscript:` / `blob:` URIs. The base
// tag's `href` is also sanitized — overlooking it previously meant an
// attacker-controlled base href could rewrite every relative URL on the
// page to a javascript: URI.

// Only `href` and `src` are treated as URL slots. `content` is free text
// for most meta tags (description, keywords, og:title, etc.) and running
// it through `sanitizeUrl` would strip legitimate whitespace. The one
// truly dangerous `content` form — `<meta http-equiv="refresh"
// content="0;url=javascript:...">` — is filtered separately by
// `resolveMetaRefreshPolicy()` — the shared client/SSR policy — which parses
// the directive structurally instead of substring-matching it.
const HEAD_URL_ATTRS = new Set(["href", "src"]);
function sanitizeHeadAttr(key: string, value: string): string {
  if (HEAD_URL_ATTRS.has(key)) return sanitizeUrl(value);
  return value;
}

/** Strict attribute-name validation — blocks injection via crafted keys. */
const SAFE_HEAD_ATTR_NAME = /^[A-Za-z_:][-A-Za-z0-9_.:]*$/;

function isSafeHeadAttr(name: string): boolean {
  if (!SAFE_HEAD_ATTR_NAME.test(name)) return false;
  if (isEventHandlerAttr(name)) return false;
  return true;
}

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
 * Render ONE meta entry, transactionally.
 *
 * WHY ONE EFFECT PER ENTRY
 * ------------------------
 * The previous implementation created one effect per reactive ATTRIBUTE, so
 * every write was judged on its own. That lets the combination become dangerous
 * while no individual write ever looks wrong:
 *
 *     { "http-equiv": () => equiv(), content: "0;url=javascript:alert(1)" }
 *
 * With `equiv()` initially `"x-custom"` the entry is not a refresh directive, so
 * the static content is accepted. `setEquiv("refresh")` then re-runs only the
 * `http-equiv` effect — the content is never revalidated, and the element is now
 * a live redirect that nothing ever approved.
 *
 * Security decisions are properties of the WHOLE entry, so the whole entry is
 * the unit of work: one effect resolves every attribute, validates the assembled
 * snapshot, and only then reconciles the element. Nothing is committed on the
 * strength of a verdict about a different snapshot.
 *
 * Returns a teardown that stops the effect and removes the element.
 */
function applyMetaEntry(
  metaProps: Record<string, string | (() => string)>,
  managedElements: HTMLElement[],
): () => void {
  const el = document.createElement("meta");
  let attached = false;

  const attach = (): void => {
    if (attached) return;
    document.head.appendChild(el);
    managedElements.push(el);
    attached = true;
  };

  const detach = (): void => {
    if (!attached) return;
    el.remove();
    const index = managedElements.indexOf(el);
    if (index !== -1) managedElements.splice(index, 1);
    attached = false;
  };

  const stopEffect = effect(() => {
    // 1. Resolve EVERY attribute — static and reactive — into one snapshot.
    //    Reading all getters here is also what subscribes this single effect to
    //    all of them, so any change re-runs the whole validation.
    const resolved: Record<string, string> = {};
    for (const [key, value] of Object.entries(metaProps)) {
      if (!isSafeHeadAttr(key)) continue;
      resolved[key] = typeof value === "function" ? String((value as () => string)()) : String(value);
    }

    // 2. Fold case-insensitive duplicates. `null` means the entry carries two
    //    spellings of one attribute, where the value validated would not be the
    //    value the browser honours — so the entry is refused outright.
    const normalized = normalizeMetaAttributes(resolved);
    if (normalized === null) {
      detach();
      return;
    }

    // 3. Judge the assembled snapshot, never a partial one.
    if (resolveMetaRefreshPolicy(normalized).kind === "forbidden") {
      // Detach rather than merely skipping the write: an element already in the
      // head would otherwise stay live with its previous — now unapproved —
      // attributes, and a detached element must not be counted as active.
      detach();
      return;
    }

    // 4. Reconcile from the validated snapshot: drop attributes that no longer
    //    exist, then write the ones that do. Append-only `setAttribute` would
    //    strand a removed attribute on the element.
    for (const existing of Array.from(el.attributes)) {
      if (!(existing.name in resolved)) el.removeAttribute(existing.name);
    }
    for (const [key, value] of Object.entries(resolved)) {
      const safe = sanitizeHeadAttr(key, value);
      if (el.getAttribute(key) !== safe) el.setAttribute(key, safe);
    }

    attach();
  });

  return () => {
    stopEffect();
    detach();
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
 * against the shared meta-refresh policy before anything reaches the DOM. A
 * snapshot that fails validation detaches the element entirely rather than
 * blanking an attribute, so a dangerous `http-equiv`/`content` pair can never be
 * live. See `utils/metaRefresh.ts`; the same policy governs SSR.
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

    // Link tags — keys validated, URL attributes sanitized.
    if (props.link) {
      for (const linkProps of props.link) {
        const el = document.createElement("link");
        for (const [key, value] of Object.entries(linkProps)) {
          if (!isSafeHeadAttr(key)) continue;
          el.setAttribute(key, sanitizeHeadAttr(key, value));
        }
        document.head.appendChild(el);
        managedElements.push(el);
      }
    }

    // Script tags — same validation posture. Note: inline script bodies
    // are never written here; only the `src` attribute is used, and it
    // passes through `sanitizeUrl`.
    if (props.script) {
      for (const scriptProps of props.script) {
        const el = document.createElement("script");
        for (const [key, value] of Object.entries(scriptProps)) {
          if (!isSafeHeadAttr(key)) continue;
          el.setAttribute(key, sanitizeHeadAttr(key, value));
        }
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
  link.href = sanitizeUrl(url);
}
