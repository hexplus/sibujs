import { effect } from "../core/signals/effect";
import { signal } from "../core/signals/signal";
import type { ServerHeadLayer } from "../platform/serverHead";
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

/** Twitter card tags a route can set (`twitter:*`). Declaring any turns on the fallbacks below. */
export interface RouteHeadTwitter {
  /** `twitter:card`, e.g. `"summary_large_image"`. */
  card?: RouteHeadValue;
  /** `twitter:site`, the site's handle. */
  site?: RouteHeadValue;
  /** `twitter:creator`. */
  creator?: RouteHeadValue;
  /** `twitter:title`. Defaults to the Open Graph title. */
  title?: RouteHeadValue;
  /** `twitter:description`. Defaults to the Open Graph description. */
  description?: RouteHeadValue;
  /** `twitter:image` (absolute URL). Defaults to `og:image`. */
  image?: RouteHeadValue;
}

/** One `<link rel="alternate" hreflang>` translation of the page. */
export interface RouteHeadAlternate {
  /** BCP 47 language tag, or `"x-default"`. */
  hreflang: string;
  /** Absolute URL of the translated page. */
  href: RouteHeadValue;
}

/**
 * A JSON-LD object (`{ "@context": "https://schema.org", "@type": "Product", … }`).
 * Serialized with `JSON.stringify` and the script escaping `serializeState`
 * uses, so `</script>`, `<!--` and U+2028/U+2029 in the data cannot leave the
 * script element.
 */
export type JsonLd = { [key: string]: JsonLdValue };
type JsonLdValue = string | number | boolean | null | JsonLdValue[] | { [key: string]: JsonLdValue };

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
  /** `<meta name="robots">`, e.g. `"noindex, nofollow"`. A `noindex` route is left out of the sitemap. */
  robots?: RouteHeadValue;
  /** Twitter card tags. */
  twitter?: RouteHeadTwitter;
  /** Translations of the page (`<link rel="alternate" hreflang>`), identified by `hreflang`. */
  alternates?: RouteHeadAlternate[] | ((route: RouteContext) => RouteHeadAlternate[]);
  /** Structured data: one or more JSON-LD objects, or a getter returning them. */
  jsonLd?: JsonLd | JsonLd[] | ((route: RouteContext) => JsonLd | JsonLd[] | null | undefined);
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
  tag: "meta" | "link" | "script";
  attrs: Record<string, string>;
  /** Text content (the escaped JSON of a JSON-LD script). */
  text?: string;
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
const OG_URL_PROPERTIES = new Set(["og:image", "og:url", "twitter:image"]);

const TWITTER_FIELDS: [keyof RouteHeadTwitter, string][] = [
  ["card", "twitter:card"],
  ["site", "twitter:site"],
  ["creator", "twitter:creator"],
  ["title", "twitter:title"],
  ["description", "twitter:description"],
  ["image", "twitter:image"],
];

/** Marker identifying a JSON-LD script the router publishes (its index). */
const JSON_LD_ATTR = "data-sibu-ld";

/**
 * Serialize JSON-LD for a `<script type="application/ld+json">` body: `<`, `>`,
 * `&`, U+2028 and U+2029 become `\u` escapes, which JSON parsers read back as
 * the original characters, so the data can never close the script element.
 *
 * @param data One JSON-LD object or a list of them.
 * @returns The escaped JSON text.
 */
export function serializeJsonLd(data: JsonLd | JsonLd[]): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * A complete JSON-LD `<script>` element, for a backend template or a static
 * page. The only non-executable script SibuJS emits: its type is
 * `application/ld+json` and its body is {@link serializeJsonLd}'s output.
 *
 * @param data One JSON-LD object or a list of them.
 * @returns `<script type="application/ld+json">…</script>`.
 */
