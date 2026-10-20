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

import { globalSingleton } from "./globalSingleton";
import { sanitizeUrl } from "./sanitize";

/** An allowlist entry, parsed once by `setEmbedPolicy()`. */
interface AllowedEmbed {
  origin: string;
  /** `""` allows every path on the origin; otherwise a path prefix. */
  path: string;
}

interface EmbedState {
  allowed: AllowedEmbed[];
  /** Frames built by `embed()`, so the SSR serializer can recognise them. */
  frames: WeakSet<Element>;
}

// Shared across duplicate copies of this module, like the other singletons:
// a policy set through one copy must hold for frames built by another.
const state = globalSingleton<EmbedState>(Symbol.for("sibujs.embed.v1"), () => ({
  allowed: [],
  frames: new WeakSet(),
}));

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
 * default allows nothing. Configuration, not data: call it once at startup —
 * on the server too, before rendering.
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
  state.allowed = allowed;
}

/**
 * The URL an embed frame may load for `value`, normalised, or `null` when the
 * policy refuses it: not a string, not absolute `https:` (so `javascript:`,
 * `data:`, `blob:` and relative URLs are out), credentials, the page's own
 * origin, or no allowlist entry matching its origin and path.
 *
 * The returned string is the parsed URL's `href`, so the frame loads exactly
 * the URL that was checked — `/embed/../watch` is judged as `/watch`.
 */
export function resolveEmbedSrc(value: unknown): string | null {
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
  for (const entry of state.allowed) {
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
 * names (each then defaults to the frame's own origin). Origin lists in the
 * input are dropped with the rest of the directive's syntax.
 */
export function narrowEmbedAllow(value: string): string {
  const out: string[] = [];
  for (const directive of value.split(";")) {
    const feature = directive
      .trim()
      .split(/[\t\n\f\r ]+/)[0]
      ?.toLowerCase();
    if (feature && EMBED_FEATURES.has(feature) && !out.includes(feature)) out.push(feature);
  }
  return out.join("; ");
}

/** A referrer policy at least as strict as the default, or the default. */
export function narrowEmbedReferrerPolicy(value: string): string {
  const lower = value.trim().toLowerCase();
  return EMBED_REFERRER_POLICIES.has(lower) ? lower : DEFAULT_EMBED_REFERRER_POLICY;
}

/** Record `frame` as built by `embed()`. */
export function markEmbedFrame(frame: Element): void {
  state.frames.add(frame);
}

/** Was `frame` built by `embed()`? */
export function isEmbedFrame(frame: Element): boolean {
  return state.frames.has(frame);
}

/**
 * The value an embed frame may carry for attribute `name` (lower-case), or
 * `null` to omit it. Attributes the policy does not govern pass through.
 * For the SSR serializer.
 */
export function embedAttributeValue(name: string, value: string): string | null {
  switch (name) {
    case "src":
      return resolveEmbedSrc(value);
    case "sandbox":
      return narrowEmbedSandbox(value);
    case "allow":
      return narrowEmbedAllow(value);
    case "referrerpolicy":
      return narrowEmbedReferrerPolicy(value);
    default:
      return value;
  }
}
