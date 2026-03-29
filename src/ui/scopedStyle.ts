// ============================================================================
// SCOPED STYLE ISOLATION
// ============================================================================

let scopeCounter = 0;

/**
 * Sanitize CSS to prevent data exfiltration and other CSS-based attacks.
 * Strips dangerous patterns while preserving normal styling.
 */
function sanitizeCSS(css: string): string {
  // Remove @import rules (can load external stylesheets for data exfiltration)
  let sanitized = css.replace(/@import\s+[^;]+;/gi, "/* @import removed */");

  // Remove url() values — handles quoted content, escaped parens, and whitespace.
  // Matches: url(...), url("..."), url('...')
  sanitized = sanitized.replace(/url\s*\(\s*(?:"[^"]*"|'[^']*'|[^)]*)\s*\)/gi, "/* url() removed */");

  // Remove expression() (IE legacy, can execute JS) — same robust pattern
  sanitized = sanitized.replace(/expression\s*\(\s*(?:"[^"]*"|'[^']*'|[^)]*)\s*\)/gi, "/* expression() removed */");

  // Remove -moz-binding (Firefox legacy, can execute JS)
  sanitized = sanitized.replace(/-moz-binding\s*:[^;]+;/gi, "/* -moz-binding removed */");

  // Remove behavior (IE legacy, can execute HTC files)
  sanitized = sanitized.replace(/behavior\s*:[^;]+;/gi, "/* behavior removed */");

  return sanitized;
}

/**
 * scopedStyle creates component-scoped CSS by generating a unique scope ID
 * and prefixing all selectors.
 * Returns the scope attribute name and injects the CSS into the document.
 *
 * CSS is sanitized to remove dangerous patterns (`url()`, `@import`,
 * `expression()`, `-moz-binding`, `behavior`). If you need `url()` for
 * background images, use inline styles via the `style` prop instead.
 */
export function scopedStyle(css: string): { scope: string; attr: string } {
  const id = `sibu-s${scopeCounter++}`;
  const attr = `data-${id}`;

  // Sanitize CSS to prevent data exfiltration attacks
  const safeCss = sanitizeCSS(css);

  // Prefix all CSS selectors with the scope attribute
  const scopedCSS = safeCss.replace(/([^\r\n,{}]+)(,(?=[^}]*{)|\s*{)/g, (match, selector, delimiter) => {
    const trimmed = selector.trim();
    // Skip @-rules and keyframe selectors
    if (trimmed.startsWith("@") || trimmed.startsWith("from") || trimmed.startsWith("to") || /^\d+%$/.test(trimmed)) {
      return match;
    }
    return `${trimmed}[${attr}]${delimiter}`;
  });

  // Inject into document (skip during SSR)
  if (typeof document !== "undefined") {
    const styleEl = document.createElement("style");
    styleEl.setAttribute("data-sibu-scope", id);
    styleEl.textContent = scopedCSS;
    document.head.appendChild(styleEl);
  }

  return { scope: id, attr };
}

/**
 * withScopedStyle wraps a component function to auto-apply scoped styles.
 * The component and all its children get the scope attribute.
 */
export function withScopedStyle<P>(css: string, component: (props: P) => HTMLElement): (props: P) => HTMLElement {
  let style: { scope: string; attr: string } | null = null;

  return (props: P) => {
    // Lazy-inject: only create the style on first render
    if (!style) {
      style = scopedStyle(css);
    }
    const el = component(props);
    applyScopeRecursive(el, style.attr);
    return el;
  };
}

function applyScopeRecursive(element: HTMLElement, attr: string): void {
  element.setAttribute(attr, "");
  for (const child of Array.from(element.children)) {
    if (child instanceof HTMLElement) {
      applyScopeRecursive(child, attr);
    }
  }
}

/**
 * Removes a scoped style by its scope ID.
 */
export function removeScopedStyle(scopeId: string): void {
  const el = document.head.querySelector(`style[data-sibu-scope="${scopeId}"]`);
  if (el) el.remove();
}
