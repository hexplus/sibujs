# Router Architecture

## Problem

Map a URL to a component tree, and keep browser history, route state, and the
DOM in agreement — while navigations can be superseded at any `await` by a user
clicking a different link, a `popstate`, or router teardown.

The hard part is not matching. It is **ownership**: deciding which of several
in-flight navigations is allowed to change anything.

## The navigation transaction model

Each navigation is a transaction owning an `AbortController`. Starting a new
navigation aborts the previous one, so at most one transaction is ever active.

```text
navigate("/b")
    │
    ▼
abort previous navigation
    │
    ▼
resolve target path ──► reject unsafe URI schemes
    │
    ▼
same route as current? ──yes──► fail: "duplicated"
    │ no
    ▼
run beforeEach guards (global)
    │
    ▼
match route
    │
    ▼
run beforeEnter guards (per matched route, outer → inner)
    │
    ▼
resolve redirects (bounded, depth ≤ 10)
    │
    ▼
run beforeResolve guards (global)
    │
    ▼
┌─────────────────────────────────┐
│  COMMIT BOUNDARY                │
│  is this navigation still       │
│  the active one?                │
└─────────────────────────────────┘
    │ no ──────────► fail: "aborted", change nothing
    │ yes
    ▼
update history (unless skipHistory)
    │
    ▼
set current route  ──► outlet re-renders reactively
    │
    ▼
run afterEach hooks
    │
    ▼
apply scroll behaviour
```

### The commit boundary

Everything above the boundary is preparation and may be discarded freely.
Everything below mutates shared state. This is the single place the governing
invariant is enforced:

> **Only the currently active navigation may commit router state.**

A superseded navigation looks like this:

```text
transaction A                     transaction B
     │
     ├─ await beforeEnter guard
     │                                 │
     │                            B starts, aborts A
     │                                 │
     │                            B commits ──► /fast
     │
  guard resolves
     │
     ▼
  commit boundary: A.signal.aborted?
     │
    yes
     │
     ▼
   STOP — no history write, no route change,
          no afterEach, no scroll
```

The check lives at the boundary rather than after each individual `await`
because the boundary is where every path converges, and redirect recursion
re-enters it on every hop. Two additional checks exist purely to stop stale work
early: after the raw `await` on a route's `beforeEnter`, and before the loop in
each global guard runner — the latter because an empty guard list would
otherwise never reach the in-loop check.

### Post-commit side effects cannot revoke a navigation

The boundary cuts the transaction in two, and the halves have opposite powers:

```text
resolve · guards · load
commit route + history
──────────────────────────── COMMIT BOUNDARY
afterEach hooks
scroll behaviour
```

```text
pre-commit work      CAN prevent the navigation
post-commit work     CANNOT revoke it
```

Once the route and history are committed they are authoritative. Anything below
the boundary is an optional, fallible side effect, and its failure is reported
rather than promoted into a navigation failure. The forbidden state is a
`NavigationResult` that disagrees with the router's own state:

```text
router.currentRoute.path === "/b"   and   location shows /b
                    but
await router.navigate("/b") → { success: false }
```

`scrollBehavior` is the concrete case. It is a **browser-only** hook, and it is
handled in this order:

```text
scrollBehavior configured?
        ↓ yes
scrolling primitives available?   (requestAnimationFrame AND window.scrollTo)
        ↓ no  → return without invoking the callback
        ↓ yes
invoke scrollBehavior, isolated    → throws? report, keep the navigation
        ↓
position returned?
        ↓ no  → return
        ↓ yes
schedule the scroll, isolated      → throws? report, no uncaught async error
```

The environment guard deliberately runs **before** the callback. A
`scrollBehavior` implementation is browser code — it may read `window.scrollY`,
measure an element, inspect `document` — so invoking it where its result would
be discarded gains nothing and gives it a chance to throw on a global that does
not exist. The two primitives are probed separately because they can be missing
independently (a partial DOM shim; jsdom without `pretendToBeVisual`).

