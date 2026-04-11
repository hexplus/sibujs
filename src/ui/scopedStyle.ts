// ============================================================================
// SCOPED STYLE ISOLATION
// ============================================================================

let scopeCounter = 0;

/**
 * Decode CSS escape sequences so the sanitizer can catch obfuscated
 * dangerous tokens. An attacker can otherwise hide `url(` as `\75 rl(`
 * or `expression` as `e\78 pression`, bypassing a naive regex.
 *
 * This function decodes:
 *   - Hex escapes `\XXXXXX` (1–6 hex digits, optional trailing whitespace)
 *   - Character escapes `\X` for any non-hex character
 *
 * The output is exact CSS text (with the escapes resolved), which is
 * then matched against the literal attack patterns.
 */
function decodeCssEscapes(css: string): string {
  return css.replace(/\\([0-9a-f]{1,6})[ \t\n\r\f]?|\\([^\n])/gi, (_match, hex, ch) => {
    if (hex) {
      const code = Number.parseInt(hex, 16);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return "";
        }
      }
      return "";
    }
    return ch || "";
  });
}

/**
 * Sanitize CSS to prevent data exfiltration and other CSS-based attacks.
 * Strips dangerous patterns while preserving normal styling.
 *
 * Strategy: decode CSS escape sequences first so obfuscated tokens
 * (`\75 rl(`, `e\78 pression`, etc.) can't bypass the pattern scan.
 * Then strip the dangerous constructs. The returned CSS is the
 * decoded-and-sanitized form — any legitimate CSS escapes are resolved
 * to their literal characters, which browsers accept just fine.
 */
function sanitizeCSS(css: string): string {
  let sanitized = decodeCssEscapes(css);

  // Remove @import rules (can load external stylesheets for data exfiltration)
  sanitized = sanitized.replace(/@import\s+[^;]+;/gi, "/* @import removed */");

  // Remove url() values — handles quoted content, escaped parens, and whitespace.
  // Matches: url(...), url("..."), url('...'), url(\n...\n)
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
