/**
 * Strip C0/C1 control characters and ASCII whitespace that browsers silently
 * ignore while parsing a URL/protocol (e.g. "java\tscript:" or a leading
 * "\x01"). Centralized so every URL/scheme guard normalizes identically.
 */
export function stripControlChars(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — these chars are ignored by browsers during parsing
  return value.replace(/[\x00-\x20\x7f-\x9f]+/g, "");
}

/**
 * Is `name` an intrinsic event-handler attribute (`onclick`, `onerror`, …)?
 * Their value is evaluated as JavaScript on dispatch, so the framework never
 * sets them via `setAttribute`. Case-insensitive; matches `on` followed by an
 * ASCII letter. Single shared definition for every attribute-writing path.
 */
export function isEventHandlerAttr(name: string): boolean {
  if (name.length < 3) return false;
  const lower = name.toLowerCase();
  return lower[0] === "o" && lower[1] === "n" && lower.charCodeAt(2) >= 97 && lower.charCodeAt(2) <= 122;
}

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
  // Strip control chars/whitespace browsers ignore (e.g. "java\tscript:") so
  // they can't bypass the protocol check, then trim.
  const trimmed = stripControlChars(url).trim();
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

// Gate for the sanitizeCSSValue fast path: presence of any character that
// could begin (or, via `\`, hex-encode) a blocked CSS construct. Allocated
// once at module load, not per call.
const CSS_DANGER_GATE = /[(:@\\]/;

/**
 * Sanitizes a CSS value to prevent data exfiltration via url(), expression(),
 * or other injection vectors. Strips url() and expression() calls entirely.
 *
 * @param value CSS property value to sanitize
 * @returns The sanitized value, or empty string if dangerous
 */
export function sanitizeCSSValue(value: string): string {
  // Fast path: every blocked construct is gated by one of `(` (url/expression/
  // image-set), `:` (javascript:/vbscript:/behavior:/filter:progid), or `@`
  // (@import) — and a CSS escape that could synthesize them requires `\`. A
  // value containing none of those four characters is provably safe, so we
  // skip the decode + lower-case + whitespace-strip allocations and the nine
  // substring scans. This is the overwhelmingly common case for style values
  // ("red", "14px", "#fff", "1px solid black", "flex").
  if (!CSS_DANGER_GATE.test(value)) return value;

  // Decode CSS escapes (\xx hex and \uXXXX) so attackers can't bypass checks
  // via e.g. "ex\\70 ression(...)" or "\\75 rl(...)".
  const decoded = value.replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_m, hex) => {
    const code = Number.parseInt(hex, 16);
    if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
    try {
      return String.fromCodePoint(code);
      // Defensive: the range guard above already excludes every code point
      // String.fromCodePoint would reject, so this never throws.
      /* v8 ignore next 3 */
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
 * A naive `replace(/<[^>]*>/g, "")` is NOT safe: it leaves dangerous residue
 * for nested (`<scr<script>ipt>`) and unclosed (`<img onerror=...` with no
 * `>`) tags, which become a live XSS vector if the result is later assigned
 * to `innerHTML`. So we prefer a real HTML parser (browser/jsdom) — reading
 * `textContent` never executes scripts or loads resources and correctly
 * neutralizes malformed markup — and fall back to a hardened regex only where
 * no DOM exists (e.g. Node SSR, where the output is serialized as text anyway).
 *
 * @param html HTML string to strip
 * @returns Plain text with all HTML tags removed
 */
export function stripHtml(html: string): string {
  const input = String(html);
  if (typeof DOMParser !== "undefined") {
    try {
      return new DOMParser().parseFromString(input, "text/html").body.textContent ?? "";
    } catch {
      // fall through to the regex fallback
    }
  }
  // No-DOM fallback. Loop until stable so nested constructs collapse, then drop
  // any dangling unclosed tag start (`<img onerror=...` with no closing `>`).
  let prev: string;
  let out = input;
  do {
    prev = out;
    out = out.replace(/<[^>]*>/g, "");
  } while (out !== prev);
  return out.replace(/<[^>]*$/, "");
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
 *
 * HTML attribute names are case-insensitive, so we lower-case before the
 * lookup. Without this, a reactively-bound `HREF`/`SRC`/`xlink:HREF` would
 * skip URL sanitization (the set is all-lowercase) and a `javascript:` value
 * would reach the live DOM — the browser treats `HREF` as `href`.
 */
export function isUrlAttribute(attr: string): boolean {
  return URL_ATTRIBUTES.has(attr.toLowerCase());
}

/**
 * Resolve the sanitized string for a plain (non-boolean) attribute write,
 * applying the correct sink-specific policy:
 *
 *   - `srcset` is a comma-separated candidate list, so each URL is split out
 *     and validated individually (a single `sanitizeUrl` over the whole list
 *     would see the commas/descriptors and pass it through unchecked).
 *   - single-URL attributes (`href`, `src`, `xlink:href`, …) get protocol
 *     allowlist validation.
 *   - everything else passes through — `setAttribute` stores it as inert text.
 *
 * Single source of truth shared by the static write path (`tagFactory`) and
 * the reactive write paths (`bindAttribute` / `bindDynamic`) so the two can
 * never drift on which attribute gets which treatment.
 */
export function sanitizeAttributeString(attr: string, value: string): string {
  const lower = attr.toLowerCase();
  if (lower === "srcset") return sanitizeSrcset(value);
  if (URL_ATTRIBUTES.has(lower)) return sanitizeUrl(value);
  return value;
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
