/**
 * THE meta-refresh policy — one implementation for client, SSR, and router SSR.
 *
 * WHY A PARSER
 * ------------
 * `<meta http-equiv="refresh" content="…">` is a grammar, and the browser's
 * refresh parser accepts far more than one spelling of it. The previous policy
 * asked whether the lower-cased content *contained* `url=javascript:` (plus
 * three sibling schemes), which recognises exactly one form. Every one of these
 * is a live redirect the substring never saw:
 *
 *     0; url = javascript:alert(1)      whitespace around the separator and `=`
 *     0;URL=JAVASCRIPT:alert(1)         mixed-case key and scheme
 *     0;url='javascript:alert(1)'       quoted destination
 *     0;\turl\t=\tjavascript:alert(1)   tabs
 *
 * Pattern-matching a grammar is a losing position: each new spelling needs a new
 * pattern, and the attacker picks the spelling. So the destination is EXTRACTED
 * structurally and then handed to `sanitizeUrl()` — the same protocol authority
 * every other URL sink in the framework uses. Adding a scheme to that allowlist
 * now fixes every sink at once, including this one.
 *
 * DELIBERATELY STRICTER THAN THE BROWSER
 * --------------------------------------
 * This is NOT a claim of exact parity with the WHATWG refresh algorithm. Real
 * browsers are extremely permissive: they recover from malformed directives,
 * tolerate junk around tokens, and differ from one another at the edges.
 * Matching that permissiveness would mean reproducing recovery behaviour we
 * cannot verify across the whole support floor.
 *
 * The rule here is the opposite: anything this parser cannot read *unambiguously*
 * is refused. A directive we cannot confidently interpret the way the browser
 * will is exactly the case where "no forbidden substring was found" is worthless
 * evidence. The cost is that a small number of odd-but-harmless directives are
 * dropped; the benefit is that no unreadable directive is ever emitted.
 */

import { sanitizeUrl, stripControlChars } from "./sanitize";

/**
 * The verdict on one meta entry.
 *
 * A discriminated union rather than a boolean, because the four outcomes are
 * genuinely different and callers act differently on them: `not-refresh` means
 * "ignore me, I'm a description tag", while `forbidden` means "drop the whole
 * element". A boolean forced those two into one answer.
 */
export type MetaRefreshDecision =
  | { kind: "not-refresh" }
  | { kind: "delay-only"; delay: number }
  | { kind: "allowed"; delay: number; destination: string; sanitizedDestination: string }
  | { kind: "forbidden"; reason: string };

/** ASCII whitespace, as the HTML parser defines it. */
function isAsciiWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f";
}

function trimAsciiWhitespace(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && isAsciiWhitespace(value[start])) start++;
  while (end > start && isAsciiWhitespace(value[end - 1])) end--;
  return value.slice(start, end);
}

const forbidden = (reason: string): MetaRefreshDecision => ({ kind: "forbidden", reason });

/**
 * Parse a `content` value into a refresh decision.
 *
 * Grammar accepted (all whitespace runs optional, `url` case-insensitive):
 *
 *     content := WS* delay WS*                                  → delay-only
 *              | WS* delay WS* ";" WS* "url" WS* "=" WS* dest WS*
 *     delay   := DIGIT+                                         (no sign, no exponent)
 *     dest    := "'" … "'" | '"' … '"' | unquoted-run
 *
 * Anything else — a second `;`, a key that is not `url`, an unterminated quote,
 * trailing junk after a quoted destination, an empty destination, a
 * non-numeric delay — is `forbidden`.
 */
