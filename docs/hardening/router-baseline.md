# Router Hardening Baseline

State of the SibuJS router **before** the router hardening pass. Recorded so
every later claim can be measured against a fixed point. No pre-existing failure
was fixed before it was recorded here.

## Environment

| | |
|---|---|
| Package | `sibujs@3.4.1` |
| Node | v24.19.0 |
| Vitest | 3.2.7 (jsdom 26) |
| OS | Windows 11 (win32-x64) |

## Router test suite

| Metric | Value |
|---|---|
| Router-related test files | 18 |
| Router-related tests | 263 |
| Passing | 263 |
| Failing | 0 |
| Skipped | 0 |

Files counted: `router.basic`, `router.coverage`, `router.guard`,
`router.init-match`, `router.nested`, `router.nested-to-top`, `router-coverage`,
`router-lazy`, `router-security`, `routerSSR`, `routerSSR.coverage`,
`routeLoader`, `routeLoader.coverage`, `routeMiddleware`, `routeActions`,
`guards`, `scrollRestoration`, `build-routeSplitting`.

**Browser tests: none.** `tests-browser/` contains `islands.spec.ts` and
`lazy.spec.ts` only — there is no Playwright coverage of routing at all.

## Source scale

| | |
|---|---|
| `src/plugins/router.ts` | 2 394 lines |
| `src/plugins/routerSSR.ts` | 650 lines |
| `dist/plugins.js` (bundled entry containing router) | 63 790 B |

The router is a single monolithic module. Internally it is already organised
into classes — `NavigationController`, `RouteMatcher`, `GuardManager`,
`ComponentLoader`, `SibuRouter` — so the structure exists; it is the file
boundary that does not.

## Behaviour as found

Recorded before any change, from reading the implementation and from the
characterization tests added in this pass.

### Navigation and cancellation

- A `NavigationController` wraps each navigation in an `AbortController`, and a
  new navigation aborts the previous one. **The mechanism existed; the commit
  path did not consult it** — see R-001.
- `SibuRouter.destroy()` calls `navigator.abort()`.

### Route matching

- Trie/exact-match map for static paths, plus a specificity-ordered pattern
  list for routes containing `:param` or `*`.
- Specificity per segment: static (2) > param (1) > wildcard (0), compared
  segment-by-segment, with a **stable** sort so equal-specificity routes retain
  registration order. `/users/new` therefore beats `/users/:id`.
- Compiled patterns are cached in a 50-entry LRU.

### Guards

Observed order: `beforeEach` (global) → `beforeEnter` (per matched route, outer
to inner) → redirect resolution → `beforeResolve` (global) → commit →
`afterEach`. Guards may return `true`, `false`, or a redirect path string.
`GuardManager.runGuard` supports a 5 s default timeout and rejects on abort.

### Redirects

- Bounded by `MAX_REDIRECT_DEPTH = 10`; exceeding it throws a navigation
  failure of type `aborted`.
- Absolute and protocol-relative redirect targets are refused (open-redirect
  protection, CWE-601).
- `javascript:`/`data:`/`vbscript:`/`blob:` targets are refused everywhere.
- **No diagnostic naming the offending chain** — see R-004.

### Same-route behaviour

- An identical target (path + params + query + hash) is rejected as
  `duplicated` and does not re-run the pipeline.
- A query-only or hash-only change *is* a real navigation and commits normally.

### History

- `push` → `history.pushState`; `replace` → `history.replaceState`.
- `popstate` handling navigates with history updates suppressed, so browser
  back/forward does not create new entries.

### Lazy routes

- `Route()` holds a monotonic `navSeq`; a lazy resolution only mounts if its
  token is still current. This mount-level latest-wins protection predates this
  pass and is correct.
- Route-level component loading is *not* awaited inside `performNavigation` —
  navigation commits first, and the outlet resolves the component afterwards.

### SSR

`routerSSR.ts` is a separate module with its own suite; not modified in this
pass.

## Known gaps at baseline

- No real-browser router testing.
- No navigation-ownership regression tests.
- No redirect-loop diagnostics.
- No stress or randomized model testing.
- Router internals not split by responsibility.
