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

Security rules applied at every redirect and navigation target:

- `javascript:`, `data:`, `vbscript:`, `blob:` URIs are refused.
- Absolute and protocol-relative targets (`https://…`, `//…`) are refused as
  open-redirect vectors (CWE-601).

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
| `unsafe-target` | blocked scheme, or open-redirect refusal | dev diagnostic |
| `duplicate` | identical to the current route | no |
| `error` | unexpected fault | yes |

`reason` is additive: `type` values are unchanged, so existing code branching on
`type` is unaffected.

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

Note that engines differ in what that native behaviour *is*: Chromium fires
`auxclick` for a middle click and opens a new tab for modifier clicks, while
WebKit performs a real same-tab navigation. Both are correct; neither involves
the router.

## Focus

The router **delegates focus entirely to the application**. It never moves,
resets, or restores focus on navigation or history traversal. Applications
needing route-change focus management — an accessibility requirement for many —
should implement it in an `afterEach` hook.

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
