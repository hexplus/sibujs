# Release-candidate API contract

Public semantics that have previously caused ambiguity, pinned to what the code
actually does at commit `35a103a` plus the three RC fixes. Every statement below
was verified against the implementation during this pass; where a claim could
not be verified it says so rather than guessing.

This document exists because several of the vacuous tests found during
certification were written against a *plausible* contract rather than the real
one. Read it before writing a test that asserts one of these behaviours.

---

## Entry points

There is **no `sibujs/router` subpath.** The router ships from
`sibujs/plugins`, alongside i18n and six other first-party plugins:

```ts
import { createRouter, Route, RouterLink } from "sibujs/plugins";
```

The 16 published subpaths are `.`, `./data`, `./browser`, `./patterns`,
`./motion`, `./ui`, `./widgets`, `./ssr`, `./devtools`, `./performance`,
`./ecosystem`, `./plugins`, `./build`, `./testing`, `./extras`, `./cdn`.
`./package.json` is **not** exported (see rc-findings PKG-001).

## Reactive primitives

`signal()` returns a **`[get, set]` tuple**, not a callable or a `.value` box:

```ts
const [count, setCount] = signal(0);
count();        // read
setCount(1);    // write
```

Writing a value equal to the current one is **deduplicated** and notifies
nothing. This is load-bearing for iteration-count assertions: a loop that
"changes" a boolean N times produces N−1 notifications if the first write
matches the initial value.

## `context()` is application-global

`context()` is a single application-wide store, not a per-tree or per-request
one. It is **not** request-scoped under SSR.

## `withContext()` is synchronous-only

The context set by `withContext()` is visible only for the synchronous duration
of the callback. Anything after an `await` sees whatever the ambient context is
at that point. Do not rely on it surviving an async boundary.

## `hydrate()` uses replacement hydration

`hydrate()` **replaces** server-rendered DOM rather than adopting existing
nodes. Node identity is not preserved across hydration. This is an
architectural characteristic, not a defect, and it is why the framework does not
claim "true hydration" — see `docs/support-matrix.md` caveats.

## A plain `<a href>` is never intercepted

Only `RouterLink` participates in client-side routing. There is no global anchor
interception. A plain anchor performs a full document navigation. Verified in
all three browser engines.

`RouterLink` respects `event.defaultPrevented`, modifier-clicks, middle-clicks,
and `target="_blank"`. WebKit same-tab-navigates on modifier/middle click where
Chromium fires `auxclick` — a documented engine difference, not a framework bug.

## Route components: what counts as "async"

`AsyncComponent = () => Promise<Element>` and `LazyComponent = () => Promise<{ default: Component }>`
are both accepted. As of RC-003 the runtime resolves a component by **result**,
not by syntax: if calling it yields a thenable, that promise is adopted and
awaited.

Before RC-003, classification was purely syntactic (`lazy()` marker,
`async function`, or `import(` in the source), and a plain arrow returning a
promise was mis-handled. Code that relied on the old error is unaffected — that
path only ever threw.

## `navigate()` does not load components

Navigation resolves the route and commits the path. **Component loading happens
in the `Route()` outlet**, not in `router.push()`. A `push()` can resolve
successfully while the component is still loading, or while it ultimately fails.

Corollary for tests: a router exercised without a mounted outlet performs **zero
component loading**. This made the first version of the router fuzz vacuous.

## The outlet keeps previous content while loading

`Route()` deliberately retains the previously rendered element while the next
component loads, rather than blanking. Therefore
`host.textContent` may legitimately disagree with `router.currentRoute.path`
mid-flight. The invariants that do hold:

- the outlet holds at most **one** route's content (it replaces, never accumulates);
- once everything settles, the outlet and the router agree.

## `ComponentLoader` caches and error-caches per route

A resolved component is cached per route definition, so revisiting a route
re-renders without re-invoking the loader. A **failed** load is recorded in an
error cache and further attempts are refused for `errorRetryDelay`
(default 1 000 ms) with `Component loading failed recently, retry in …`. A test
that fails a route's load and then immediately navigates back to it will get the
error UI — correctly.

## Guards: `Guard`, not `NavigationGuard`

`beforeEnter` takes a **`Guard`**:

```ts
type Guard = (to: RouteContext, from?: RouteContext) => boolean | string | Promise<boolean | string>;
```

It returns a verdict — `true` to allow, `false` to reject, a string to redirect.
It does **not** receive a `next` callback. The three-argument `next`-style
`NavigationGuard` is a separate type used by `beforeEach`/`beforeResolve`.

Passing the wrong shape makes every guarded navigation abort with
`{ success: false, type: "aborted", reason: "error" }`, which looks like a
router bug and hides the guard path entirely.

## Navigation result and abort reasons

