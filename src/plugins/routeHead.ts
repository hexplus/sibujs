import { effect } from "../core/signals/effect";
import { signal } from "../core/signals/signal";
import { untracked } from "../reactivity/track";
import { acquireTitle, type ResourceLease } from "../utils/documentResources";
import { planHeadElementEntry, planMetaEntry, STATIC_VALUE_RESOLVER, serializeHeadEntry } from "../utils/headEntry";
import { sanitizeUrl } from "../utils/sanitize";
import type { RouteContext, RouteDef } from "./router";

// ---------------------------------------------------------------------------
// Per-route <head>: title, description, canonical URL and Open Graph tags that
// follow the committed route.
//
// The values go through the SAME entry policy `Head()` and both SSR paths use
// (`utils/headEntry.ts`): names are canonicalized, URL attributes pass the
// protocol allowlist, and a refused value is omitted rather than emptied. Open
// Graph `og:image` / `og:url` are URLs carried in `content`, which the shared
// policy treats as free text, so they are passed through `sanitizeUrl` here.
// ---------------------------------------------------------------------------

/**
 * One head value: a string, nothing, or a getter evaluated reactively against
 * the committed route — so route params (`(r) => \`Order ${r.params.id}\``) and
 * translated strings (`() => t("pricing.title")`) both work and stay current.
 * `null` explicitly clears a value a parent route or the defaults set.
 */
export type RouteHeadValue = string | null | undefined | ((route: RouteContext) => string | null | undefined);

/** Open Graph tags a route can set. */
export interface RouteHeadOpenGraph {
  /** `og:title`. Defaults to the route's title (without `titleTemplate`). */
  title?: RouteHeadValue;
  /** `og:description`. Defaults to the route's description. */
  description?: RouteHeadValue;
  /** `og:image` — use an ABSOLUTE URL; link-preview bots do not resolve relative ones. */
  image?: RouteHeadValue;
  /** `og:url`. Defaults to the canonical URL. */
  url?: RouteHeadValue;
  /** `og:type`, e.g. `"website"` or `"article"`. */
  type?: RouteHeadValue;
  /** `og:site_name`. */
  siteName?: RouteHeadValue;
}

/**
 * The `head` of a route record (and of `createRouter({ head })`, as defaults).
 *
 * Nested records merge field by field, the deepest record winning; the router
 * defaults sit underneath every route.
 */
export interface RouteHead {
  /** `document.title`. */
  title?: RouteHeadValue;
  /** `<meta name="description">`. */
  description?: RouteHeadValue;
  /** `<link rel="canonical">` — use an absolute URL. */
  canonical?: RouteHeadValue;
  /** Open Graph tags. */
  og?: RouteHeadOpenGraph;
  /**
   * Any other `<meta>` entries (`{ name: "robots", content: "noindex" }`,
   * `{ name: "twitter:card", content: "summary_large_image" }`). Identified by
   * their `name` or `property`; an entry with neither is ignored.
   */
  meta?: Record<string, RouteHeadValue>[];
}

/** Router-level head options: defaults for every route, plus the title template. */
export interface RouterHeadOptions extends RouteHead {
  /**
   * Wraps every route title: `"%s · Studio"` or `(title) => \`${title} · Studio\``.
   * Not applied to the default title itself.
   */
  titleTemplate?: string | ((title: string) => string);
}

/** One resolved `<head>` element, keyed by what it describes. */
export interface ResolvedHeadTag {
  /** Identity used to replace / remove the tag across navigations. */
  key: string;
  tag: "meta" | "link";
  attrs: Record<string, string>;
}

/** The head a route resolves to. */
export interface ResolvedRouteHead {
  title: string | null;
  tags: ResolvedHeadTag[];
}

const OG_FIELDS: [keyof RouteHeadOpenGraph, string][] = [
  ["title", "og:title"],
  ["description", "og:description"],
  ["image", "og:image"],
  ["url", "og:url"],
  ["type", "og:type"],
  ["siteName", "og:site_name"],
];

/** Open Graph properties whose content is a URL. */
const OG_URL_PROPERTIES = new Set(["og:image", "og:url"]);

/** Marker on every head element the router publishes (and the pre-renderer writes). */
export const ROUTE_HEAD_ATTR = "data-sibu-head";

/** Marker on a pre-rendered `<title>` carrying the template's own title. */
const BASE_TITLE_ATTR = "data-sibu-base-title";

/** Does any record in `matched`, or the defaults, declare a head? */
export function routeHasHead(matched: readonly RouteDef[], defaults: RouterHeadOptions | undefined): boolean {
  if (defaults) return true;
  for (const record of matched) if ((record as { head?: RouteHead }).head) return true;
  return false;
}

