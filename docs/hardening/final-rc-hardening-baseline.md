# Final RC hardening — baseline

State of `sibujs@4.0.0-rc.1` **before** any production code was touched in this
pass. Every number below was measured, not carried over from an earlier report.

Companion documents:
[`final-rc-findings.md`](final-rc-findings.md) (findings with reproducers and fixes),
[`../architecture/async-ownership.md`](../architecture/async-ownership.md) (the ownership rule this pass extends to KeepAlive).

---

## Scope of this pass

Narrow. Four areas carried over from the latest source audit:

1. `KeepAliveRoute()` still uses the pre-hardening `isUpdating`/`pendingUpdate`
   serialization plus route-*value* staleness checks, where `Route()` already
   uses a monotonic generation. **Highest priority.**
2. Data-layer user callbacks (`select`, `onSuccess`, `onError`, `onSettled`) and
   cache listener iteration run inside the operation's own `try`/`catch`.
3. A DOM-less memory router configured with `scrollBehavior` can reach
   browser-only primitives.
4. Documentation/API comments that overstate runtime support and
   hydration/streaming semantics.

Explicitly **not** in scope: broad framework hardening, new features, redesign of
the KeepAlive cache API, LRU strategy, public route API, component loader, route
matcher, mutation optimistic rollback, or any new public error-reporting API.

---

## Repository state

| | |
|---|---|
| Commit | `b9bd5be` — *Bugfix/framework issues (#50)* |
| Working tree | clean (no modified or untracked files) |
| Package version | `4.0.0-rc.1` |
| Declared engine | `node >=22.3.0` |

---

## Test counts

Measured with `npx vitest run`. The router and data figures are the subsets this
pass touches, selected by filename.

| Suite | Files | Passed | Skipped | Total |
|---|---:|---:|---:|---:|
| Full unit/integration | 363 | 4390 | 1 | **4391** |
| Router subset | 25 | 338 | 0 | **338** |
| Data-layer subset | 19 | 195 | 0 | **195** |
| Soak (`vitest.soak.config.ts`) | 2 | 15 | 1 | **16** |
| Browser (Playwright) | 5 specs | — | — | **50 cases × 3 projects = 150** |

Router subset = `tests/router*.test.ts`, `tests/route*.test.ts`,
`tests/fuzz-router-model.test.ts`, `tests/ssr-hardening-route-mismatch.test.ts`,
`tests/build-routeSplitting.test.ts`.

Data subset = `tests/query*.test.ts`, `tests/mutation*.test.ts`,
`tests/resource.test.ts`, `tests/createResource.test.ts`,
`tests/infinite*.test.ts`, `tests/offlineStore*.test.ts`,
`tests/retry*.test.ts`, `tests/fuzz-query-model.test.ts`.

Browser projects = Chromium, Firefox, WebKit.

---

## Static gates

| Gate | Command | Result |
|---|---|---|
| TypeScript — source | `tsc --noEmit` | **0 errors** |
| TypeScript — tests | `tsc -p tsconfig.test.json` | **0 errors** |
| Lint | `biome check src/ tests/` | **clean** — 565 files, no diagnostics |
| Build | `npm run build` | **succeeds** (tsup, esm + cjs + dts + iife cdn) |

---

## Certification status carried in

The last full certification pass (`rc-certification.md`, plus the router, SSR/hydration,
and streaming/islands release-readiness documents) left SibuJS at:

> **PRODUCTION-HARDENED CANDIDATE** — pending real-world RC evidence.

This pass does **not** raise that classification. Its purpose is to remove the
last static/runtime inconsistencies identified by source audit before the
real-world evidence phase begins.

---

## Pre-existing conditions worth recording

These are baseline facts, not findings — they are the state the fixes start from.

- `KeepAliveRoute()` ([`src/plugins/router.ts`](../../src/plugins/router.ts))
  already keys its cache on the **full location** (`path` + query + hash), but
  gates async commit permission on `route.path !== router.currentRoute.path` —
  pathname only. Cache identity and commit ownership are therefore inconsistent
  with each other.
- `Route()` in the same file already carries the hardened model: a monotonic
  `navSeq` claimed at entry and re-checked after every `await`.
- `query()`'s `CacheEntry` already carries a `generation` field with the correct
  ownership semantics for the *request*; the gap is in *observer notification*,
  not in request ownership.
- `Router.handleScrollBehavior()` calls bare `requestAnimationFrame` and
  `window.scrollTo` with no environment probe, while `navigateInternal`'s history
  write immediately above it *is* guarded (`globalThis.history`). The guard
  coverage is asymmetric.

---

## How the "after" numbers must be read

A fix in this pass is only accepted if:

- the full suite total **grows** by exactly the number of added regression tests,
- no previously passing test flips to failing,
- both TypeScript gates stay at **0**,
- lint and build stay clean,
- the strict unhandled-rejection gate stays clean (mandatory here, because the
  data-layer work deliberately runs user code that throws).
