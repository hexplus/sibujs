/**
 * The embed policy: which third-party documents `embed()` may frame, and the
 * attribute values such a frame may carry.
 *
 * Shared by `embed()` (`sibujs/ui`), which writes the frame, and the SSR
 * serializer, which re-applies the same rules to an embed frame it emits, so a
 * frame changed behind the framework's back cannot leave the server with a
 * wider policy than the client gave it. Nothing in the core imports this
 * module, so it costs a client bundle nothing unless `embed()` is used.
 */

import { getRequestStore } from "../core/ssr-context";
import { globalSingleton } from "./globalSingleton";
import { sanitizeUrl } from "./sanitize";

/** An allowlist entry, parsed once by `setEmbedPolicy()`. */
interface AllowedEmbed {
  origin: string;
  /** `""` allows every path on the origin; otherwise a path prefix. */
  path: string;
}

/** A parsed allowlist. Treated as immutable: `setEmbedPolicy()` replaces it whole. */
export type EmbedAllowlist = readonly AllowedEmbed[];

/**
 * What `embed()` wrote on a frame: the allowlist in force when it was built and
 * the narrowed policy attributes. The SSR serializer judges the frame against
 * this record, never against attributes changed after construction.
 */
export interface EmbedRecord {
  allowed: EmbedAllowlist;
  sandbox: string;
  allow: string;
  referrer: string;
}

interface EmbedState {
  allowed: EmbedAllowlist;
  /** Frames built by `embed()`, so the SSR serializer can recognise them. */
  frames: WeakMap<Element, EmbedRecord>;
}

// Shared across duplicate copies of this module, like the other singletons:
// a policy set through one copy must hold for frames built by another.
const state = globalSingleton<EmbedState>(Symbol.for("sibujs.embed.v2"), () => ({
  allowed: [],
  frames: new WeakMap(),
}));

/** Key of the request-scoped allowlist in the SSR store's caches. */
const REQUEST_CACHE = "embed";

/**
 * The allowlist in force here: the current SSR request's own, when
 * `setEmbedPolicy()` was called inside it, otherwise the process-wide one.
 */
export function currentEmbedAllowlist(): EmbedAllowlist {
  const scoped = getRequestStore()?.caches?.get(REQUEST_CACHE)?.get("allowed");
  return (scoped as EmbedAllowlist | undefined) ?? state.allowed;
}

/**
 * The policy `embed()` enforces.
 *
 * Each entry of `allowedOrigins` is an absolute `https:` URL: an origin
 * (`"https://www.youtube-nocookie.com"`) allows every path on it; an origin
 * with a path (`"https://player.vimeo.com/video/"`) allows that path and what
 * lies beneath it. Credentials, a query or a fragment in an entry are refused.
 */
export interface EmbedPolicy {
  allowedOrigins: readonly string[];
}

/**
 * Set the origins `embed()` may frame. Replaces the previous policy; the
 * default allows nothing. Call it once at startup — on the server too, before
 * rendering.
 *
 * Inside `runInSSRContext()` it sets the policy of THAT request only, so a
 * multi-tenant server can configure each render without one request's
 * allowlist reaching another's. Outside a request it sets the process-wide
 * policy every request without its own falls back to.
 *
 * A frame is judged by the policy in force when `embed()` built it: a later
 * `setEmbedPolicy()` changes neither its getter `src` checks nor how SSR
 * serializes it.
 *
 * @throws TypeError for an entry that is not an absolute `https:` URL, or
 * that carries credentials, a query or a fragment.
 */
export function setEmbedPolicy(policy: EmbedPolicy): void {
  const allowed: AllowedEmbed[] = [];
  for (const entry of policy.allowedOrigins) {
    let url: URL | null = null;
    try {
      url = new URL(entry);
    } catch {
      url = null;
    }
    if (!url || url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
      throw new TypeError(
        `setEmbedPolicy: "${entry}" is not an allowed embed origin. Use an absolute https: URL, optionally with a ` +
          "path prefix, and no credentials, query or fragment.",
      );
    }
    allowed.push({ origin: url.origin, path: url.pathname === "/" ? "" : url.pathname });
  }
  const store = getRequestStore();
  if (store) {
    const caches = (store.caches ??= new Map<string, Map<string, unknown>>());
    let scoped = caches.get(REQUEST_CACHE);
    if (!scoped) {
      scoped = new Map<string, unknown>();
      caches.set(REQUEST_CACHE, scoped);
    }
    scoped.set("allowed", allowed);
  } else {
    state.allowed = allowed;
  }
}

