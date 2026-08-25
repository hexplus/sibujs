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

## Known limitations

- **SSR and hydration router behaviour is not covered** by the hardening
  passes. `routerSSR.ts` has its own suite, but server-match and
  hydration-mismatch behaviour is unaudited.
- **Singleton.** A module-level `_routerRef` holds the active router; multiple
  concurrent router instances are not supported.
- Router internals remain a single 2 400-line module. The internal class
  boundaries are clean; the file boundary has not been split.
