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
 * Fold an attribute name to the form the HTML parser will use.
 *
 * ASCII-only, deliberately. The HTML parser lower-cases exactly `A`-`Z` and
 * leaves everything else alone, whereas `String.prototype.toLowerCase`
 * additionally maps some non-ASCII code points INTO ASCII letters (U+212A
 * KELVIN SIGN becomes `k`). Using the latter would let this function and the
 * browser disagree about what an attribute is called, which is precisely the
 * kind of gap every name comparison here exists to close.
 *
 * THE single fold. Every security-relevant attribute-name comparison in the
 * framework routes through it, so a value cannot be judged under one name and
 * committed under another.
 */
export function canonicalAttrName(name: string): string {
  return name.replace(/[A-Z]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 32));
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
 * Leading/trailing C0-C1 control characters and ASCII whitespace. Browsers
 * discard these when parsing a URL, so removing them changes nothing
 * semantically — unlike the INTERIOR characters `stripControlChars` removes.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — these chars are ignored by browsers during parsing
const OUTER_TRIM = /^[\x00-\x20\x7f-\x9f]+|[\x00-\x20\x7f-\x9f]+$/g;

/**
 * Sanitizes a URL using a protocol allowlist. Accepts http:, https:,
 * mailto:, tel:, ftp:, and relative URLs. All other protocols are rejected.
 *
 * Security normalization and output normalization are deliberately separate.
 * The scheme check runs against an aggressively stripped PROBE copy so
 * obfuscated schemes (`java\tscript:`, a leading `\x01`) cannot slip past it,
 * but that probe is never returned: it is a detection artefact, not the user's
 * URL. Returning it corrupted legitimate values — `mailto:a@b.com?subject=Hello
 * World` came back as `...HelloWorld`, silently changing what the link does.
 *
 * The returned value is the input with only leading/trailing control
 * characters and whitespace removed, which browsers ignore anyway. Interior
 * characters are preserved verbatim: spaces get percent-encoded by the URL
 * parser, and interior tabs/newlines are dropped by it — either way the
 * meaning the author wrote is what survives.
 *
 * Security takes precedence over preservation: anything the probe identifies as
 * a disallowed scheme is rejected outright, even if the raw input would have
 * parsed differently.
 *
 * @param url URL string to sanitize
 * @returns The URL if safe, or empty string if dangerous
 */
export function sanitizeUrl(url: string): string {
  // PROBE: the most aggressive reading a browser could take — every character
  // it would ignore removed. Used ONLY to decide safe/unsafe.
  const probe = stripControlChars(url).trim();
  if (!probe) return "";

  // OUTPUT: the caller's value, minus only the outer padding.
  const output = url.replace(OUTER_TRIM, "");

  // Detect an explicit scheme: the first ":" before any "/", "?", or "#".
  // If there's no scheme, treat as relative URL (safe).
  const lower = probe.toLowerCase();
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

  if (schemeEnd === -1) return output; // relative URL

  const scheme = lower.slice(0, schemeEnd + 1);
  // Only chars [a-z0-9+.-] are valid scheme characters; anything else means
  // the ":" is part of a path/fragment, not a scheme.
  if (!/^[a-z][a-z0-9+.-]*:$/.test(scheme)) return output;

  if (SAFE_URL_PROTOCOLS.indexOf(scheme) === -1) return "";
  return output;
}

/**
 * The only descriptors a srcset candidate may carry: a width (`640w`) or a
 * pixel density (`2x`, `1.5x`). Anything else means the candidate is malformed.
 *
 * WHY THIS IS VALIDATED: candidates are split on the first whitespace run, and
 * whitespace is exactly what an obfuscated scheme hides behind. Given
 * `java\tscript:alert(1) 1x`, the URL half is just `java` — which passes the
 * allowlist as a relative URL — and the dangerous remainder rides along in the
 * descriptor half. Requiring a well-formed descriptor drops such candidates
 * instead of reassembling them.
 */
const SRCSET_DESCRIPTOR = /^\s+\d+(\.\d+)?[wx]$/;

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
    // A descriptor that is not a valid width/density means this candidate was
    // never a well-formed candidate — drop it rather than re-emitting it.
    if (m[2] !== undefined && !SRCSET_DESCRIPTOR.test(m[2])) continue;
    const safe = sanitizeUrl(m[1]);
    if (!safe) continue;
    out.push(m[2] ? `${safe}${m[2]}` : safe);
  }
  return out.join(", ");
}

// Gate for the sanitizeCSSValue fast path: presence of any character that
// could begin (or, via `\`, escape-encode) a blocked CSS construct. Allocated
// once at module load, not per call.
const CSS_DANGER_GATE = /[(:@\\]/;

/** CSS whitespace, as the escape grammar defines it. */
function isCssWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f";
}

