/**
 * Creation scopes for adopting hydration (see docs/architecture/hydration-adopt.md).
 *
 * The server and the browser agree on an id for every element a builder
 * creates. An id is a PATH, not a global counter: each directive (`when`,
 * `match`, `each` row, reactive child, `lazy()`, `Suspense`, route outlet)
 * opens its own scope, and an element's id is its creation index inside the
 * scope it was built in. So a branch the server rebuilt after its data arrived,
 * or two boundaries that resolved in a different order, still get the ids the
 * browser's first build gives them.
 *
 *   App scope ""        div#0  span#1  when → scope "2."
 *   when branch "2."    ul#2.0 each → scope "2.1."
 *   each row "2.1._a."  li#2.1._a.0    (key "a"; key 7 → "2.1.-7.")
 *
 * Nothing here runs unless a server render asked for adoption markers or a
 * browser hydration is adopting: with no current scope every hook is one
 * comparison. The sink deciding what an id means (stamp it on the server,
 * claim the server element in the browser) lives in `sibujs/ssr`.
 */

/** What a scope's elements are created through. */
export interface AdoptSink {
  /** False once the session is over: scopes stop numbering, and nothing is claimed any more. */
  on: boolean;
  /** Create (server) or claim (browser) the element with `id`; `null` means "create it normally". */
  el(tag: string, ns: string | undefined, id: string): Element | null;
  /** The hydration session a browser sink belongs to (see `hydrationHooks`). */
  h?: unknown;
}

/** A creation scope: id prefix, next index, the sink. */
export interface AdoptScope {
  p: string;
  n: number;
  s: AdoptSink;
}

let current: AdoptScope | null = null;

/** True while a builder runs inside an adopt scope (server marking or browser adoption). */
export function inAdoptScope(): boolean {
  return current?.s.on === true;
}

/** The sink of the scope a builder runs in now, or `null` outside any live scope. */
export function currentSink(): AdoptSink | null {
  return current?.s.on ? current.s : null;
}

/**
 * Create an element the way a tag factory does, through the current scope's
 * sink when there is one.
 */
export function createScopedElement(tag: string, ns?: string): Element {
  const c = current;
  if (c?.s.on) {
    const el = c.s.el(tag, ns, c.p + (c.n++).toString(36));
    if (el) return el;
  }
  return ns ? document.createElementNS(ns, tag) : document.createElement(tag);
}

/**
 * Reserve a child scope at the current position — call it where a directive
 * is CREATED, synchronously, so its slot is part of the parent's sequence.
 */
export function captureScope(): AdoptScope | null {
  const c = current;
  return c?.s.on ? { p: `${c.p}${(c.n++).toString(36)}.`, n: 0, s: c.s } : null;
}

/**
 * A child scope of `scope` identified by a key (an `each` row, a route record)
 * rather than by position.
 *
 * The segment encodes the key itself, so distinct keys never share a scope:
 * `_` and the text for a string, `-` and `String(key)` for a number — so `1`
 * and `"1"` differ, while `0` and `-0` (one key in the reconciler's `Map`)
 * agree, as do two `NaN`s. Every character outside `[A-Za-z0-9_-]` becomes `~`
 * and its four-hex-digit UTF-16 unit: the segment stays attribute-safe and
 * never holds the `.` that ends it, and a positional segment (base 36) never
 * starts with `_` or `-`. Any other key type is rejected.
 */
export function keyedScope(scope: AdoptScope | null, key: unknown): AdoptScope | null {
  if (!scope?.s.on) return null;
  const type = typeof key;
  if (type !== "string" && type !== "number") {
    throw new TypeError(`[SibuJS] adopt: a key must be a string or a number, not ${type}`);
  }
  const text = String(key).replace(/[^\w-]/g, (c) => `~${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return { p: `${scope.p}${type === "string" ? "_" : "-"}${text}.`, n: 0, s: scope.s };
}

/**
 * Run a build inside `scope`, restarting its index at 0 — every rebuild of a
 * branch numbers its elements the way the first build did.
 */
export function inScope<T>(scope: AdoptScope | null, fn: () => T): T {
  const prev = current;
  if (!scope && !prev) return fn();
  current = scope?.s.on ? { p: scope.p, n: 0, s: scope.s } : null;
  try {
    return fn();
  } finally {
    current = prev;
  }
}