```ts
type NavigationResult =
  | { success: true; route: RouteContext }
  | { success: false; type: NavigationFailure["type"]; reason?: NavigationFailureReason; failure: NavigationFailure };
```

`reason` distinguishes guard rejection from supersession — they were previously
indistinguishable (R-005). Router destruction stamps
`sibu:router-destroyed` on the navigation's `AbortSignal`; anything else is
treated as supersession.

## Query data belongs to the CacheEntry, not the key

`setQueryData(key, value)` is a **no-op when no live `CacheEntry` exists** for
that key:

```ts
const entry = getActiveQueryCache().get(key);
if (!entry) return;
```

Writing to a key nobody is observing does not create an entry and does not
persist. This is deliberate — data is owned by the entry, and `same key !== same
CacheEntry`.

`clearQueryCache()` **replaces entry identity**. Observers re-attach by entry
identity rather than by key string, which is what makes this safe (QRY-005).

## `query()` does not fetch under SSR

Its fetch is driven by an `effect()`, and effects are suppressed while the SSR
flag is set. Inside `runInSSRContext`, a `query()` creates no cache entry and
resolves no data — verified: 0 of 1 000 concurrent SSR requests ever observed a
value.

This is correct: server rendering must not initiate client data fetches. SSR
data arrives via loaders and `serializeState()` / `deserializeState()`. Do not
write an SSR test whose assertion depends on `query()` resolving.

## `retry` is an object, not a number

`retry?: RetryOptions` where `RetryOptions = { maxRetries?, strategy?, baseDelay?, maxDelay?, jitter?, shouldRetry? }`.
`{ retry: 0 }` does **not** mean "no retries" — `options?.maxRetries ?? 3`
evaluates to `3`, giving three retries with 1 s exponential backoff. Use
`{ retry: { maxRetries: 0 } }`. TypeScript rejects the numeric form; the test
suite did not previously type-check, which is how it slipped in.

## Query GC timer is unref'd

The `cacheTime` collection timer (default 300 000 ms) is `unref()`'d as of
RC-002, so it never holds a Node process open. Retry backoff, `refetchInterval`,
`debounce`, and `throttle` timers are deliberately left ref'd — each represents
work a caller is awaiting or an explicitly requested poll.

## SSR request scoping

`runInSSRContext(fn)` gives each request its own store and its own
request-scoped caches, backed by `AsyncLocalStorage` on Node. The scope survives
`await`. Verified with 1 000 genuinely interleaved concurrent requests: 1 000
distinct cache-map instances, and per-request suspense id sequences that each
start at `sibu-sus-0`.

On runtimes **without** `AsyncLocalStorage` the implementation falls back to a
mutated module-global store. Concurrency isolation is **not** guaranteed there.

## SSR Suspense failure semantics

Unchanged and still accurate:

```text
pending   → fallback
timeout   → fallback   (default 30 000 ms)
rejection → fallback
```

The emitted markup **does not distinguish a permanent failure from a still-pending
fallback**. A client cannot tell from the HTML alone whether content will ever
arrive. This is a deliberate simplification, not a defect — but it should be
stated in user-facing docs, because "fallback" reads as "loading".

## Streaming Suspense is batched, not per-boundary progressive

`renderToSuspenseStream` emits the shell early and then flushes async boundaries
**as a batch**, not independently as each resolves. The accurate description is:

> early shell + batched async boundary flush

It is **not** fully progressive per-boundary streaming, and must not be
described as such. Per §60 of the certification brief this was left alone: the
current semantics are safe and documented, and re-architecting streaming is
feature work, not hardening.

## `renderToString` requires a DOM

`renderToString(element: HTMLElement | DocumentFragment | Node)` takes real DOM
nodes. SSR therefore requires a DOM implementation on the server. See
`docs/support-matrix.md` for the edge-runtime consequence.

## Raw vs safe HTML

`trustHTML()` returns a branded `TrustedHTML` and is the **explicitly unsafe**
escape hatch. Everything else escapes. `renderToString` additionally strips
`<script>` and `<style>` entirely, validates attribute names, drops `on*`
handlers, and routes URL-bearing attributes through `sanitizeUrl`. The raw API
is intentionally raw and was not "fixed" during this pass.

## Import-time global registries

Importing SibuJS publishes **21 `Symbol.for` registries** on `globalThis`
(`sibujs.reactive.v1`, `sibujs.query.cache.v1`, `sibujs.router.v1`, …). This is
intentional: it lets duplicate copies of the runtime — which bundler
pre-bundling routinely creates — share one reactive world instead of forming two
silently disconnected ones.

Verified as the *only* import-time side effect: across all 16 subpaths, no
timers are started, no listeners installed, and no string-keyed globals created.
