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

import { isDev } from "../core/dev";
import { getSSRStore } from "../core/ssr-context";
import { sanitizeUrl } from "../utils/sanitize";

const _isDev = isDev();

/** Strict attribute-name validation. HTML5 allows more, but this subset is sufficient for real elements and keeps attackers from smuggling `"`, `>`, `=`, or whitespace. */
const SAFE_ATTR_NAME = /^[A-Za-z_:][-A-Za-z0-9_.:]*$/;

function isSafeAttrName(name: string): boolean {
  return SAFE_ATTR_NAME.test(name);
}

/** Is this attribute an `on*` event handler? The framework never emits these through real DOM attributes, so seeing one during SSR is a smell. */
function isEventHandlerAttr(name: string): boolean {
  if (name.length < 3) return false;
  const lower = name.toLowerCase();
  return lower[0] === "o" && lower[1] === "n" && lower.charCodeAt(2) >= 97 && lower.charCodeAt(2) <= 122;
}

/**
 * Attribute names whose value is a URL and therefore require
 * `sanitizeUrl()` before emission. Missing any of these would allow a
 * `javascript:` / `data:` / `vbscript:` / `blob:` URI to reach the browser
 * as raw HTML.
 */
const URL_ATTRS = new Set([
  "href",
  "src",
  "action",
  "formaction",
  "cite",
  "poster",
  "background",
  "srcset",
  "ping",
  "manifest",
  "data",
  "xlink:href",
]);

