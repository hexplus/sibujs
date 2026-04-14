/**
 * Escapes HTML entities in a string to prevent XSS injection.
 * Used internally by bindTextNode for safe text node updates.
 * Also exported as a user-facing utility.
 */
export function sanitize(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Allowlist of safe URL protocols. Anything else (including javascript:,
// data:, vbscript:, blob:, file:, etc.) is rejected.
const SAFE_URL_PROTOCOLS = ["http:", "https:", "mailto:", "tel:", "ftp:"];

/**
 * Sanitizes a URL using a protocol allowlist. Accepts http:, https:,
 * mailto:, tel:, ftp:, and relative URLs. All other protocols are rejected.
 *
 * @param url URL string to sanitize
 * @returns The URL if safe, or empty string if dangerous
 */
export function sanitizeUrl(url: string): string {
  // Strip C0/C1 control characters and Unicode whitespace that browsers
  // may silently ignore, which could bypass protocol checks.
  // E.g. "\x01javascript:alert(1)" or "java\tscript:alert(1)"
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — stripping control chars to prevent protocol bypass
  const trimmed = url.replace(/[\x00-\x20\x7f-\x9f]+/g, "").trim();
  if (!trimmed) return "";

  // Detect an explicit scheme: the first ":" before any "/", "?", or "#".
  // If there's no scheme, treat as relative URL (safe).
  const lower = trimmed.toLowerCase();
  let schemeEnd = -1;
  for (let i = 0; i < lower.length; i++) {
    const ch = lower.charCodeAt(i);
    if (ch === 58 /* : */) {
      schemeEnd = i;
      break;
    }
    // Stop if we hit a path/query/fragment separator — it's a relative URL.
    if (ch === 47 /* / */ || ch === 63 /* ? */ || ch === 35 /* # */) break;
  }

  if (schemeEnd === -1) return trimmed; // relative URL

  const scheme = lower.slice(0, schemeEnd + 1);
  // Only chars [a-z0-9+.-] are valid scheme characters; anything else means
  // the ":" is part of a path/fragment, not a scheme.
  if (!/^[a-z][a-z0-9+.-]*:$/.test(scheme)) return trimmed;

  if (SAFE_URL_PROTOCOLS.indexOf(scheme) === -1) return "";
  return trimmed;
}

/**
 * Sanitizes a srcset attribute value by splitting on commas, running each
 * URL through sanitizeUrl, and re-joining. Invalid candidates are dropped.
 */
export function sanitizeSrcset(value: string): string {
  const parts = value.split(",");
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i].trim();
    if (!part) continue;
    // Candidate = URL [descriptor]. Split on first whitespace run.
    const m = part.match(/^(\S+)(\s+.+)?$/);
    if (!m) continue;
    const safe = sanitizeUrl(m[1]);
    if (!safe) continue;
    out.push(m[2] ? `${safe}${m[2]}` : safe);
  }
  return out.join(", ");
}

/**
 * Sanitizes a CSS value to prevent data exfiltration via url(), expression(),
 * or other injection vectors. Strips url() and expression() calls entirely.
 *
 * @param value CSS property value to sanitize
 * @returns The sanitized value, or empty string if dangerous
 */
export function sanitizeCSSValue(value: string): string {
  // Decode CSS escapes (\xx hex and \uXXXX) so attackers can't bypass checks
  // via e.g. "ex\\70 ression(...)" or "\\75 rl(...)".
  const decoded = value.replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_m, hex) => {
    const code = Number.parseInt(hex, 16);
    if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
    try {
      return String.fromCodePoint(code);
    } catch {
      return "";
    }
  });
  const lower = decoded.toLowerCase().replace(/\s+/g, "");
  if (
    lower.includes("url(") ||
    lower.includes("expression(") ||
    lower.includes("javascript:") ||
    lower.includes("vbscript:") ||
    lower.includes("-moz-binding") ||
    lower.includes("behavior:") ||
    lower.includes("@import") ||
    lower.includes("image-set(") ||
    lower.includes("filter:progid")
  ) {
    return "";
  }
  return value;
}

/**
 * Sanitizes HTML by stripping all tags, leaving only text content.
 *
 * @param html HTML string to strip
 * @returns Plain text with all HTML tags removed
 */
export function stripHtml(html: string): string {
  return String(html).replace(/<[^>]*>/g, "");
}

// Default safe attributes that can be set without sanitization
const SAFE_ATTRIBUTES = new Set([
  "id",
  "class",
  "style",
  "title",
  "alt",
  "role",
  "tabindex",
  "hidden",
  "disabled",
  "readonly",
  "required",
  "placeholder",
  "name",
  "type",
  "value",
  "checked",
  "selected",
  "multiple",
  "min",
  "max",
  "step",
  "rows",
  "cols",
  "width",
  "height",
  "for",
  "aria-label",
  "aria-hidden",
  "aria-expanded",
  "aria-selected",
  "aria-describedby",
  "aria-labelledby",
  "aria-live",
  "data-*",
]);

// Attributes that hold URLs and need URL sanitization.
// `xlink:href` is a legacy SVG alias for `href` and has historically been a
// javascript: vector on `<a>` / `<use>`. `formtarget` / `ping` / `data`
// (on `<object>`) are additional URL sinks enumerated by the HTML spec.
const URL_ATTRIBUTES = new Set([
  "href",
  "xlink:href",
  "src",
  "action",
  "formaction",
  "formtarget",
  "cite",
  "poster",
  "background",
  "srcset",
  "ping",
  "data",
]);

/**
 * Checks if an attribute name is safe to set without sanitization.
 */
export function isSafeAttribute(attr: string): boolean {
  if (SAFE_ATTRIBUTES.has(attr)) return true;
  if (attr.startsWith("data-")) return true;
  if (attr.startsWith("aria-")) return true;
  return false;
}

/**
 * Checks if an attribute holds a URL that needs sanitization.
 */
export function isUrlAttribute(attr: string): boolean {
  return URL_ATTRIBUTES.has(attr);
}

/**
 * Sanitizes an attribute value based on its name.
 * URL attributes get URL sanitization; others get HTML entity escaping.
 *
 * @public Exported for user-facing API — not used internally by the framework.
 * The framework uses setAttribute() directly (which is XSS-safe) and only
 * calls sanitizeUrl() for URL attributes.
 */
export function sanitizeAttribute(attr: string, value: string): string {
  if (isUrlAttribute(attr)) {
    return sanitizeUrl(value);
  }
  return sanitize(value);
}
