import { signal } from "../signals/signal";
import { isServer } from "../ssr-context";
import { when } from "./directives";
import { afterHydration, isHydrating } from "./hydrationHooks";
import type { NodeChild } from "./types";

/** Options of {@link ClientOnly}. */
export interface ClientOnlyOptions {
  /**
   * What the server renders (and what the browser shows until it takes over).
   * Give it the same size as the content to avoid a layout jump when it is
   * swapped. Omitted, nothing is rendered on the server.
   */
  fallback?: () => NodeChild;
}

/**
 * Render content that only works in a browser — a canvas, `document.fonts`,
 * `matchMedia`, storage, a third-party widget.
 *
 * - **On the server** (an SSR render or the build-time pre-renderer), only
 *   `fallback` is rendered, so the content's browser APIs never run there.
 * - **In the browser**, the content renders directly. During an adopting
 *   hydration the fallback is rendered first, so it binds to the server's
 *   fallback markup, and the content replaces it in one synchronous swap as
 *   soon as the hydration ends.
 *
 * @param content Builds the browser-only content.
 * @param options `fallback` for the server and for the first paint.
 * @returns A directive anchor (like `when`), to place as a child.
 *
 * @example
 * ```ts
 * // The card ships a plain <img>; the browser recolors it on a <canvas>.
 * ClientOnly(() => RecoloredCanvas(product), {
 *   fallback: () => img({ src: product.image, width: 160, height: 160 }),
 * });
 * ```
 */
export function ClientOnly(content: () => NodeChild, options: ClientOnlyOptions = {}): Comment {
  const server = isServer();
  const [ready, setReady] = signal(!server && !isHydrating());
  if (!server && !ready()) afterHydration(() => setReady(true));
  return when(ready, content, options.fallback);
}