/**
 * The URL an embed frame may load for `value`, normalised, or `null` when the
 * policy refuses it: not a string, not absolute `https:` (so `javascript:`,
 * `data:`, `blob:` and relative URLs are out), credentials, the page's own
 * origin, or no allowlist entry matching its origin and path.
 *
 * The returned string is the parsed URL's `href`, so the frame loads exactly
 * the URL that was checked — `/embed/../watch` is judged as `/watch`.
 *
 * @param allowed The allowlist to judge by; the one in force here by default.
 */
export function resolveEmbedSrc(value: unknown, allowed: EmbedAllowlist = currentEmbedAllowlist()): string | null {
  if (typeof value !== "string" || sanitizeUrl(value) === "") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  // A frame on the page's own origin with `allow-scripts allow-same-origin`
  // can remove its own sandbox; a player is always cross-origin.
  if (typeof location !== "undefined" && url.origin === location.origin) return null;
  for (const entry of allowed) {
    if (url.origin !== entry.origin) continue;
    const path = entry.path;
    if (path === "" || url.pathname === path || url.pathname.startsWith(path.endsWith("/") ? path : `${path}/`)) {
      return url.href;
    }
  }
  return null;
}

/**
 * The sandbox `embed()` applies by default — the tokens a hosted video player
 * needs and nothing more:
 *
 *   - `allow-scripts`, `allow-same-origin`: the player runs and keeps its own
 *     storage. Safe together only because the frame is never same-origin with
 *     the page (see `resolveEmbedSrc`).
 *   - `allow-presentation`: casting to a second screen.
 *   - `allow-popups`, `allow-popups-to-escape-sandbox`: "watch on …" links
 *     open a normal tab instead of a crippled sandboxed one.
 *
 * Absent on purpose: `allow-top-navigation*` (the player cannot navigate the
 * page), `allow-forms`, `allow-modals`, `allow-downloads`,
 * `allow-pointer-lock`, `allow-storage-access-by-user-activation`.
 */
export const DEFAULT_EMBED_SANDBOX: readonly string[] = [
  "allow-scripts",
  "allow-same-origin",
  "allow-presentation",
  "allow-popups",
  "allow-popups-to-escape-sandbox",
];

/**
 * Permissions-policy features an embed frame may be granted through `allow`:
 * what players use. Device and capability features (camera, microphone,
 * geolocation, payment, usb, …) are never delegated by `embed()`.
 */
const EMBED_FEATURES = new Set([
  "accelerometer",
  "autoplay",
  "clipboard-write",
  "encrypted-media",
  "fullscreen",
  "gyroscope",
  "picture-in-picture",
  "web-share",
]);

/** Referrer policies at least as strict as the default. */
const EMBED_REFERRER_POLICIES = new Set([
  "no-referrer",
  "same-origin",
  "strict-origin",
  "strict-origin-when-cross-origin",
]);

export const DEFAULT_EMBED_REFERRER_POLICY = "strict-origin-when-cross-origin";

/**
 * Narrow a `sandbox` value to the default tokens: a caller may drop tokens,
 * never add one. `""` (every restriction) is a valid result.
 */
export function narrowEmbedSandbox(value: string): string {
  const out: string[] = [];
  for (const token of value.toLowerCase().split(/[\t\n\f\r ]+/)) {
    if (token && DEFAULT_EMBED_SANDBOX.includes(token) && !out.includes(token)) out.push(token);
  }
  return out.join(" ");
}

/**
 * Narrow an `allow` value to the player features, written as bare feature
 * names — each then grants the feature to the frame's own origin (`'src'`).
 *
 * A feature is kept only when EVERY declaration of it grants the frame's
 * origin: its allowlist is empty, or holds `'src'` or `*`, and never `'none'`.
 * Rewriting a declaration as a bare name drops its allowlist, which is a
 * narrowing for `*` and `'src' https://other`, but would be a GRANT for
 * `'none'`, `'self'` (the embedding page's origin, not the frame's) or a list
 * of other origins — those features are left out instead. The browser honours
 * only the first declaration of a repeated feature; requiring all of them to
 * grant makes that rule irrelevant.
 *
 * Feature names are matched exactly: the browser treats them case-sensitively,
 * so `FullScreen` grants nothing and must not be folded into `fullscreen`.
 * Allowlist keywords (`'src'`, `'none'`) are case-insensitive, as they are to
 * the browser.
 */