function resolveValue(value: RouteHeadValue, route: RouteContext): string | null {
  if (value == null) return null;
  const v = typeof value === "function" ? value(route) : value;
  return v == null ? null : String(v);
}

/** Merge the defaults and the matched chain, deepest record winning per field. */
function mergeHeads(route: RouteContext, defaults: RouterHeadOptions | undefined): RouteHead {
  const layers: RouteHead[] = [];
  if (defaults) layers.push(defaults);
  for (const record of route.matched) {
    const head = (record as { head?: RouteHead }).head;
    if (head) layers.push(head);
  }
  const merged: RouteHead = {};
  const og: RouteHeadOpenGraph = {};
  const meta = new Map<string, Record<string, RouteHeadValue>>();
  for (const layer of layers) {
    if (layer.title !== undefined) merged.title = layer.title;
    if (layer.description !== undefined) merged.description = layer.description;
    if (layer.canonical !== undefined) merged.canonical = layer.canonical;
    if (layer.og) {
      for (const [field] of OG_FIELDS) if (layer.og[field] !== undefined) og[field] = layer.og[field];
    }
    for (const entry of layer.meta ?? []) {
      const id = metaIdentity(entry);
      if (id) meta.set(id, entry);
    }
  }
  merged.og = og;
  merged.meta = Array.from(meta.values());
  return merged;
}

/** `name=…` / `property=…` identity of a free-form meta entry, or null. */
function metaIdentity(entry: Record<string, RouteHeadValue>): string | null {
  const name = typeof entry.name === "string" ? entry.name : null;
  if (name) return `name:${name.toLowerCase()}`;
  const property = typeof entry.property === "string" ? entry.property : null;
  if (property) return `property:${property.toLowerCase()}`;
  return null;
}

function applyTemplate(title: string, template: RouterHeadOptions["titleTemplate"]): string {
  if (!template) return title;
  return typeof template === "function" ? template(title) : template.replace("%s", title);
}

/**
 * Resolve the head a committed route renders: the router defaults, then every
 * matched record from the root down. Getters are invoked here, so calling this
 * inside an effect subscribes to whatever they read.
 *
 * @param route The committed route.
 * @param defaults `createRouter({ head })`, if any.
 * @returns The title and the tags, after the shared head policy.
 */
export function resolveRouteHead(route: RouteContext, defaults?: RouterHeadOptions): ResolvedRouteHead {
  const merged = mergeHeads(route, defaults);
  const ownTitle = resolveValue(merged.title, route);
  // The template wraps a ROUTE title, never the default one: the default is
  // usually the bare site name, and "Studio · Studio" is not a title.
  const routeSetTitle = route.matched.some((r) => (r as { head?: RouteHead }).head?.title != null);
  const title = ownTitle === null ? null : routeSetTitle ? applyTemplate(ownTitle, defaults?.titleTemplate) : ownTitle;
  const description = resolveValue(merged.description, route);
  const canonical = resolveValue(merged.canonical, route);

  const tags: ResolvedHeadTag[] = [];
  const push = (key: string, tag: "meta" | "link", attrs: Record<string, string>): void => {
    const plan =
      tag === "meta" ? planMetaEntry(attrs, STATIC_VALUE_RESOLVER) : planHeadElementEntry(attrs, STATIC_VALUE_RESOLVER);
    if (plan.kind === "drop") return;
    tags.push({ key, tag, attrs: Object.fromEntries(plan.attributes) });
  };

  if (description !== null) push("meta:name:description", "meta", { name: "description", content: description });
  if (canonical !== null) push("link:rel:canonical", "link", { rel: "canonical", href: canonical });

  const og = merged.og ?? {};
  for (const [field, property] of OG_FIELDS) {
    let value = og[field] === undefined ? undefined : resolveValue(og[field], route);
    // Fallbacks keep the common case to one declaration per fact: a page's
    // title, description and canonical URL are also what a link preview shows.
    if (value === undefined) {
      if (field === "title") value = ownTitle;
      else if (field === "description") value = description;
      else if (field === "url") value = canonical;
      else value = null;
    }
    if (value === null) continue;
    if (OG_URL_PROPERTIES.has(property)) {
      value = sanitizeUrl(value);
      if (value === "") continue;
    }
    push(`meta:property:${property}`, "meta", { property, content: value });
  }

  for (const entry of merged.meta ?? []) {
    const id = metaIdentity(entry);
    if (!id) continue;
    const attrs: Record<string, string> = {};
    for (const [name, v] of Object.entries(entry)) {
      const resolved = resolveValue(v, route);
      if (resolved !== null) attrs[name] = resolved;
    }
    push(`meta:${id}`, "meta", attrs);
  }

  return { title, tags };
}

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Serialize a resolved head to HTML, for SSR or a static page. Each tag carries
 * the `data-sibu-head` marker so the client router adopts it on start-up
 * instead of duplicating it.
 *
 * @param head The result of {@link resolveRouteHead}.
 * @returns `<title>` plus one element per tag.
 */