The scheduled scroll is isolated on its own, because it runs on a frame callback
outside the navigation promise entirely — an exception there has no catcher and
would surface as an uncaught async error.

### Why cancellation is enforced, not just signalled

The `AbortController` plumbing existed before this hardening pass. It was not
enough: a signal nothing consults is documentation, not cancellation. See R-001
in [router-findings.md](../hardening/router-findings.md).

## Route matching

Deterministic and side-effect free.

- Static full paths resolve through an exact-match map.
- Routes containing `:param` or `*` are kept in a specificity-ordered list,
  rebuilt lazily after mutation.
- Specificity per segment: **static (2) > param (1) > wildcard (0)**, compared
  segment by segment.
- The sort is **stable**, so equal-specificity routes keep registration order.

Consequently `/users/new` always beats `/users/:id`, regardless of declaration
order.

Compiled path patterns are cached in a 50-entry LRU.

| Operation | Complexity |
|---|---|
| static path match | O(1) map lookup |
| pattern match | O(p) over pattern routes, p = routes containing `:` or `*` |
| pattern order rebuild | O(p log p), amortised — only after route mutation |

## Guard pipeline

Order, which is fixed and tested:

```text
beforeEach   (global, in registration order)
beforeEnter  (per matched route, outermost → innermost)
redirects
beforeResolve (global, in registration order)
── commit ──
afterEach    (global; errors are caught and logged, never fail the navigation)
```

A guard returns `true` (allow), `false` (block → `aborted`), or a path string
(redirect). Global guards run through a runner with a 5 s default timeout that
rejects on abort; `beforeEnter` is awaited directly and re-checked for
staleness afterwards.

## Redirects

Bounded at `MAX_REDIRECT_DEPTH = 10`. On overflow the navigation fails as
`aborted`, and development builds print the hop sequence so the cycle is
visible:

```text
[SibuJS] Router: redirect loop detected — navigation aborted after 10 hops.
  "/login" -> "/dashboard" -> "/login" -> ...
```