/** Format an SSR error as an HTML comment. In production, omits the message to prevent information leakage. */
function ssrErrorComment(err: unknown): string {
  if (_isDev) {
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

// ─── renderToString ─────────────────────────────────────────────────────────

/**
 * Converts an HTMLElement tree to an HTML string for server-side rendering.
 *
 * Security: attribute names are validated, `on*` handlers are dropped,
 * URL-bearing attributes are routed through `sanitizeUrl`, and attribute
 * values are escaped against both `"` and `'`. `<script>` and `<style>`
 * tags are stripped from the serialized output.
 */
export function renderToString(element: HTMLElement | DocumentFragment | Node): string {
  if (element instanceof DocumentFragment) {
    return Array.from(element.childNodes)
      .map((child) => {
        try {
          return renderToString(child);
        } catch (err) {
          return ssrErrorComment(err);
        }
      })
      .join("");
  }

  if (element.nodeType === 3) {
    // Text node
    return escapeHtml(element.textContent || "");
  }

  if (element.nodeType === 8) {
    // Comment node — escape every comment-terminator form.
    return `<!--${safeCommentText(element.textContent || "")}-->`;
  }

  if (!(element instanceof HTMLElement)) {
    return escapeHtml(element.textContent || "");
  }

  const tag = element.tagName.toLowerCase();

  // Never serialize raw-text elements — their contents bypass HTML
  // escaping and would execute if injected data is present. Scripts and
  // styles must be added via `renderToDocument`'s dedicated options.
  if (tag === "script" || tag === "style") {
    return _isDev ? `<!--ssr:${tag}-stripped-->` : "";
  }

  // Defense-in-depth: reject tags with unexpected characters.
  if (!/^[a-z][a-z0-9-]*$/i.test(tag)) {
    return _isDev ? "<!--ssr:invalid-tag-->" : "";
  }

  let html = `<${tag}`;

  for (const attr of Array.from(element.attributes)) {
    const rawName = attr.name;
    if (!isSafeAttrName(rawName)) continue;
    if (isEventHandlerAttr(rawName)) continue;

    const lowerName = rawName.toLowerCase();
    let value = attr.value;

    if (URL_ATTRS.has(lowerName)) {
      value = sanitizeUrl(value);
      if (!value) continue; // sanitizeUrl returned empty — drop the attribute entirely
    }

    html += ` ${rawName}="${escapeAttr(value)}"`;
  }

  if (element.dataset && !element.dataset.sibuHydrate) {
    html += ` data-sibu-ssr="true"`;
  }

  if (VOID_ELEMENTS.has(tag)) {
    return `${html} />`;
  }

  html += ">";

  for (const child of Array.from(element.childNodes)) {
    try {
      html += renderToString(child);
    } catch (err) {
      html += ssrErrorComment(err);
    }
  }

  html += `</${tag}>`;
  return html;
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
 * Hydrates a server-rendered DOM tree by attaching event listeners
 * and activating reactive bindings.
 *
 * When `options.diagnostics` is true, the walker reports the first
 * server/client mismatch it finds. This is a dev-mode tool — pass
 * `diagnostics: false` (or omit it) in production.
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
      } else if (_isDev) {
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
  container.replaceChildren(clientTree);
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

  // Descend into children. We only descend through element children —
  // text-node diffs would be noisy to report in the default walk.
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
    const lowerKey = rawKey.toLowerCase();
    let value = String(attrs[rawKey]);
    if (URL_ATTRS.has(lowerKey)) {
      value = sanitizeUrl(value);
      if (!value) continue;
    }
    out.push(`${rawKey}="${escapeAttr(value)}"`);
  }
  return out.join(" ");
}

/**
 * Detect `<meta http-equiv="refresh" content="0;url=javascript:...">`.
 * Returns true if the props describe a refresh directive whose URL uses
 * a dangerous protocol — in which case the entire meta entry must be
 * dropped to avoid an XSS vector via the browser refresh mechanism.
 */
function isDangerousMetaRefresh(metaProps: Record<string, string>): boolean {
  const httpEquiv = metaProps["http-equiv"];
  if (typeof httpEquiv !== "string") return false;
  if (httpEquiv.toLowerCase() !== "refresh") return false;
  const content = metaProps.content;
  if (typeof content !== "string") return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping chars browsers silently ignore during protocol parsing
  const normalized = content.replace(/[\x00-\x20\x7f-\x9f]+/g, "").toLowerCase();
  return (
    normalized.includes("url=javascript:") ||
    normalized.includes("url=data:") ||
    normalized.includes("url=vbscript:") ||
    normalized.includes("url=blob:")
  );
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
export function renderToDocument(
  component: () => HTMLElement,
  options: {
    title?: string;
    meta?: Record<string, string>[];
    links?: Record<string, string>[];
    scripts?: string[];
    bodyAttrs?: Record<string, string>;
    /**
     * Raw HTML injected into `<head>`. Must be wrapped in `trustHTML()`
     * to confirm the content is developer-controlled.
     */
    headExtra?: TrustedHTML;
  } = {},
): string {
  let content: string;
  try {
    content = renderToString(component());
  } catch (err) {
    content = ssrErrorComment(err);
  }

  const metaTags = (options.meta || [])
    .map((attrs) => {
      // Drop any dangerous `<meta http-equiv="refresh" content="0;url=javascript:...">`
      // entry before it reaches the attribute builder.
      if (isDangerousMetaRefresh(attrs)) return "";
      const pairs = buildAttrString(attrs);
      return pairs ? `<meta ${pairs} />` : "";
    })
    .filter(Boolean)
    .join("\n    ");

  const linkTags = (options.links || [])
    .map((attrs) => {
      const pairs = buildAttrString(attrs);
      return pairs ? `<link ${pairs} />` : "";
    })
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
    ${options.title ? `<title>${escapeHtml(options.title)}</title>` : ""}
    ${metaTags}
    ${linkTags}
    ${options.headExtra || ""}
  </head>
  <body${bodyAttrs}>
    <div id="app">${content}</div>
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
export async function* renderToStream(element: HTMLElement | DocumentFragment | Node): AsyncGenerator<string> {
  if (element instanceof DocumentFragment) {
    for (const child of Array.from(element.childNodes)) {
      try {
        yield* renderToStream(child);
      } catch (err) {
        yield ssrErrorComment(err);
      }
    }
    return;
  }

  if (element.nodeType === 3) {
    yield escapeHtml(element.textContent || "");
    return;
  }

  if (element.nodeType === 8) {
    yield `<!--${safeCommentText(element.textContent || "")}-->`;
    return;
  }

  if (!(element instanceof HTMLElement)) {
    yield escapeHtml(element.textContent || "");
    return;
  }

  const tag = element.tagName.toLowerCase();

  if (tag === "script" || tag === "style") {
    if (_isDev) yield `<!--ssr:${tag}-stripped-->`;
    return;
  }

  if (!/^[a-z][a-z0-9-]*$/i.test(tag)) {
    if (_isDev) yield "<!--ssr:invalid-tag-->";
    return;
  }

  let openTag = `<${tag}`;

  for (const attr of Array.from(element.attributes)) {
    const rawName = attr.name;
    if (!isSafeAttrName(rawName)) continue;
    if (isEventHandlerAttr(rawName)) continue;

    const lowerName = rawName.toLowerCase();
    let value = attr.value;
    if (URL_ATTRS.has(lowerName)) {
      value = sanitizeUrl(value);
      if (!value) continue;
    }
    openTag += ` ${rawName}="${escapeAttr(value)}"`;
  }

  if (VOID_ELEMENTS.has(tag)) {
    yield `${openTag} />`;
    return;
  }

  yield `${openTag}>`;

  for (const child of Array.from(element.childNodes)) {
    try {
      yield* renderToStream(child);
    } catch (err) {
      yield ssrErrorComment(err);
    }
  }

  yield `</${tag}>`;
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
 * Renders a component tree to a Web ReadableStream<string>.
 * Compatible with Node 18+, Deno, and edge runtimes.
 * Uses pull-based backpressure — chunks are produced on demand.
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
export function hydrateIslands(container: HTMLElement, islands: Record<string, () => HTMLElement>): void {
  const markers = container.querySelectorAll("[data-sibu-island]");
  for (const marker of Array.from(markers)) {
    const id = marker.getAttribute("data-sibu-island") ?? "";
    if (!Object.hasOwn(islands, id)) continue;
    const factory = islands[id];
    if (typeof factory !== "function") continue;

    const clientTree = factory();
    // Preserve island marker so consumers can re-query and so progressive
    // hydration loops don't re-process already-hydrated islands.
    (clientTree as HTMLElement).setAttribute("data-sibu-island", id);
    (clientTree as HTMLElement).setAttribute("data-sibu-hydrated", "true");
    (marker as HTMLElement).replaceWith(clientTree);
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
    const id = marker.getAttribute("data-sibu-island") ?? "";
    if (!Object.hasOwn(islands, id)) continue;
    const factory = islands[id];
    if (typeof factory !== "function") continue;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const clientTree = factory();
            // Replace strategy: same fix as `hydrate()` — in-place attribute
            // copy leaves reactive bindings wired to the orphan client tree
            // and the visible DOM never updates. Preserve the island marker
            // + data-sibu-hydrated for downstream re-queries.
            (clientTree as HTMLElement).setAttribute("data-sibu-island", id);
            (clientTree as HTMLElement).setAttribute("data-sibu-hydrated", "true");
            (marker as HTMLElement).replaceWith(clientTree);
            observer.disconnect();
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

  const raced = Promise.race([props.content(), timeoutPromise]);
  const promise = raced.then(
    (resolvedEl) => {
      if (timer) clearTimeout(timer);
      return { id, html: renderToString(resolvedEl) };
    },
    (err) => {
      if (timer) clearTimeout(timer);
      // Emit the fallback HTML on timeout/error so the stream still
      // produces a deterministic swap payload instead of hanging.
      if (_isDev) console.warn("[SibuJS SSR] ssrSuspense rejected:", err);
      return { id, html: fallbackHtml };
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
    // Use appendChild loop instead of innerHTML to avoid DOM-based XSS
    `if(t&&f){while(t.firstChild)f.appendChild(t.firstChild);t.remove();f.removeAttribute("data-sibu-suspense-id");}` +
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

export function serializeState(
  state: Record<string, unknown>,
  nonce?: string,
  options?: { maxBytes?: number },
): string {
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
  return `<script${nonceAttr}>window.${SSR_DATA_ATTR}=${json}</script>`;
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
  if (_isDev && !validate) {
    console.warn(
      "[SibuJS SSR] deserializeState() called without a validate guard — tampered SSR payloads will not be detected.",
    );
  }
  const w = window as unknown as Record<string, unknown>;
  const raw = w[SSR_DATA_ATTR];
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
