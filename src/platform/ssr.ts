// ============================================================================
// SERVER-SIDE RENDERING
// ============================================================================

import { isDev } from "../core/dev";

const _isDev = isDev();

/** Format an SSR error as an HTML comment. In production, omits the message to prevent information leakage. */
function ssrErrorComment(err: unknown): string {
  if (_isDev) {
    return `<!--SSR error: ${escapeHtml(err instanceof Error ? err.message : String(err))}-->`;
  }
  return "<!--SSR error-->";
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
    // Comment node — escape "-->" to prevent breaking out of the comment
    const content = (element.textContent || "").replace(/-->/g, "--&gt;");
    return `<!--${content}-->`;
  }

  if (!(element instanceof HTMLElement)) {
    return element.textContent || "";
  }

  const tag = element.tagName.toLowerCase();
  let html = `<${tag}`;

  for (const attr of Array.from(element.attributes)) {
    html += ` ${attr.name}="${escapeAttr(attr.value)}"`;
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

/**
 * Hydrates a server-rendered DOM tree by attaching event listeners
 * and activating reactive bindings.
 */
export function hydrate(component: () => HTMLElement, container: HTMLElement): void {
  const clientTree = component();

  hydrateNode(container.firstElementChild as HTMLElement, clientTree);
  container.setAttribute("data-sibu-hydrated", "true");
}

function hydrateNode(serverNode: HTMLElement | null, clientNode: HTMLElement): void {
  if (!serverNode) return;

  const serverChildren = Array.from(serverNode.children) as HTMLElement[];
  const clientChildren = Array.from(clientNode.children) as HTMLElement[];

  for (let i = 0; i < Math.min(serverChildren.length, clientChildren.length); i++) {
    hydrateNode(serverChildren[i], clientChildren[i]);
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
 * Renders a component to a full HTML document string.
 *
 * `headExtra` requires a `TrustedHTML` value created via `trustHTML()`.
 * This prevents accidental injection of unsanitized user input.
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
    .map(
      (attrs) =>
        `<meta ${Object.entries(attrs)
          .map(([k, v]) => `${k}="${escapeAttr(v)}"`)
          .join(" ")} />`,
    )
    .join("\n    ");

  const linkTags = (options.links || [])
    .map(
      (attrs) =>
        `<link ${Object.entries(attrs)
          .map(([k, v]) => `${k}="${escapeAttr(v)}"`)
          .join(" ")} />`,
    )
    .join("\n    ");

  const scriptTags = (options.scripts || []).map((src) => `<script src="${escapeAttr(src)}"></script>`).join("\n    ");

  const bodyAttrs = options.bodyAttrs
    ? " " +
      Object.entries(options.bodyAttrs)
        .map(([k, v]) => `${k}="${escapeAttr(v)}"`)
        .join(" ")
    : "";

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
    // Escape "-->" to prevent breaking out of the HTML comment
    const content = (element.textContent || "").replace(/-->/g, "--&gt;");
    yield `<!--${content}-->`;
    return;
  }

  if (!(element instanceof HTMLElement)) {
    yield element.textContent || "";
    return;
  }

  const tag = element.tagName.toLowerCase();
  let openTag = `<${tag}`;

  for (const attr of Array.from(element.attributes)) {
    openTag += ` ${attr.name}="${escapeAttr(attr.value)}"`;
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
    cancel() {
      generator.return(undefined);
    },
  });
}

// ─── Partial / Selective Hydration (Islands) ────────────────────────────────

/**
 * Marks an element as a hydration island. During partial hydration
 * only elements marked with `data-sibu-island` will be hydrated.
 */
export function island(id: string, component: () => HTMLElement): HTMLElement {
  const el = component();
  el.setAttribute("data-sibu-island", id);
  return el;
}

/**
 * Hydrate only elements marked as islands (`data-sibu-island`).
 * Non-island content keeps its server-rendered HTML untouched.
 */
