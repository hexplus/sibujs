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
 *   each row "2.1.k7x." li#2.1.k7x.0
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

/** A child scope of `scope` identified by a key (an `each` row, a route record) rather than by position. */
export function keyedScope(scope: AdoptScope | null, key: unknown): AdoptScope | null {
  if (!scope?.s.on) return null;
  // FNV-1a over the key text: short, safe in an attribute, stable on both sides.
  const text = String(key);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return { p: `${scope.p}k${(h >>> 0).toString(36)}.`, n: 0, s: scope.s };
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