export function routeHeadToHTML(head: ResolvedRouteHead): string {
  const parts: string[] = [];
  if (head.title !== null) parts.push(`<title>${escapeText(head.title)}</title>`);
  for (const t of head.tags) {
    const html = serializeHeadEntry(t.tag, t.attrs);
    if (html) parts.push(html.replace(/ \/>$/, ` ${ROUTE_HEAD_ATTR}="" />`));
  }
  return parts.join("\n");
}

/** CSS selector for elements describing the same thing as `key`. */
function selectorFor(key: string): string {
  // key: "meta:name:description" | "meta:property:og:title" | "link:rel:canonical"
  const [tag, attr, ...rest] = key.split(":");
  const value = rest.join(":").replace(/["\\]/g, "\\$&");
  return `${tag}[${attr}="${value}" i]`;
}

/**
 * Keeps `document.title` and the route's head tags in step with the committed
 * route. Created by the router the first time a route (or the router) declares
 * a head, so an app that never uses `head` is never touched.
 * @internal
 */
export interface RouteHeadController {
  /** Show the head of `route`. */
  update(route: RouteContext): void;
  /** Stop, remove the published tags and give the title back. */
  dispose(): void;
}

/** @internal */
export function createRouteHeadController(defaults: RouterHeadOptions | undefined): RouteHeadController {
  const [current, setCurrent] = signal<RouteContext | null>(null);
  const owned = new Map<string, Element>();
  // Head elements that existed before the router took over — the HTML
  // template's static tags, or a pre-rendered page's route tags. The router
  // replaces one the first time it publishes the same key. Elements added
  // later (a component's `Head()`) are never touched.
  const initial = new Set<Element>(Array.from(document.head.children));
  const titleEl = document.head.querySelector("title");
  // On a pre-rendered page `<title>` holds that route's title; the template's
  // own title travels in an attribute so a route without a title restores it.
  const baseTitle = titleEl?.getAttribute(BASE_TITLE_ATTR) ?? document.title;
  let titleLease: ResourceLease<string> | null = null;
  let firstApply = true;

  const publish = (tag: ResolvedHeadTag): void => {
    const existing = owned.get(tag.key);
    if (existing && sameAttrs(existing, tag.attrs)) return;
    if (!existing) {
      for (const el of Array.from(document.head.querySelectorAll(selectorFor(tag.key)))) {
        if (initial.has(el)) {
          el.remove();
          initial.delete(el);
        }
      }
    }
    // Built detached and swapped in with one operation, as `Head()` does, so no
    // half-updated element is ever connected.
    const next = document.createElement(tag.tag);
    for (const [name, value] of Object.entries(tag.attrs)) next.setAttribute(name, value);
    next.setAttribute(ROUTE_HEAD_ATTR, "");
    if (existing?.parentNode) existing.replaceWith(next);
    else document.head.appendChild(next);
    owned.set(tag.key, next);
  };

  const apply = (head: ResolvedRouteHead): void => {
    if (firstApply) {
      firstApply = false;
      // Pre-rendered route tags are this router's by construction; any the
      // current route does not set again would otherwise linger forever.
      for (const el of Array.from(document.head.querySelectorAll(`[${ROUTE_HEAD_ATTR}]`))) {
        if (initial.has(el) && !head.tags.some((t) => el.matches(selectorFor(t.key)))) {
          el.remove();
          initial.delete(el);
        }
      }
    }
    const keep = new Set<string>();
    for (const tag of head.tags) {
      keep.add(tag.key);
      publish(tag);
    }
    for (const [key, el] of owned) {
      if (keep.has(key)) continue;
      el.remove();
      owned.delete(key);
    }
    const title = head.title ?? baseTitle;
    if (titleLease) titleLease.set(title);
    else titleLease = acquireTitle(title);
  };

  const stop = effect(() => {
    const route = current();
    if (route === null) return;
    const head = resolveRouteHead(route, defaults);
    untracked(() => apply(head));
  });

  return {
    update(route) {
      setCurrent(route);
    },
    dispose() {
      stop();
      for (const el of owned.values()) el.remove();
      owned.clear();
      titleLease?.release();
      titleLease = null;
    },
  };
}

function sameAttrs(el: Element, attrs: Record<string, string>): boolean {
  const names = Object.keys(attrs);
  // +1 for the marker attribute.
  if (el.attributes.length !== names.length + 1) return false;
  for (const name of names) if (el.getAttribute(name) !== attrs[name]) return false;
  return true;
}
