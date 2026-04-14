/**
 * Compiled optimizations for SibuJS.
 * Provides markers and utilities for Svelte-style compile-time optimizations.
 * These are hints for build tools and static analyzers.
 */

// Re-export the canonical TrustedHTML brand + minter from platform/ssr so
// values minted in either module are interchangeable. Defining a second
// brand here previously caused silent type incompatibilities between
// compiled.ts and ssr.ts callers.
export { type TrustedHTML, trustHTML } from "../platform/ssr";

import type { TrustedHTML } from "../platform/ssr";

/**
 * Marks a component's template as static (no reactive bindings).
 * A build tool can pre-render this to a static HTML string and
 * skip reactive setup entirely.
 *
 * Accepts only `TrustedHTML` (mint via `trustHTML(...)`) to keep the
 * `innerHTML` write from becoming a silent XSS sink (CWE-79).
 */
export function staticTemplate(html: TrustedHTML): HTMLElement {
  const template = document.createElement("template");
  template.innerHTML = (html as string).trim();
  return template.content.firstElementChild as HTMLElement;
}

/**
 * Clone a static template for efficient repeated rendering.
 * Uses template.content.cloneNode(true) which is faster than createElement.
 */
export function cloneTemplate(template: HTMLTemplateElement): DocumentFragment {
  return template.content.cloneNode(true) as DocumentFragment;
}

/**
 * Pre-compile a component factory.
 * Caches the template and only applies dynamic bindings on each call.
 */
export function precompile<Props>(
  templateHtml: TrustedHTML,
  hydrate: (el: HTMLElement, props: Props) => void,
): (props: Props) => HTMLElement {
  const tpl = document.createElement("template");
  tpl.innerHTML = (templateHtml as string).trim();

  return (props: Props): HTMLElement => {
    const el = tpl.content.firstElementChild?.cloneNode(true) as HTMLElement;
    hydrate(el, props);
    return el;
  };
}

/**
 * Marker for static expressions that can be hoisted out of reactive scopes.
 * A compiler pass would extract these to module scope.
 */
export function hoistable<T>(value: T): T {
  return value;
}

/**
 * Marks a block of DOM creation as having a known, fixed structure.
 * Enables block-level optimization where the compiler can generate
 * optimized creation and patching code.
 */
export function block(factory: () => HTMLElement): HTMLElement {
  return factory();
}
