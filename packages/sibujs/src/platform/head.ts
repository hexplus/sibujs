import { registerDisposer } from "@sibujs/core";
import { effect } from "@sibujs/core";
import { isEventHandlerAttr, sanitizeUrl, stripControlChars } from "@sibujs/core/internal";

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
// `isDangerousMetaRefresh()` at the meta-tag writing site.
const HEAD_URL_ATTRS = new Set(["href", "src"]);
function sanitizeHeadAttr(key: string, value: string): string {
  if (HEAD_URL_ATTRS.has(key)) return sanitizeUrl(value);
  return value;
}

/**
 * Detect `<meta http-equiv="refresh" content="0;url=javascript:...">`.
 * Returns true if the meta props describe a refresh directive whose URL
 * uses a dangerous protocol.
 */
function isDangerousRefreshContent(content: string): boolean {
  const normalized = stripControlChars(content).toLowerCase();
  return (
    normalized.includes("url=javascript:") ||
    normalized.includes("url=data:") ||
    normalized.includes("url=vbscript:") ||
    normalized.includes("url=blob:")
  );
}

/** Case-insensitive lookup of a meta attribute value (HTML attr names are CI). */
function getMetaAttr(
  metaProps: Record<string, string | (() => string)>,
  name: string,
): string | (() => string) | undefined {
  for (const k in metaProps) {
    if (k.toLowerCase() === name) return metaProps[k];
  }
  return undefined;
}

function isDangerousMetaRefresh(metaProps: Record<string, string | (() => string)>): boolean {
  const httpEquiv = getMetaAttr(metaProps, "http-equiv");
  if (typeof httpEquiv !== "string") return false;
  if (httpEquiv.toLowerCase() !== "refresh") return false;
  const content = getMetaAttr(metaProps, "content");
  if (typeof content !== "string") return false;
  return isDangerousRefreshContent(content);
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

interface HeadProps {
  title?: string | (() => string);
  meta?: Record<string, string | (() => string)>[];
  link?: Record<string, string>[];
  script?: Record<string, string>[];
  base?: { href?: string; target?: string };
}

/**
 * Head() manages document <head> tags reactively.
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

    // Title
    if (props.title) {
      if (typeof props.title === "function") {
        const cleanupFn = effect(() => {
          document.title = (props.title as () => string)();
        });
        effectCleanups.push(cleanupFn);
      } else {
        document.title = props.title;
      }
    }

    // Meta tags — keys validated, URL-bearing values sanitized, and
    // dangerous `http-equiv="refresh"` directives dropped entirely.
    if (props.meta) {
      for (const metaProps of props.meta) {
        if (isDangerousMetaRefresh(metaProps)) continue;
        // A `http-equiv="refresh"` meta with a reactive (or function) content
        // can carry a `javascript:`/`data:` redirect that the static guard
        // above never saw. `http-equiv` itself may be reactive, so resolve it
        // freshly each time `content` is written rather than caching a verdict
        // that could desync if http-equiv later becomes "refresh".
        const httpEquiv = getMetaAttr(metaProps, "http-equiv");
        const isRefreshNow = (): boolean => {
          const eq = typeof httpEquiv === "function" ? (httpEquiv as () => string)() : httpEquiv;
          return typeof eq === "string" && eq.toLowerCase() === "refresh";
        };
        const el = document.createElement("meta");
        for (const [key, value] of Object.entries(metaProps)) {
          if (!isSafeHeadAttr(key)) continue;
          const isContent = key.toLowerCase() === "content";
          if (typeof value === "function") {
            const cleanupFn = effect(() => {
              const resolved = (value as () => string)();
              if (isContent && isRefreshNow() && isDangerousRefreshContent(resolved)) {
                el.removeAttribute(key);
                return;
              }
              el.setAttribute(key, sanitizeHeadAttr(key, resolved));
            });
            effectCleanups.push(cleanupFn);
          } else {
            if (isContent && isRefreshNow() && isDangerousRefreshContent(value)) continue;
            el.setAttribute(key, sanitizeHeadAttr(key, value));
          }
        }
        document.head.appendChild(el);
        managedElements.push(el);
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
    if (props.base) {
      const existing = document.head.querySelector("base");
      if (existing) existing.remove();
      const el = document.createElement("base");
      if (props.base.href) {
        const safeHref = sanitizeUrl(props.base.href);
        if (safeHref) el.href = safeHref;
      }
      if (props.base.target) el.target = props.base.target;
      document.head.appendChild(el);
      managedElements.push(el);
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