export function hydrateIslands(container: HTMLElement, islands: Record<string, () => HTMLElement>): void {
  const markers = container.querySelectorAll("[data-sibu-island]");
  for (const marker of Array.from(markers)) {
    const id = marker.getAttribute("data-sibu-island") ?? "";
    const factory = islands[id];
    if (!factory) continue;

    const clientTree = factory();
    hydrateNode(marker as HTMLElement, clientTree);
    (marker as HTMLElement).setAttribute("data-sibu-hydrated", "true");
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
    const factory = islands[id];
    if (!factory) continue;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const clientTree = factory();
            hydrateNode(marker as HTMLElement, clientTree);
            (marker as HTMLElement).setAttribute("data-sibu-hydrated", "true");
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

let suspenseIdCounter = 0;

/**
 * Reset SSR state between requests. Call at the start of each SSR render
 * to prevent ID drift in long-lived server processes.
 */
export function resetSSRState(): void {
  suspenseIdCounter = 0;
}

/**
 * Create a suspense boundary for SSR streaming.
 * Renders fallback HTML inline and returns a promise for the resolved content.
 *
 * The returned element contains the fallback UI with a `data-sibu-suspense-id`
 * marker. The promise resolves to `{ id, html }` once async content is ready.
 */
export function ssrSuspense(props: { fallback: () => HTMLElement; content: () => Promise<HTMLElement> }): {
  element: HTMLElement;
  promise: Promise<{ id: string; html: string }>;
} {
  const id = `sibu-sus-${suspenseIdCounter++}`;

  const fallbackEl = props.fallback();
  const wrapper = document.createElement("div");
  wrapper.setAttribute("data-sibu-suspense-id", id);
  wrapper.appendChild(fallbackEl);

  const promise = props.content().then((resolvedEl) => ({
    id,
    html: renderToString(resolvedEl),
  }));

  return { element: wrapper, promise };
}

/**
 * Generate an inline script that swaps a suspense fallback with resolved content.
 * The id is escaped for both JS string and HTML attribute contexts to prevent injection.
 */
export function suspenseSwapScript(id: string, nonce?: string): string {
  // Escape for JS string context (backslash, quotes) and HTML context (angle brackets)
  const safeId = id.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
  const nonceAttr = nonce ? ` nonce="${escapeAttr(nonce)}"` : "";
  return (
    `<script${nonceAttr}>(function(){` +
    `var t=document.getElementById("sibu-resolved-${safeId}");` +
    `var f=document.querySelector('[data-sibu-suspense-id="${safeId}"]');` +
    // Use appendChild loop instead of innerHTML to avoid DOM-based XSS
    `if(t&&f){while(t.firstChild)f.appendChild(t.firstChild);t.remove();f.removeAttribute("data-sibu-suspense-id");}` +
    "})()</script>"
  );
}

/**
 * Renders a component tree with suspense boundaries as a stream.
 * Yields the main tree HTML first (including fallback content for suspended
 * boundaries), then flushes resolved content with inline swap scripts.
 */
export async function* renderToSuspenseStream(
  element: HTMLElement | DocumentFragment | Node,
  pendingBoundaries: Promise<{ id: string; html: string }>[] = [],
): AsyncGenerator<string> {
  yield* renderToStream(element);

  if (pendingBoundaries.length > 0) {
    const resolved = await Promise.all(pendingBoundaries);
    for (const { id, html } of resolved) {
      yield `<div hidden id="sibu-resolved-${escapeAttr(id)}">${html}</div>`;
      yield suspenseSwapScript(id);
    }
  }
}

// ─── SSR Data Serialization ─────────────────────────────────────────────────

const SSR_DATA_ATTR = "__SIBU_SSR_DATA__";

/**
 * Serialize application state into an HTML script tag for SSR.
 * The serialized data is embedded in the document and picked up
 * on the client with `deserializeState()`.
 */
export function serializeState(state: Record<string, unknown>, nonce?: string): string {
  const json = JSON.stringify(state).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
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
  const raw = (window as unknown as Record<string, unknown>)[SSR_DATA_ATTR];
  if (raw === undefined) return undefined;
  if (validate && !validate(raw)) return undefined;
  return raw as T;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