function isHexDigit(ch: string): boolean {
  return (ch >= "0" && ch <= "9") || (ch >= "a" && ch <= "f") || (ch >= "A" && ch <= "F");
}

/**
 * Resolve CSS escape sequences to the characters a browser actually sees.
 *
 * WHY THIS EXISTS AS A UNIT: the danger-token scan below compares text against
 * literal spellings (`url(`, `expression(`, `@import`). That comparison is only
 * sound if the text has first been reduced to the form the CSS parser produces.
 * The escape grammar has THREE productions and the previous decoder implemented
 * one of them:
 *
 *   hex escape       `\75 rl(…)`     1–6 hex digits, optionally closed by a
 *                                    single whitespace character
 *   simple escape    `u\rl(…)`       `\` + any other character IS that
 *                                    character — the backslash simply vanishes
 *   escaped newline  `u\<LF>rl(…)`   `\` + LF / CR / CRLF / FF is a line
 *                                    continuation; both halves vanish
 *
 * Only the first was decoded, so the other two carried a blocked construct past
 * the scan intact: `u\rl(https://attacker.example/…)` reads as `url(` to every
 * browser but matched nothing in the danger list.
 *
 * This is an INSPECTION transform. Its output decides safe/unsafe and is never
 * returned to the caller — `sanitizeCSSValue` emits the author's original text,
 * so legitimate escapes (`content: "\201C"`) reach CSS exactly as written.
 *
 * Invalid code points become U+FFFD, matching what a CSS parser substitutes.
 * That is deliberate over deleting them: deletion would splice the surrounding
 * characters together and could manufacture a token the browser never sees,
 * rejecting safe values.
 */
function decodeCssEscapes(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }

    // A trailing lone backslash escapes nothing and cannot complete a token.
    if (i + 1 >= value.length) break;
    const next = value[i + 1];

    // Escaped newline — a line continuation. CRLF counts as ONE newline.
    if (next === "\n" || next === "\f") {
      i += 1;
      continue;
    }
    if (next === "\r") {
      i += value[i + 2] === "\n" ? 2 : 1;
      continue;
    }

    if (isHexDigit(next)) {
      let hex = "";
      let j = i + 1;
      while (j < value.length && hex.length < 6 && isHexDigit(value[j])) {
        hex += value[j];
        j++;
      }
      // At most ONE whitespace character terminates a hex escape; CRLF is one.
      if (j < value.length && isCssWhitespace(value[j])) {
        j += value[j] === "\r" && value[j + 1] === "\n" ? 2 : 1;
      }
      const code = Number.parseInt(hex, 16);
      const invalid = code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff);
      out += invalid ? "�" : String.fromCodePoint(code);
      i = j - 1;
      continue;
    }

    // Simple escape: `\` + anything else is literally that character.
    out += next;
    i += 1;
  }
  return out;
}

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

  // Normalize to what the CSS parser sees BEFORE looking for blocked tokens —
  // every escape production, not just the hex one. See `decodeCssEscapes`.
  // Without a `\` there is nothing to decode, and skipping the scan keeps the
  // decoder off the path of the values that reach here most often: legitimate
  // functional notation like `calc(…)`, `rgba(…)`, `var(…)`, gradients.
  const normalized = value.includes("\\") ? decodeCssEscapes(value) : value;
  const lower = normalized.toLowerCase().replace(/\s+/g, "");
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
 * Sanitize a WHOLE `style` attribute — a declaration list, not one value.
 *
 * `sanitizeCSSValue` judges a single property value. A style attribute is a
 * list of them, so the two are not interchangeable: applied to a whole
 * declaration list, `sanitizeCSSValue` can only answer all-or-nothing, and
 * applied to nothing at all the list is simply trusted. String-valued `style`
 * props took the latter path while object-valued ones were sanitized per
 * property, so the same authoring intent had two different security policies:
 *
 *   style: { background: dangerous }   → sanitized
 *   style: "background: dangerous"     → raw
 *
 * This closes that gap by splitting the list properly and applying the EXISTING
 * per-value policy to each declaration. Both authoring forms now behave alike.
 *
 * Parsing is delegated to the engine's own `CSSStyleDeclaration` rather than a
 * hand-rolled split on `;`, which would corrupt declarations that legitimately
 * contain semicolons inside quoted strings or functions (`url('a;b.png')`,
 * `content: 'a;b'`). Custom properties and `!important` survive. The probe
 * element is created detached and never inserted, so assigning to it parses
 * without fetching anything or affecting layout.
 *
 * Without a DOM (SSR in a bare runtime) there is no parser available, so the
 * conservative all-or-nothing check applies: a list containing anything
 * dangerous is dropped entirely rather than partially trusted.
 */
