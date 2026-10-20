import { devWarnLazy } from "../core/dev";
import { registerDisposer } from "../core/rendering/dispose";
import { noDocument } from "../core/rendering/requireDocument";
import { reactiveBinding } from "../reactivity/track";
import {
  DEFAULT_EMBED_REFERRER_POLICY,
  DEFAULT_EMBED_SANDBOX,
  markEmbedFrame,
  narrowEmbedAllow,
  narrowEmbedReferrerPolicy,
  narrowEmbedSandbox,
  resolveEmbedSrc,
} from "../utils/embedPolicy";

export { DEFAULT_EMBED_SANDBOX, type EmbedPolicy, setEmbedPolicy } from "../utils/embedPolicy";

/** Props for {@link embed}. */
export interface EmbedProps {
  /**
   * The player URL. Must be absolute `https:` and match the allowlist set with
   * `setEmbedPolicy()`. A getter is re-checked on every change; a refused or
   * `null` value leaves the frame without a `src`.
   */
  src: string | (() => string | null | undefined);
  /** Accessible name of the frame. Required. */
  title: string | (() => string);
  /**
   * Permissions-policy features, as in the `allow` attribute. Narrowed to the
   * player features (`accelerometer`, `autoplay`, `clipboard-write`,
   * `encrypted-media`, `fullscreen`, `gyroscope`, `picture-in-picture`,
   * `web-share`). Default: `"encrypted-media; picture-in-picture; fullscreen"`.
   */
  allow?: string;
  /**
   * Sandbox tokens. May only REMOVE tokens from `DEFAULT_EMBED_SANDBOX`; other
   * tokens are dropped. `""` applies every restriction.
   */
  sandbox?: string;
  /** Default `"strict-origin-when-cross-origin"`; only stricter values are accepted. */
  referrerpolicy?: "no-referrer" | "same-origin" | "strict-origin" | "strict-origin-when-cross-origin";
  /** Default `"lazy"`. */
  loading?: "lazy" | "eager";
  /** A CSS ratio such as `"16 / 9"`. Sizes the frame to the container's width. */
  aspectRatio?: string;
  class?: string;
  id?: string;
}

const DEFAULT_ALLOW = "encrypted-media; picture-in-picture; fullscreen";
const RATIO = /^\d+(\.\d+)?(\s*\/\s*\d+(\.\d+)?)?$/;

// Refused values already reported, so a list of players re-rendering the same
// bad URL warns once. Dev-only: written only inside `devWarnLazy` callbacks.
const warnedEmbeds = new Set<string>();

function warnEmbed(key: string, message: string): void {
  devWarnLazy(() => {
    if (warnedEmbeds.has(key) || warnedEmbeds.size >= 100) return "";
    warnedEmbeds.add(key);
    return message;
  });
}

/**
 * Embed a third-party player (YouTube, Vimeo, …) in an `<iframe>`.
 *
 * The tag factories, `svgElement()` and `DOMPool` refuse `iframe`; this is the
 * one runtime door, and it only opens onto origins the application allowlisted
 * with `setEmbedPolicy()`:
 *
 *   - `src` must be absolute `https:` and match an allowlisted origin and path
 *     prefix. A value outside the allowlist — a getter's included — is omitted
 *     and reported with a development warning. `javascript:`, `data:` and
 *     `blob:` can never match; neither can the page's own origin.
 *   - `title` is required. `srcdoc` is never written.
 *   - Safe defaults: `loading="lazy"`, `referrerpolicy=
 *     "strict-origin-when-cross-origin"`, `sandbox` set to
 *     `DEFAULT_EMBED_SANDBOX` (written before `src`, so it applies to the first
 *     document), and `allow` limited to player features. `sandbox`,
 *     `referrerpolicy` and `allow` can only be narrowed.
 *   - `renderToString` serializes the frame under the same policy.
 *
 * @example
 * ```ts
 * import { embed, setEmbedPolicy } from "sibujs/ui";
 * setEmbedPolicy({ allowedOrigins: ["https://www.youtube-nocookie.com/embed/"] });
 * embed({ src: `https://www.youtube-nocookie.com/embed/${id}`, title: "Product tour", aspectRatio: "16 / 9" });
 * ```
 *
 * @throws TypeError when `title` is missing or blank.
 */