export function narrowEmbedAllow(value: string): string {
  const granted: string[] = [];
  const denied: string[] = [];
  for (const directive of value.split(";")) {
    const tokens = directive.trim().split(/[\t\n\f\r ]+/);
    const feature = tokens[0];
    if (!feature) continue;
    const list = tokens.slice(1).map((token) => token.toLowerCase());
    const grantsSrc = (list.length === 0 || list.includes("'src'") || list.includes("*")) && !list.includes("'none'");
    if (!grantsSrc) denied.push(feature);
    else if (EMBED_FEATURES.has(feature) && !granted.includes(feature)) granted.push(feature);
  }
  return granted.filter((feature) => !denied.includes(feature)).join("; ");
}

/** A referrer policy at least as strict as the default, or the default. */
export function narrowEmbedReferrerPolicy(value: string): string {
  const lower = value.trim().toLowerCase();
  return EMBED_REFERRER_POLICIES.has(lower) ? lower : DEFAULT_EMBED_REFERRER_POLICY;
}

/** Record `frame` as built by `embed()`, with what it wrote. */
export function recordEmbedFrame(frame: Element, record: EmbedRecord): void {
  state.frames.set(frame, record);
}

/** What `embed()` wrote on `frame`, or `undefined` for any other element. */
export function getEmbedRecord(frame: Element): EmbedRecord | undefined {
  return state.frames.get(frame);
}

/** The tokens of `current` that `permitted` also holds, in `current`'s order. */
function intersect(current: string, permitted: string, separator: string): string {
  const allowed = permitted.split(separator);
  return current
    .split(separator)
    .filter((token) => token && allowed.includes(token))
    .join(separator);
}

/** What the SSR serializer has emitted for an `embed()` frame so far. */
export interface EmbedSerialization {
  sandbox: boolean;
  referrer: boolean;
  title: boolean;
  fullscreen: boolean;
}

/**
 * The value an `embed()` frame may be served with for attribute `name`
 * (lower-case), or `null` to omit it. For the SSR serializer, after the
 * generic attribute policy (`on*`, `srcdoc`, URL and style rules) has run.
 *
 * Fail-closed: only the attributes `embed()` writes, plus `id`, `class`,
 * `style`, `width`, `height`, `data-*` and `aria-*`, are served — a
 * capability attribute added later (`allowpaymentrequest`, `allowusermedia`,
 * …) is not. The policy attributes are re-judged against the frame's record:
 *
 *   - `src` against the allowlist the frame was built under;
 *   - `sandbox` and `allow` as the intersection of the current value and the
 *     one `embed()` wrote, so a mutation can only narrow them;
 *   - `referrerpolicy` is what `embed()` wrote, unless it is now `no-referrer`;
 *   - `loading` is `lazy` unless `eager`;
 *   - `allowfullscreen` follows the served `allow` (see
 *     {@link embedSerializationTail});
 *   - `title` must be non-blank.
 */
export function embedSerializedAttribute(
  record: EmbedRecord,
  seen: EmbedSerialization,
  name: string,
  value: string,
): string | null {
  switch (name) {
    case "src":
      return resolveEmbedSrc(value, record.allowed);
    case "title":
      if (!value.trim()) return null;
      seen.title = true;
      return value;
    case "sandbox":
      seen.sandbox = true;
      return intersect(narrowEmbedSandbox(value), record.sandbox, " ");
    case "allow": {
      const allow = intersect(narrowEmbedAllow(value), record.allow, "; ");
      if (allow.split("; ").includes("fullscreen")) seen.fullscreen = true;
      return allow || null;
    }
    case "referrerpolicy":
      seen.referrer = true;
      return value.trim().toLowerCase() === "no-referrer" ? "no-referrer" : record.referrer;
    case "loading":
      return value === "eager" ? "eager" : "lazy";
    case "id":
    case "class":
    case "style":
    case "width":
    case "height":
      return value;
    default:
      return name.startsWith("data-") || name.startsWith("aria-") ? value : null;
  }
}

/**
 * The attributes to append once every attribute of an `embed()` frame has
 * been through {@link embedSerializedAttribute}: the recorded `sandbox` and
 * `referrerpolicy` when the DOM no longer carries them, and `allowfullscreen`
 * exactly when the served `allow` grants `fullscreen`. Returns `null` when the
 * frame must not be served at all: it has no non-blank `title`, a state
 * `embed()` never produces.
 */
export function embedSerializationTail(record: EmbedRecord, seen: EmbedSerialization): string | null {
  if (!seen.title) return null;
  let tail = "";
  if (!seen.sandbox) tail += ` sandbox="${record.sandbox}"`;
  if (!seen.referrer) tail += ` referrerpolicy="${record.referrer}"`;
  if (seen.fullscreen) tail += ' allowfullscreen=""';
  return tail;
}
