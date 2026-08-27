// ============================================================================
// SCOPED STYLE ISOLATION
// ============================================================================

import { globalSingleton } from "../utils/globalSingleton";

// Shared via globalSingleton so a duplicated copy of this module doesn't restart
// at 0 and emit colliding `sibu-s*` scope ids (cross-bundle style collisions).
const _scope = globalSingleton(Symbol.for("sibujs.scopedStyle.v1"), () => ({ n: 0 }));

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
 * Find where the FIRST compound selector ends.
 *
 * A compound is a run of simple selectors with no combinator between them
 * (`div.card:hover`). The scope marker has to land inside that first compound —
 * appended to the whole selector it would attach to the LAST compound instead,
 * so `.card .title` would demand the scope on `.title` rather than on the
 * component root.
 *
 * Stops at the first depth-0 combinator (whitespace, `>`, `+`, `~`) or at a
 * pseudo-element (`::`), which must stay last in its compound. Bracket and
 * paren depth are tracked so combinators inside `[attr="a b"]` or
 * `:is(.a > .b)` do not end the compound early.
 */
function firstCompoundEnd(selector: string): number {
  let parens = 0;
  let brackets = 0;
  let quote: string | null = null;

  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i];

    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "(") parens++;
    else if (ch === ")") parens--;
    else if (ch === "[") brackets++;
    else if (ch === "]") brackets--;

    if (parens > 0 || brackets > 0) continue;

    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f") return i;
    if (ch === ">" || ch === "+" || ch === "~") return i;
    if (ch === ":" && selector[i + 1] === ":") return i;
  }
  return selector.length;
}

/**
 * Scope one selector to a component subtree.
 *
 * WHY TWO SELECTORS
 * -----------------
 * The scope marker used to be stamped onto every element that existed when the
 * component first rendered, and the selector simply required it
 * (`.child[data-scope]`). That makes the contract "elements present at render
 * time", not "this component's subtree": every node a signal, an `each()` row,
 * or a conditional inserts LATER is unmarked and renders unstyled, which is
 * indistinguishable from the stylesheet having failed.
 *
 * Anchoring at the root instead makes future descendants automatic — the DOM
 * relationship is what matches, and no node has to be stamped after creation.
 * Two forms are emitted because the root itself must still be selectable:
 *
 *   [scope] .child     descendants of the component root  (dynamic ones included)
 *   .child[scope]      the component root itself
 *
 * Both carry the same specificity contribution, so authoring order still
 * decides between them.
 */
function scopeSelector(selector: string, attr: string): string {
  const end = firstCompoundEnd(selector);
  const selfForm = `${selector.slice(0, end)}[${attr}]${selector.slice(end)}`;
  const descendantForm = `[${attr}] ${selector}`;
  return `${descendantForm}, ${selfForm}`;
}

/**
 * If a string, comment, or escape sequence begins at `i`, return the index just
 * past it; otherwise `-1`.
 *
 * Every depth-tracking walk below shares this, so a `,`, `{`, `(` or `[` that
 * appears inside a quoted string, a comment, or after a backslash is never
 * mistaken for structure. Centralising it is the point: the previous
 * regex-driven rewriter had no notion of these contexts at all.
 */
function skipNonCode(text: string, i: number): number {
  const ch = text[i];
  if (ch === "\\") return i + 2;
  if (ch === '"' || ch === "'") {
    let j = i + 1;
    while (j < text.length) {
      if (text[j] === "\\") {
        j += 2;
        continue;
      }
      if (text[j] === ch) return j + 1;
      j++;
    }
    return text.length;
  }
  if (ch === "/" && text[i + 1] === "*") {
    const end = text.indexOf("*/", i + 2);
    return end === -1 ? text.length : end + 2;
  }
  return -1;
}

/**
 * Split a selector PRELUDE into its top-level selector list.
 *
 * A comma separates selectors only at depth zero. Inside a functional
 * pseudo-class it is an argument separator (`:is(.a, .b)`); inside an attribute
 * value or string it is ordinary text (`[data-v=","]`). Splitting on every
 * comma tore those apart and scoped each fragment independently, producing CSS
 * the engine either rejected or accepted with a different meaning:
 *
 *   :is(.a, .b)   ->   [s] :is(.a, :is(.a[s],[s] .b), .b)[s]
 *
 * which selects neither `.a` nor `.b` as authored.
 */