export function jsonLdScript(data: JsonLd | JsonLd[]): string {
  return `<script type="application/ld+json">${serializeJsonLd(data)}</script>`;
}

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
  let twitter: RouteHeadTwitter | undefined;
  for (const layer of layers) {
    if (layer.title !== undefined) merged.title = layer.title;
    if (layer.description !== undefined) merged.description = layer.description;
    if (layer.canonical !== undefined) merged.canonical = layer.canonical;
    if (layer.robots !== undefined) merged.robots = layer.robots;
    if (layer.alternates !== undefined) merged.alternates = layer.alternates;
    if (layer.jsonLd !== undefined) merged.jsonLd = layer.jsonLd;
    if (layer.og) {
      for (const [field] of OG_FIELDS) if (layer.og[field] !== undefined) og[field] = layer.og[field];
    }
    if (layer.twitter) {
      twitter ??= {};
      for (const [field] of TWITTER_FIELDS)
        if (layer.twitter[field] !== undefined) twitter[field] = layer.twitter[field];
    }
    for (const entry of layer.meta ?? []) {
      const id = metaIdentity(entry);
      if (id) meta.set(id, entry);
    }
  }
  merged.og = og;
  merged.twitter = twitter;
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
    // Deepest record wins: a free-form `meta` entry for the same key replaces
    // a field-derived one, keeping the first one's position.
    const existing = tags.findIndex((t) => t.key === key);
    if (existing !== -1) tags.splice(existing, 1);
    const plan =
      tag === "meta" ? planMetaEntry(attrs, STATIC_VALUE_RESOLVER) : planHeadElementEntry(attrs, STATIC_VALUE_RESOLVER);
    if (plan.kind === "drop") return;
    tags.push({ key, tag, attrs: Object.fromEntries(plan.attributes) });
  };

  if (description !== null) push("meta:name:description", "meta", { name: "description", content: description });
  const robots = resolveValue(merged.robots, route);
  if (robots !== null) push("meta:name:robots", "meta", { name: "robots", content: robots });
  if (canonical !== null) push("link:rel:canonical", "link", { rel: "canonical", href: canonical });

  const alternates = typeof merged.alternates === "function" ? merged.alternates(route) : merged.alternates;
  for (const alt of alternates ?? []) {
    const href = resolveValue(alt.href, route);
    if (href === null || !alt.hreflang) continue;
    push(`link:hreflang:${alt.hreflang.toLowerCase()}`, "link", { rel: "alternate", hreflang: alt.hreflang, href });
  }

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

  if (merged.twitter) {
    const tw = merged.twitter;
    const ogValue = (field: keyof RouteHeadOpenGraph): string | null => {
      const fromOg = og[field] === undefined ? undefined : resolveValue(og[field], route);
      if (fromOg !== undefined) return fromOg;
      return field === "title" ? ownTitle : field === "description" ? description : null;
    };
    for (const [field, name] of TWITTER_FIELDS) {
      let value = tw[field] === undefined ? undefined : resolveValue(tw[field], route);
      if (value === undefined && (field === "title" || field === "description" || field === "image")) {
        value = ogValue(field);
      }
      if (value == null) continue;
      if (OG_URL_PROPERTIES.has(name)) {
        value = sanitizeUrl(value);
        if (value === "") continue;
      }
      push(`meta:name:${name}`, "meta", { name, content: value });
    }
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

  const ld = typeof merged.jsonLd === "function" ? merged.jsonLd(route) : merged.jsonLd;
  const ldList = ld == null ? [] : Array.isArray(ld) ? ld : [ld];
  ldList.forEach((data, i) => {
    let text: string;
    try {
      text = serializeJsonLd(data);
    } catch {
      return;
    }
    tags.push({
      key: `script:${JSON_LD_ATTR}:${i}`,
      tag: "script",
      attrs: { type: "application/ld+json", [JSON_LD_ATTR]: String(i) },
      text,
    });
  });

  return { title, tags };
}

/** One resolved tag as HTML, with the router's ownership marker. */
function tagToHTML(t: ResolvedHeadTag): string {
  if (t.tag === "script") {
    return `<script type="application/ld+json" ${JSON_LD_ATTR}="${t.attrs[JSON_LD_ATTR]}" ${ROUTE_HEAD_ATTR}="">${t.text ?? ""}</script>`;
  }
  const html = serializeHeadEntry(t.tag, t.attrs);
  return html ? html.replace(/ \/>$/, ` ${ROUTE_HEAD_ATTR}="" />`) : "";
}

/**
 * The head a committed route contributes to a server render: its title (when
 * it resolves one) and each tag as HTML keyed for deduplication.
 * @internal
 */
export function serverHeadLayer(route: RouteContext, defaults: RouterHeadOptions | undefined): ServerHeadLayer {
  const head = resolveRouteHead(route, defaults);
  return {
    title: head.title ?? undefined,
    tags: head.tags.map((t) => ({ key: t.key, html: tagToHTML(t) })).filter((t) => t.html !== ""),
  };
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
    const html = tagToHTML(t);
    if (html) parts.push(html);
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
    if (existing && sameAttrs(existing, tag.attrs) && (tag.text === undefined || existing.textContent === tag.text))
      return;
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
    // JSON-LD only: a non-executable data block, its text already escaped.
    if (tag.tag === "script" && tag.attrs.type === "application/ld+json") next.textContent = tag.text ?? "";
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
