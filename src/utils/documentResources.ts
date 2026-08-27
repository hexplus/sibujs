/**
 * Owner-aware access to the document's SINGLETON head resources.
 *
 * `document.title` and `<base>` can each have exactly one effective value, so
 * they need the lease semantics in `./singletonResource` rather than the
 * per-element create/remove treatment that suits `<meta>` / `<link>` /
 * `<script>`.
 *
 * Both managers are `globalSingleton`-held so that `Head()` (platform) and
 * `title()` (browser) — and any duplicated copy of either module a bundler
 * materializes — contend for ONE stack. Two independent stacks over the same
 * global resource would reintroduce exactly the clobbering the stack exists to
 * prevent.
 */

import { globalSingleton } from "./globalSingleton";
import { type ResourceLease, type SingletonResource, singletonResource } from "./singletonResource";

export type { ResourceLease };

/** The attributes that define a `<base>` element. `null` means "no base tag". */
export interface BaseSpec {
  href?: string;
  target?: string;
}

/** A lease that does nothing — returned wherever there is no DOM (SSR). */
const INERT_LEASE: ResourceLease<never> = {
  set() {},
  release() {},
};

function inertLease<T>(): ResourceLease<T> {
  return INERT_LEASE as unknown as ResourceLease<T>;
}

const titleResource = globalSingleton(Symbol.for("sibujs.documentTitle.v1"), () =>
  singletonResource<string>({
    read: () => document.title,
    write: (value) => {
      document.title = value;
    },
  }),
);

const baseResource = globalSingleton(Symbol.for("sibujs.documentBase.v1"), () =>
  singletonResource<BaseSpec | null>({
    read: () => {
      const el = document.head.querySelector("base");
      if (!el) return null;
      // Captured verbatim: a server-rendered <base> is already trusted markup,
      // and re-sanitizing it on restore could silently alter the page's
      // resolution semantics rather than putting back what was there.
      return {
        href: el.getAttribute("href") ?? undefined,
        target: el.getAttribute("target") ?? undefined,
      };
    },
    write: (spec) => {
      const existing = document.head.querySelector("base");
      if (spec === null) {
        existing?.remove();
        return;
      }
      // Reuse the element rather than remove-and-append: HTML honours only the
      // FIRST <base>, so keeping a single node is what makes "latest owner
      // wins" actually true in the document.
      const el = existing ?? document.head.appendChild(document.createElement("base"));
      if (spec.href === undefined) el.removeAttribute("href");
      else el.setAttribute("href", spec.href);
      if (spec.target === undefined) el.removeAttribute("target");
      else el.setAttribute("target", spec.target);
    },
  }),
);

/**
 * Take ownership of `document.title`.
 *
 * The returned lease writes the title only while it is the newest live owner,
 * and releasing it hands control back to the previous owner — or restores the
 * title the document had before SibuJS touched it, when no owners remain.
 */
export function acquireTitle(value: string): ResourceLease<string> {
  if (typeof document === "undefined") return inertLease<string>();
  return (titleResource as SingletonResource<string>).acquire(value);
}

/**
 * Take ownership of the document's `<base>` element.
 *
 * Pass a spec to install one. Releasing restores the previous owner's base, or
 * the server-rendered `<base>` that existed first — which the previous
 * implementation deleted outright, permanently changing how every relative URL
 * on the page resolved.
 */
export function acquireBase(spec: BaseSpec): ResourceLease<BaseSpec | null> {
  if (typeof document === "undefined") return inertLease<BaseSpec | null>();
  return (baseResource as SingletonResource<BaseSpec | null>).acquire(spec);
}