export function sanitizeStyleAttribute(cssText: string): string {
  const input = String(cssText);
  if (input.trim() === "") return "";

  if (typeof document === "undefined") {
    return sanitizeCSSValue(input) === "" ? "" : input;
  }

  const probe = document.createElement("div");
  try {
    probe.style.cssText = input;
    /* v8 ignore next 3 -- assigning cssText does not throw in supported engines */
  } catch {
    return "";
  }

  const declarations: string[] = [];
  for (let i = 0; i < probe.style.length; i++) {
    const property = probe.style[i];
    const value = probe.style.getPropertyValue(property);
    // Check the value on its own AND joined to its property name: the danger
    // list contains property-qualified forms (`behavior:`, `filter:progid`)
    // that only match once the name is present.
    if (sanitizeCSSValue(value) === "") continue;
    if (sanitizeCSSValue(`${property}:${value}`) === "") continue;
    const priority = probe.style.getPropertyPriority(property);
    declarations.push(`${property}: ${value}${priority ? ` !${priority}` : ""}`);
  }
  return declarations.join("; ");
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
  // `<html manifest>` is a URL sink too. It was carried only by the SSR
  // serializers' private copy of this set; folding that copy into this one would
  // otherwise have silently dropped its coverage.
  "manifest",
]);

/**
 * Attributes whose value the browser parses as a nested HTML DOCUMENT rather
 * than storing as inert text.
 *
 * There is exactly one today: `<iframe srcdoc>`. The browser decodes the
 * attribute value and parses the result as a full document, and without a
 * sandbox its scripts run with the embedding page's origin.
 *
 * This breaks the assumption the rest of the attribute policy rests on. HTML
 * attribute escaping is the correct treatment for an attribute *value* and does
 * nothing here, because the escaping is undone before the parse:
 *
 *     srcdoc="&lt;script&gt;…&lt;/script&gt;"   →   <script>…</script>
 *
 * So escaping is not a weaker fix, it is the wrong layer. Generic attribute
 * writers refuse the attribute outright instead. Sanitizing arbitrary HTML is a
 * different and much larger problem, deliberately not attempted here; a trusted
 * iframe document would need its own explicit API backed by a runtime-verifiable
 * wrapper (or browser Trusted Types), not a compile-time brand.
 *
 * Single source of truth: every writer and every SSR serializer consults this
 * rather than carrying its own spelling of the rule.
 */
const HTML_CONTENT_ATTRIBUTES = new Set(["srcdoc"]);

/**
 * Is `name` an attribute the browser parses as nested HTML?
 *
 * Case-insensitive: HTML attribute names are, and `SRCDOC` reaches the parser
 * as `srcdoc`.
 */
export function isHtmlContentAttribute(name: string): boolean {
  return HTML_CONTENT_ATTRIBUTES.has(name.toLowerCase());
}

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
 * Does this attribute name carry a value the policy inspects, rather than inert
 * text the browser stores verbatim?
 *
 * The distinction matters for one specific reason: for a policy sink, an empty
 * sanitizer result means REJECTED and the attribute must be omitted; for every
 * other attribute an empty string is simply a legitimate value. Callers that
 * conflate the two end up publishing `href=""` in place of a refused URL, which
 * is not the same thing as not publishing it at all.
 *
 * Case-insensitive, like every other name comparison here.
 */
export function isPolicyAttribute(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === "style" || URL_ATTRIBUTES.has(lower);
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
 *   - `srcdoc` is REFUSED by the callers of this function: the browser parses
 *     it as a nested HTML document, so no string treatment makes it safe. See
 *     `isHtmlContentAttribute`.
 *   - everything else passes through — `setAttribute` stores it as inert text.
 *     That is true of every remaining attribute, but it is a claim about the
 *     attributes NOT listed above, not a general property of `setAttribute`.
 *
 * Single source of truth shared by the static write path (`tagFactory`) and
 * the reactive write paths (`bindAttribute` / `bindDynamic`) so the two can
 * never drift on which attribute gets which treatment.
 */
export function sanitizeAttributeString(attr: string, value: string): string {
  const lower = attr.toLowerCase();
  if (lower === "srcset") return sanitizeSrcset(value);
  if (URL_ATTRIBUTES.has(lower)) return sanitizeUrl(value);
  // `style` being an allowed attribute NAME does not make an arbitrary style
  // VALUE trusted. Every generic writer (reactive bindings, html`` expressions,
  // prop spreads) funnels through here, so the declaration-list policy applies
  // to all of them rather than only to the tag factory.
  if (lower === "style") return sanitizeStyleAttribute(value);
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