export function parseMetaRefreshContent(content: string): MetaRefreshDecision {
  // Control characters are stripped for the SAME reason `sanitizeUrl` strips
  // them: browsers ignore them while parsing, so `java\tscript:` and
  // `url=` must not be readable as anything other than what the browser
  // will see.
  const raw = trimAsciiWhitespace(stripControlChars(content));
  if (raw === "") return forbidden("empty content");

  // --- delay ---------------------------------------------------------------
  let i = 0;
  while (i < raw.length && raw[i] >= "0" && raw[i] <= "9") i++;
  if (i === 0) return forbidden("missing or non-numeric delay");
  const delay = Number.parseInt(raw.slice(0, i), 10);
  if (!Number.isFinite(delay)) return forbidden("unparseable delay");

  while (i < raw.length && isAsciiWhitespace(raw[i])) i++;

  // Delay only — a plain self-refresh, no destination to police.
  if (i === raw.length) return { kind: "delay-only", delay };

  // Anything between the delay and a `;` that is not whitespace means the
  // delay token did not actually end where it appeared to (`0url=/x`).
  if (raw[i] !== ";" && raw[i] !== ",") return forbidden("unexpected text after delay");
  i++;

  while (i < raw.length && isAsciiWhitespace(raw[i])) i++;

  // --- key -----------------------------------------------------------------
  const keyStart = i;
  while (i < raw.length && !isAsciiWhitespace(raw[i]) && raw[i] !== "=") i++;
  const key = raw.slice(keyStart, i).toLowerCase();
  if (key !== "url") return forbidden(`unsupported refresh key ${JSON.stringify(key)}`);

  while (i < raw.length && isAsciiWhitespace(raw[i])) i++;
  if (raw[i] !== "=") return forbidden("missing '=' after url");
  i++;
  while (i < raw.length && isAsciiWhitespace(raw[i])) i++;

  // --- destination ---------------------------------------------------------
  let destination: string;
  const quote = raw[i];
  if (quote === '"' || quote === "'") {
    const close = raw.indexOf(quote, i + 1);
    // An unterminated quote is genuinely ambiguous: browsers disagree about
    // where such a destination ends, so it is refused rather than guessed.
    if (close === -1) return forbidden("unterminated quoted destination");
    destination = raw.slice(i + 1, close);
    const rest = trimAsciiWhitespace(raw.slice(close + 1));
    if (rest !== "") return forbidden("trailing text after quoted destination");
  } else {
    destination = trimAsciiWhitespace(raw.slice(i));
    // A second assignment means two competing destinations; which one wins is
    // not something to guess at.
    if (/[;,]/.test(destination)) return forbidden("multiple refresh assignments");
  }

  if (destination === "") return forbidden("empty destination");

  // --- protocol policy -----------------------------------------------------
  // Delegated, never re-implemented: `sanitizeUrl` is the single authority on
  // which schemes may appear in a URL sink, and it already understands the
  // obfuscations (`java\tscript:`, leading control bytes) an attacker reaches
  // for. It returns "" for anything it refuses.
  const sanitizedDestination = sanitizeUrl(destination);
  if (sanitizedDestination === "") return forbidden("destination uses a disallowed protocol");

  return { kind: "allowed", delay, destination, sanitizedDestination };
}

/**
 * Resolve the policy for a complete, already-normalized meta attribute map.
 *
 * The map must be the EFFECTIVE snapshot — the attributes as they will exist on
 * the element — so that what is validated is what gets committed. Building that
 * snapshot is `normalizeMetaAttributes`'s job.
 */
export function resolveMetaRefreshPolicy(attributes: ReadonlyMap<string, string>): MetaRefreshDecision {
  let httpEquiv: string | undefined;
  let content: string | undefined;
  let duplicateName: string | undefined;

  // One pass, case-folded, and *detecting* duplicates rather than letting the
  // first or last one silently win. See `normalizeMetaAttributes`.
  const seen = new Set<string>();
  for (const [key, value] of attributes) {
    const lower = key.toLowerCase();
    if (seen.has(lower)) duplicateName = lower;
    seen.add(lower);
    if (lower === "http-equiv") httpEquiv = value;
    else if (lower === "content") content = value;
  }

  if (duplicateName !== undefined) {
    return forbidden(`duplicate case-insensitive attribute ${JSON.stringify(duplicateName)}`);
  }

  if (typeof httpEquiv !== "string") return { kind: "not-refresh" };
  if (trimAsciiWhitespace(stripControlChars(httpEquiv)).toLowerCase() !== "refresh") {
    return { kind: "not-refresh" };
  }
  // A refresh with no content directs nothing.
  if (typeof content !== "string") return { kind: "not-refresh" };

  return parseMetaRefreshContent(content);
}

/**
 * Fold a raw attribute record into the effective snapshot, or reject it.
 *
 * HTML attribute names are case-insensitive; JavaScript object keys are not. So
 * this object is legal, and was the bug:
 *
 *     { "http-equiv": "x-custom", "HTTP-EQUIV": "refresh", content: "0;url=javascript:…" }
 *
 * A helper returning the FIRST case-insensitive match validated `x-custom`,
 * while the DOM loop wrote both attributes and the later `HTTP-EQUIV` became
 * the effective value. The verdict and the commit were about different entries.
 *
 * The rule chosen is REJECTION, not precedence. Last-write-wins would also be
 * sound if the validated value were provably the committed one, but rejection
 * removes the class of bug rather than re-parameterising it — and duplicate
 * casings in a meta entry are a mistake in every real case, not an idiom worth
 * preserving.
 *
 * Returns `null` when the record must be dropped entirely.
 */
export function normalizeMetaAttributes(props: Record<string, string>): Map<string, string> | null {
  const out = new Map<string, string>();
  const seen = new Set<string>();
  for (const key of Object.keys(props)) {
    const lower = key.toLowerCase();
    if (seen.has(lower)) return null;
    seen.add(lower);
    out.set(key, props[key]);
  }
  return out;
}

/**
 * Should this meta entry be dropped?
 *
 * The convenience wrapper the serializers use: a duplicate-casing record or a
 * forbidden refresh both mean "emit nothing".
 */
export function isForbiddenMetaEntry(props: Record<string, string>): boolean {
  const normalized = normalizeMetaAttributes(props);
  if (normalized === null) return true;
  return resolveMetaRefreshPolicy(normalized).kind === "forbidden";
}
