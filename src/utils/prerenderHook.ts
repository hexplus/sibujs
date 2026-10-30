// ---------------------------------------------------------------------------
// The contract between an app being PRE-RENDERED at build time and the
// pre-renderer that runs it (`sibuVitePlugin({ prerender })`).
//
// The pre-renderer runs the real client entry in a registered DOM, waits until
// the page has settled, and serializes it. "Settled" cannot be guessed from the
// DOM alone — a lazy route chunk or a `fetch` leaves the DOM quiet while work is
// still in flight — so work the page depends on is REGISTERED here, and the
// pre-renderer waits for every registered promise before it serializes.
//
// The host is published on `globalThis` under a `Symbol.for` key, so the app's
// copy of sibujs and the pre-renderer agree on it even when they are separate
// module instances (the app is bundled; the pre-renderer is not).
// ---------------------------------------------------------------------------

const HOST_KEY = Symbol.for("sibujs.prerender.v1");

/**
 * What the pre-renderer publishes while a route is being rendered.
 * @internal
 */
export interface PrerenderHost {
  /** The route being rendered (`"/pricing"`). */
  readonly route: string;
  /** Hold serialization until `promise` settles. */
  wait(promise: PromiseLike<unknown>): void;
}

function host(): PrerenderHost | undefined {
  return (globalThis as { [HOST_KEY]?: PrerenderHost })[HOST_KEY];
}

/**
 * Whether this code is running inside the build-time pre-renderer.
 *
 * Use it to skip work that has no meaning at build time — analytics, a
 * websocket, a request to an API that is not reachable from the build machine —
 * so the route still renders its static shell.
 *
 * @returns `true` while a route is being pre-rendered.
 */
export function isPrerendering(): boolean {
  return host() !== undefined;
}

/**
 * The route being pre-rendered, or `null` outside the pre-renderer.
 *
 * @returns The route path, e.g. `"/pricing"`.
 */
export function prerenderRoute(): string | null {
  return host()?.route ?? null;
}

/**
 * Make the pre-renderer wait for `promise` before it serializes the page.
 * A no-op in the browser, so it can wrap any data load unconditionally.
 *
 * `fetch()` calls are awaited automatically; register anything else the
 * rendered content depends on (a timer, IndexedDB, a worker).
 *
 * @param promise Work the rendered page depends on.
 * @returns `promise`, unchanged.
 *
 * @example
 * ```ts
 * const products = prerenderWait(loadProductsFromCache());
 * ```
 */
export function prerenderWait<T extends PromiseLike<unknown>>(promise: T): T {
  host()?.wait(promise);
  return promise;
}