Every redirect target is a navigation target, and is validated by exactly the
same policy as `navigate()` — see
[Navigation target policy](#navigation-target-policy). Route `redirect`,
`beforeEach`, `beforeEnter` and `beforeResolve` redirects are not special-cased:
a target that one of them refuses is refused by all of them.

## Route tree ownership and the Outlet

`Route()` returns a comment anchor and manages its rendered content as
**siblings** of that anchor — the same anchored-range model as `each()` (see
[dom-ownership.md](./dom-ownership.md)).

It holds a monotonic `navSeq`. Every update claims the next number; after an
`await`, a resolution commits only if its token is still current.

```text
navigate /slow  ──► navSeq 7 ──► await lazy chunk
navigate /fast  ──► navSeq 8 ──► mounts immediately
lazy chunk resolves with token 7 ≠ 8 ──► dropped, never mounted
```

This is why a stale lazy route cannot mount UI even though
`performNavigation` does **not** await component loading — navigation commits
first, and the outlet resolves the component afterwards.

On replacement the outgoing subtree is `dispose()`d before detaching, so route
components are disposed exactly once per replacement.

### Outlet ownership

`Route()` and the nested `Outlet()` follow the same rule as every other async
owner in the framework:

> Async completion does not imply commit ownership. Only the current live owner
> may commit.

Both wrap their commit like this:

```text
await component load
      ↓
ownership check      ← torn? superseded? (before user code, so stale work
      ↓                 never invokes a component factory at all)
component()          ← arbitrary user code
      ↓
ownership check      ← re-checked, and the parent re-read
      ↓
synchronous commit
```

The second check exists because **user component creation is itself an ownership
boundary**: a factory may synchronously navigate, dispose its own owner, or
otherwise invalidate the generation before it returns. See
[async-ownership.md § User-code reentrancy](./async-ownership.md#user-code-reentrancy-invariant).

A node built by a generation that has lost ownership is **disposed**, not
dropped — it already owns effects, listeners and registered disposers by the
time ownership is checked.

Teardown marks the outlet torn and advances the generation *before* releasing
anything, so every pending continuation permanently loses ownership.

#### Loading and instantiating are separate

> Route component factories are invoked only when SibuJS creates an actual route
> component instance. Loader and preload resolution never invoke them
> speculatively.

Three distinct concepts:

```text
route definition loading   →  resolve the plan: a factory, or a module to import
component instantiation    →  invoke the factory exactly once, per instance
mounted-instance ownership →  the Element belongs to the route generation
```

```text
lazy module cache
      ↓
component factory
      ↓
the current route generation invokes it once
      ↓
Element instance belongs to that generation
```

The loader caches **plans** — factories and resolved modules — never Elements. A
side effect inside a component factory therefore runs once per mounted instance,
which is what you would expect.

#### AsyncComponent ownership

A direct `AsyncComponent` (`() => Promise<Element>`) is supported as a
first-class route component.

> A resolved Element from an `AsyncComponent` belongs to the route generation
> that requested it. If that generation becomes stale before commit, SibuJS
> disposes the Element. Resolved Elements are never cached as reusable route
> factories.

Each real instantiation invokes the `AsyncComponent` again and receives its own
Element, so revisiting a route never remounts a previously disposed instance. If
your `AsyncComponent` deliberately returns the same Element every time, that is
your choice — the router does not introduce reuse on its own.

Caching policy:

| Thing | Cached by the loader? |
|---|---|
| lazy imported module / its default factory | yes |
| synchronous `Component` factory | yes |
| Element resolved by a direct `AsyncComponent` | **no** |

Preloading never produces such an Element in the first place — see
[Preloading](#preloading).

The loader cache and the [KeepAlive](#the-keepalive-outlet) instance cache are
different things: KeepAlive deliberately caches *mounted instances* and owns
their lifecycle; the loader caches only how to *produce* an instance.

## The KeepAlive outlet

`KeepAliveRoute()` caches rendered views so signals, form state, and scroll
position survive navigation. It runs the same ownership model as `Route()` —
a monotonic `updateSeq` claimed on entry and re-checked after every `await` —
plus a teardown flag checked at the same boundaries.

### Cache identity and async ownership are separate concepts

This is the distinction the outlet is built around, and conflating the two is
what made stale loads commit:

```text
cache key        answers:  "Which cached view is this?"
update generation answers: "May this async completion still commit?"
```

They are not interchangeable, because

```text
same route value  !=  same navigation generation
```

A cache key is derived from the **full location** — path + query + hash:

| Location | Cache key | Distinct view? |
|---|---|---|
| `/search?q=a` | `/search?q=a` | yes |
| `/search?q=b` | `/search?q=b` | yes — query is part of identity |
| `/docs#one` | `/docs#one` | yes — hash is part of identity |
| `/users/1` vs `/users/2` | different | yes |

Ownership is never inferred from any of those. Two navigations differing only in
query share a pathname; an A → B → A round trip returns to an identical key
under a *different* generation. So a superseded load whose key still "matches"
must still be refused:

```text
KeepAlive update 4 ──► /search?q=a ──► await lazy chunk
KeepAlive update 5 ──► /search?q=b ──► becomes current
chunk resolves with token 4 ≠ 5 ──► dropped, never created, never cached
```

### Commit rules

- The ownership check runs **before** the node is created, so a superseded
  generation never registers effects or listeners at all.
- It runs **again** immediately before the commit, because `component()` is user
  code that can navigate or tear the outlet down synchronously. If ownership is
  lost at that point the created node is `dispose()`d — returning would leak
  every disposer it just registered.
- The commit itself — detach outgoing, update LRU, cache, insert — is
  **synchronous**, so ownership cannot lapse midway through it.
- The currently mounted view stays attached while a replacement loads. A
  generation that never earns the right to commit therefore cannot leave the
  outlet empty.

### Lifetime

| Event | Effect on a cached view |
|---|---|
| Navigated away from | detached from the DOM, kept in cache, **not** disposed |
| Navigated back to | the same node is re-attached — no remount |
| Evicted past `max` (LRU) | disposed and dropped |
| Excluded by `include` | never cached; disposed on navigation away |
| Outlet disposed / `destroyRouter()` | whole cache disposed and cleared |

After the outlet is disposed, no in-flight load may repopulate the cache or
re-insert into the DOM — the teardown flag and the generation counter are both
advanced, and both are checked at the commit boundary.

## History integration

| Action | History effect |
|---|---|
| `push(to)` / `navigate(to)` | `history.pushState` — one new entry |
| `replace(to)` | `history.replaceState` — no new entry |
| `popstate` (back/forward) | navigates with history updates suppressed — **no new entry** |
| superseded navigation | nothing |
| navigation after teardown | nothing |

Programmatic navigation, browser navigation, and history mutation are kept
distinct so a `popstate` cannot feed back into a `pushState` and manufacture
extra entries.

## Teardown

`destroyRouter()` aborts the active navigation, runs registered cleanups,
clears guards, clears the component cache, and disposes mounted route content.
After teardown no in-flight navigation can commit — enforced by the same commit
boundary.

## Navigation results

A failed navigation reports both a coarse `type` and a finer `reason`:

```ts
const result = await navigate("/admin");
if (!result.success && result.reason === "guard") {
  showMessage("You do not have access to that page.");
}
```

| `reason` | Meaning | Usually surfaced to the user? |
|---|---|---|
| `guard` | a guard returned `false` | yes |
| `superseded` | a newer navigation started first | no — routine during rapid navigation |
| `router-destroyed` | teardown cancelled it | no |
| `redirect-loop` | exceeded the redirect hop limit | dev diagnostic |
| `unsafe-target` | target is not SPA-navigable — see [Navigation target policy](#navigation-target-policy) | dev diagnostic |
| `duplicate` | identical to the current route | no |
| `error` | unexpected fault | yes |

`reason` is additive: `type` values are unchanged, so existing code branching on
`type` is unaffected.

## Preloading

> `preloadRoute()` only executes explicitly deferred route loaders — routes
> wrapped with `lazy()`. Directly supplied component factories are never invoked
> during preload, even if they return a Promise or dynamically import a module
> during actual navigation.

Preload is the one place the router would run a route function before it needs
an instance, so **permission to do that is explicit**, never inferred:

```text
PRELOAD EXECUTION REQUIRES EXPLICIT AUTHORITY
```

```text
PRELOAD
   ↓
explicitly branded module loader only
   ↓
no component invocation
   ↓
no DOM, no lifecycle resources
```

| Route definition | What preload does |
|---|---|
| `lazy(() => import("./Page"))` | imports the module, caches its default factory — **uninvoked** |
| `() => import("./Page")` | no-op — not branded, so not preloadable |
| `() => element` | no-op — the factory is already here |
| `async () => element` | no-op — nothing separable to fetch |
| `() => Promise.resolve(element)` | no-op — same reason |

To make a dynamically imported route preloadable, wrap the loader with `lazy()`:

```ts
// Preloadable.
{ path: "/page", component: lazy(() => import("./Page")) }

// Works, but preloadRoute() is a no-op for it.
{ path: "/page", component: () => import("./Page") }
```

Everything unbranded is treated as a component factory: the only thing calling
it achieves is building the component, which is instantiation, not preloading.
`preloadRoute()` never invokes such a factory even to discover what it returns —
`dispose()` cannot undo an analytics call, a store write, or a log line, so
"call it and throw the result away" is not a form of preloading.

Preloadability is deliberately **not** inferred from what a function looks like.
A brand survives TypeScript, every bundler, and minification because it is part
of runtime behaviour; source text does not, in either direction — an ordinary
component can mention `import(` in a string or comment, and a bundler can
rewrite a real dynamic import into its own chunk-loader call.

### Preload cannot surface component errors

Because the factory is never invoked, preloading cannot discover that a
component returns the wrong thing or throws while building. Those surface during
real instantiation, through the route's normal error handling.

A **module-load** failure is different and is still reported: importing a lazy
route's module can genuinely fail during preload, and that error follows the
existing retry/error policy. A failed preload never changes the current route.

## Navigation target policy

Router navigation accepts **internal targets only**. A single private
classifier decides, and every programmatic entrypoint calls it, so the rules
cannot drift apart between them.

| Kind | What it is | Router behaviour |
|---|---|---|
| `internal` | a path, `?query`, `#hash`, or relative reference | navigated |
| `external` | absolute URL with an allowed scheme (`http:`, `https:`, `mailto:`, `tel:`, `ftp:`) | refused — SPA routing cannot service an off-origin URL, and an absolute target derived from untrusted input is an open-redirect vector (CWE-601) |
| `unsafe` | dangerous scheme (`javascript:`, `data:`, `vbscript:`, `blob:`, `file:`, …) or protocol-relative `//host` | refused, and never rendered as a live `href` |

Both refusals report `reason: "unsafe-target"`. The distinction between
"dangerous" and "merely unsupported" is internal — it changes the diagnostic,
not the outcome, and no public API was added for it.

Protocol-relative `//host` is classified `unsafe` rather than `external`: it
carries no scheme to vet and is the classic open-redirect obfuscation.

### One policy, every entrypoint

| Target | `navigate()` | RouterLink click | Redirect (route / `beforeEach` / `beforeEnter` / `beforeResolve`) |
|---|---|---|---|
| `/internal` | navigates | intercepts → SPA navigation | followed |
| `?q=x` | navigates | intercepts → SPA navigation | followed |
| `#hash` | navigates | intercepts → SPA navigation | followed |
| `https://external` | refused, `unsafe-target` | **not intercepted** — native browser navigation | refused, `unsafe-target` |
| `//external` | refused, `unsafe-target` | `href="#"`, click swallowed | refused, `unsafe-target` |
| `javascript:` | refused, `unsafe-target` | `href="#"`, click swallowed | refused, `unsafe-target` |
| `data:` | refused, `unsafe-target` | `href="#"`, click swallowed | refused, `unsafe-target` |

RouterLink's external column is the one deliberate divergence, and it is
explained under [Link interception](#link-interception).

### Validation precedes side effects

The target is classified **before** route resolution and before any history
mutation. A cross-origin `pushState` throwing `SecurityError` is never the
enforcement mechanism: it would report `error` rather than `unsafe-target`, and
only after the navigation had already begun.

### Classification is structural, not textual

The classifier inspects the target's *structure*. A scheme exists only when the
`:` precedes any `/`, `?` or `#`. That is what keeps these ordinary internal
paths working, despite the dangerous-looking text they carry as **data**:

```text
/search?q=https%3A%2F%2Fexample.com    → internal
/path/javascript%3Afoo                  → internal
```

Leading control characters and whitespace are stripped, and `\` is folded to
`/`, before any check — browsers do the same when parsing a URL, so
`"	//evil.com"` and `"/\/evil.com"` are classified on what the browser would
actually resolve them to.

## Link interception

SibuJS installs **no global document click handler**. Only anchors created by
`RouterLink()` intercept clicks; a plain `<a href="/x">` performs a real browser
navigation and leaves the SPA. This is deliberate — no global side effects, and
consistent with the package's `sideEffects: false` claim — but it differs from
routers that capture every same-origin anchor.

`RouterLink` declines to intercept when any of these hold:

```text
event.defaultPrevented    — app code already cancelled the click
target attribute set      — e.g. target="_blank"
metaKey / ctrlKey / shiftKey / altKey
button !== 0              — middle or right click
```

In every one of those cases the browser's own behaviour is left untouched.

`RouterLink` also declines to intercept an **external absolute URL**:

```ts
RouterLink({ to: "https://example.com" })   // real href, native navigation
```

`RouterLink` performs SPA navigation only for internal router targets. An
external URL is a perfectly good `<a href>`, but `RouterLink` is not an
external-navigation API — intercepting one would feed an off-origin URL into
SPA routing, where it is refused, leaving a link that silently does nothing at
all. For a purely external link, an ordinary `<a href>` is the clearer choice;
`RouterLink` is worth it only when the same component may render either an
internal or an external target.

A **dangerous** target is neutralized rather than delegated: the `href`
collapses to `"#"` and the click is swallowed, so it neither routes nor scrolls
the document.

Note that engines differ in what that native behaviour *is*: Chromium fires
`auxclick` for a middle click and opens a new tab for modifier clicks, while
WebKit performs a real same-tab navigation. Both are correct; neither involves
the router.

## RouterLink active state

Two classes, two different questions.

```text
activeClass       — is this link's target the current route, or an ancestor of it?
exactActiveClass  — is this link's target the current location exactly?
```

Defaults are `router-link-active` and `router-link-exact-active`, overridable
per link (`activeClass` / `exactActiveClass`) or per router
(`linkActiveClass` / `linkExactActiveClass`).

### activeClass — segment-boundary ancestor matching

The target matches when it **is** the current pathname, or is one of its
ancestors **on a path segment boundary**:

```text
current === target   OR   current starts with target + "/"
```

Raw prefix matching would make `/user` active on `/users`, which is why the
boundary is explicit:

| Link | Current route | `active` |
|---|---|---|
| `/user` | `/users` | no — different segment |
| `/product` | `/products` | no — different segment |
| `/user` | `/user` | yes |
| `/user` | `/user/123` | yes — descendant |
| `/users` | `/users/123` | yes — descendant |

This is `RouterLink` state only; route *matcher* semantics are untouched. It
also operates on resolved URLs, not route pattern strings — a link to `/users`
is active on `/users/123` whether that route was declared as `/users/:id` or
literally.

### Root is active only on root

```text
link "/"   current "/"        → active + exact-active
link "/"   current "/users"   → NOT active
```

Every path descends from `/`, so generic ancestor logic would light up a "Home"
link on every page in the app. That is not useful navigation UI, so `/` is
special-cased: it is active only when the current pathname is `/`. This is a
deliberate contract, pinned by tests — not a side effect of the prefix rule.

### exactActiveClass — full target identity

`exactActive` compares the **whole normalized target**: pathname *and* query
*and* hash.

```text
/search?q=a   vs   /search?q=a    → active + exact-active
/search?q=a   vs   /search?q=b    → active, NOT exact-active
/docs#one     vs   /docs#one      → active + exact-active
/docs#one     vs   /docs#two      → active, NOT exact-active
```

`/search?q=a` and `/search?q=b` are distinct navigation targets, so a link to
one is not "exactly" the other. Query parameter **order is not significant**:
`?b=2&a=1` and `?a=1&b=2` are the same target.

Note that this is `RouterLink`'s decision alone. The `KeepAlive` cache keys on
`path + query + hash` too, but the two are independent choices that happen to
agree; neither implies the other.

### Non-internal links are never active

Active classes are router state, so only a target the router would actually
navigate can carry them. An external or unsafe target never receives
`activeClass` or `exactActiveClass`, whatever its sanitized `href` happens to
parse to — an unsafe target's `href` collapses to `"#"`, whose pathname parses
as `/`, which would otherwise make it exact-active on every root route.

### Trailing slashes

Normalized away on both sides, so `/users/` and `/users` are the same target.
Root remains `/`.

## Focus

The router **delegates focus entirely to the application**. It never moves,
resets, or restores focus on navigation or history traversal. Applications
needing route-change focus management — an accessibility requirement for many —
should implement it in an `afterEach` hook.

## Suspense boundaries

`Suspense()` from `sibujs/plugins` renders deferred content behind an optional
fallback. Its lifecycle contract has two halves.

### Ownership

> A Suspense boundary owns every node it creates or installs. It disposes its
> fallback and its content when they are replaced or when the boundary is torn
> down — exactly once each.

Native detachment is **not** cleanup. A `removeChild`'d subtree keeps its
effects, listeners and registered disposers alive, firing against DOM nobody can
see. Every removal on this path disposes first, then detaches.

```text
fallback mounted  →  content resolves  →  fallback disposed, content committed
content committed →  boundary disposed →  content disposed
```

### Async completion grants no commit permission

> Async resolutions that arrive after the boundary loses ownership are discarded
> **and lifecycle-disposed**.

A boundary loses ownership when it is torn down, when a newer generation
supersedes it, or when its anchor is detached. The check happens immediately
before the synchronous commit, with nothing running in between.

The distinction that matters: a promise usually resolves with an **already
constructed** `Element`, whose effects and listeners were created before the
boundary discovered it had lost ownership. Dropping the reference would leak
them, so the stale result is disposed instead:

```text
boundary active, promise pending
        ↓
boundary disposed
        ↓
component finishes building its Element (+ effects, listeners, disposers)
        ↓
promise resolves with that Element
        ↓
Suspense: not my generation → dispose(element), no insertion
```

There is no DOM resurrection, no fallback resurrection, and no double cleanup.

### Fallback creation is generation-owned

The fallback factory is arbitrary user code and may synchronously tear the
boundary down. A parent read *before* it runs is therefore not evidence that the
boundary still exists after it returns.

> If the boundary is torn down or superseded while a fallback factory runs, the
> node it returns is lifecycle-disposed rather than committed.

Ownership is revalidated — and the parent re-read — after the factory returns
and before the node is adopted. A non-function `fallback` value is accepted
unchanged and is disposed on teardown or replacement like any other owned node.

### Single-shot

`props.nodes()` is invoked exactly once, so only one async generation is
reachable per boundary. A generation token is still carried, because teardown
must be able to invalidate the in-flight one; a generation *race* between two
concurrent runs is not reachable through the public API.

### Rejection

A rejected promise removes the fallback and commits a `div.suspense-error`
carrying the error message (`textContent`, never `innerHTML`). The boundary
stays lifecycle-safe: the fallback is disposed, no resolved node leaks, and a
rejection arriving after teardown produces no unhandled rejection and inserts
nothing.

## DOM-less runtimes and the memory router

The router is constructible and navigable with no DOM at all — bare Node, an SSR
request, a test process. Browser-only side effects are **skipped**, never
attempted and never fatal; the route itself always commits.

| Capability | Without a DOM |
|---|---|
| Route matching, guards, redirects, `push`/`replace` | works |
| `currentRoute`, navigation results | works |
| `history.pushState` / `replaceState` | **skipped** — probed via `globalThis.history` |
| `popstate` / `hashchange` listeners | **not registered** — nothing to register on |
| `scrollBehavior` | **not invoked at all** — the hook is browser code |
| `go()` / `back()` / `forward()` | browser-only — no effect |
| `Route()` / `KeepAliveRoute()` outlets | need a DOM; they build real nodes |

`createMemoryRouter(routes, initialPath)` builds a hash-mode router for
testing/SSR. Two things about it are worth stating plainly:

- It **does not mutate browser history**, by construction.
- It takes **no options object**, so `scrollBehavior` cannot be configured on it
  directly. The configuration that reaches the scroll path in a DOM-less runtime
  is an explicit `createRouter(routes, { scrollBehavior })` rendered server-side.

`scrollBehavior` is a **browser-only, post-navigation side effect**. In an
environment without the required scrolling primitives, SibuJS skips scroll
behaviour entirely — including the callback itself, which is never invoked.
Errors thrown by a scroll callback are reported but never retroactively fail an
already-committed navigation. See
[Post-commit side effects cannot revoke a navigation](#post-commit-side-effects-cannot-revoke-a-navigation)
for the ordering and the reasoning. That was MEM-001.

## Known limitations

- **SSR and hydration router behaviour is not covered** by the hardening
  passes. `routerSSR.ts` has its own suite, but server-match and
  hydration-mismatch behaviour is unaudited.
- **Singleton.** A module-level `_routerRef` holds the active router; multiple
  concurrent router instances are not supported.
- Router internals remain a single 2 400-line module. The internal class
  boundaries are clean; the file boundary has not been split.
