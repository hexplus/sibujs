/**
 * favicon sets or updates the page favicon at runtime.
 *
 * Passes a `url` (to set `href`) or accepts an inline SVG string via
 * `data:image/svg+xml` encoding. Useful for notification badges, theme
 * switching, dynamic status indicators.
 *
 * Ensures a `<link rel="icon">` exists — creates one if missing, updates
 * the `href` otherwise.
 *
 * @param url Favicon URL or `data:` URI
 *
 * @example
 * ```ts
 * favicon("/icons/default.png");
 * // Unread count badge on the favicon
 * effect(() => {
 *   const n = unreadCount();
 *   favicon(n > 0 ? "/icons/badge.png" : "/icons/default.png");
 * });
 * ```
 */
export function favicon(url: string): void {
  if (typeof document === "undefined") return;
  let link = document.querySelector<HTMLLinkElement>("link[rel='icon']");
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }
  link.href = url;
}

/**
 * Encode an SVG string into a `data:image/svg+xml` URI suitable for use
 * with `favicon()`. Handles URL encoding of special characters so inline
 * SVG content can be embedded safely.
 *
 * @example
 * ```ts
 * favicon(svgFavicon(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="5" fill="red"/></svg>`));
 * ```
 */
export function svgFavicon(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