export function embed(props: EmbedProps): HTMLIFrameElement {
  const { src, title } = props;
  if (typeof title !== "function" && (typeof title !== "string" || !title.trim())) {
    throw new TypeError("embed: `title` is required — it is the frame's accessible name.");
  }
  if (typeof document === "undefined") noDocument();
  if ("srcdoc" in props) {
    warnEmbed("srcdoc", "embed: `srcdoc` is never written — a frame's document must come from an allowlisted src.");
  }

  const el = document.createElement("iframe");
  markEmbedFrame(el);

  // Policy attributes first: the sandbox in particular is read when the frame
  // navigates, so it must be in place before `src` is.
  const sandbox = props.sandbox === undefined ? DEFAULT_EMBED_SANDBOX.join(" ") : narrowEmbedSandbox(props.sandbox);
  if (props.sandbox !== undefined && sandbox !== props.sandbox.trim().toLowerCase().split(/\s+/).join(" ")) {
    warnEmbed(
      `sandbox|${props.sandbox}`,
      `embed: sandbox "${props.sandbox}" was narrowed to "${sandbox}". A sandbox may only remove tokens from ` +
        `DEFAULT_EMBED_SANDBOX (${DEFAULT_EMBED_SANDBOX.join(" ")}).`,
    );
  }
  el.setAttribute("sandbox", sandbox);

  const allowIn = props.allow ?? DEFAULT_ALLOW;
  const allow = narrowEmbedAllow(allowIn);
  const requested = allowIn
    .split(";")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean)
    .join("; ");
  if (allow !== requested) {
    warnEmbed(
      `allow|${allowIn}`,
      `embed: allow "${allowIn}" was narrowed to "${allow}" — only player features are delegated.`,
    );
  }
  if (allow) el.setAttribute("allow", allow);
  if (allow.split("; ").includes("fullscreen")) el.setAttribute("allowfullscreen", "");

  const referrer = narrowEmbedReferrerPolicy(props.referrerpolicy ?? DEFAULT_EMBED_REFERRER_POLICY);
  if (props.referrerpolicy !== undefined && referrer !== props.referrerpolicy) {
    warnEmbed(
      `referrer|${props.referrerpolicy}`,
      `embed: referrerpolicy "${props.referrerpolicy}" is less strict than the default; using "${referrer}".`,
    );
  }
  el.setAttribute("referrerpolicy", referrer);
  el.setAttribute("loading", props.loading === "eager" ? "eager" : "lazy");

  if (props.aspectRatio !== undefined) {
    if (RATIO.test(props.aspectRatio.trim())) {
      el.style.setProperty("aspect-ratio", props.aspectRatio.trim());
      el.style.setProperty("width", "100%");
      el.style.setProperty("height", "auto");
      el.style.setProperty("border", "0");
    } else {
      warnEmbed(
        `ratio|${props.aspectRatio}`,
        `embed: aspectRatio "${props.aspectRatio}" is not a ratio such as "16 / 9".`,
      );
    }
  }
  if (typeof props.class === "string") el.setAttribute("class", props.class);
  if (typeof props.id === "string") el.id = props.id;

  if (typeof title === "function") {
    registerDisposer(
      el,
      reactiveBinding(() => el.setAttribute("title", String(title() ?? "")), el),
    );
  } else {
    el.setAttribute("title", title);
  }

  const commitSrc = (value: unknown) => {
    const safe = resolveEmbedSrc(value);
    if (safe === null) {
      el.removeAttribute("src");
      if (value != null) {
        warnEmbed(
          `src|${String(value)}`,
          `embed: refusing src "${String(value)}" — it is not an https: URL on an origin allowed by setEmbedPolicy().`,
        );
      }
      return;
    }
    if (el.getAttribute("src") !== safe) el.setAttribute("src", safe);
  };
  if (typeof src === "function") {
    registerDisposer(
      el,
      reactiveBinding(() => commitSrc(src()), el),
    );
  } else {
    commitSrc(src);
  }

  return el;
}