function splitSelectorList(prelude: string): string[] {
  const parts: string[] = [];
  let parens = 0;
  let brackets = 0;
  let start = 0;

  for (let i = 0; i < prelude.length; i++) {
    const skip = skipNonCode(prelude, i);
    if (skip !== -1) {
      i = skip - 1;
      continue;
    }
    const ch = prelude[i];
    if (ch === "(") parens++;
    else if (ch === ")") parens--;
    else if (ch === "[") brackets++;
    else if (ch === "]") brackets--;
    else if (ch === "," && parens === 0 && brackets === 0) {
      parts.push(prelude.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(prelude.slice(start));
  return parts;
}

/** Index of the `}` closing the block opened at `openBrace`. */
function findBlockEnd(css: string, openBrace: number): number {
  let depth = 0;
  for (let i = openBrace; i < css.length; i++) {
    const skip = skipNonCode(css, i);
    if (skip !== -1) {
      i = skip - 1;
      continue;
    }
    const ch = css[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return css.length;
}

/**
 * At-rules whose body is a nested list of STYLE RULES, so scoping recurses into
 * them. Every other `@` prelude — `@keyframes`, `@font-face`, `@page`,
 * `@import`, `@charset` — has a body that is not a selector context and is
 * emitted verbatim. That is also what keeps keyframe stops (`from`, `to`,
 * `50%`) unscoped, without special-casing their spellings.
 */
const NESTED_AT_RULE = /^@(media|supports|layer|container|scope|document)\b/i;

/**
 * Rewrite a stylesheet, scoping every style rule's selector list.
 *
 * Structure-aware rather than regex-driven: the walk tracks string, comment,
 * escape, paren, bracket and brace state, so a `{` or `,` that is not
 * structural is never treated as though it were.
 */
function scopeStylesheet(css: string, attr: string): string {
  let out = "";
  let preludeStart = 0;
  let parens = 0;
  let brackets = 0;
  let i = 0;

  while (i < css.length) {
    const skip = skipNonCode(css, i);
    if (skip !== -1) {
      i = skip;
      continue;
    }
    const ch = css[i];

    if (ch === "(") {
      parens++;
      i++;
      continue;
    }
    if (ch === ")") {
      parens--;
      i++;
      continue;
    }
    if (ch === "[") {
      brackets++;
      i++;
      continue;
    }
    if (ch === "]") {
      brackets--;
      i++;
      continue;
    }

    if (ch === "{" && parens === 0 && brackets === 0) {
      const prelude = css.slice(preludeStart, i);
      const bodyEnd = findBlockEnd(css, i);
      const body = css.slice(i + 1, bodyEnd);
      const trimmed = prelude.trim();
      const lead = prelude.slice(0, prelude.length - prelude.trimStart().length);

      if (trimmed === "") {
        out += `${prelude}{${body}}`;
      } else if (trimmed.startsWith("@")) {
        out += NESTED_AT_RULE.test(trimmed) ? `${prelude}{${scopeStylesheet(body, attr)}}` : `${prelude}{${body}}`;
      } else {
        const scoped = splitSelectorList(trimmed)
          .map((part) => {
            const selector = part.trim();
            return selector ? scopeSelector(selector, attr) : part;
          })
          .join(", ");
        out += `${lead}${scoped}{${body}}`;
      }

      i = bodyEnd + 1;
      preludeStart = i;
      continue;
    }

    i++;
  }

  out += css.slice(preludeStart);
  return out;
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
  const id = `sibu-s${_scope.n++}`;
  const attr = `data-${id}`;

  // Sanitize CSS to prevent data exfiltration attacks
  const safeCss = sanitizeCSS(css);

  // Rewrite every selector into a ROOT-ANCHORED pair. See `scopeSelector`.
  const scopedCSS = scopeStylesheet(safeCss, attr);

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
    // ROOT ONLY. The generated selectors are anchored at the scope attribute
    // and match descendants structurally, so nodes created later — by a signal,
    // an `each()` row, a conditional — are inside the contract without anyone
    // having to stamp them. Walking the tree once at render time could only
    // ever cover the nodes that already existed.
    el.setAttribute(style.attr, "");
    return el;
  };
}

/**
 * Removes a scoped style by its scope ID.
 */
export function removeScopedStyle(scopeId: string): void {
  const el = document.head.querySelector(`style[data-sibu-scope="${scopeId}"]`);
  if (el) el.remove();
}
