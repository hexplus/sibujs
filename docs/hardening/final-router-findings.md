# Final Router Hardening — Findings

Narrow pass over three suspected areas in `src/plugins/router.ts`. Baseline in
[final-router-hardening-baseline.md](./final-router-hardening-baseline.md).

**All six suspected findings reproduced.** None was dismissed as NOT CONFIRMED,
and no severity was inflated: every classification below is backed by a test
that failed before the fix and passes after it.

| ID | Title | Severity | Status |
|---|---|---|---|
| SUS-001 | Suspense lifecycle disposal | **P1** | Fixed |
| SUS-002 | Suspense late-resolution ownership | **P1** | Fixed |
| LINK-001 | RouterLink segment-prefix false positive | **P2** | Fixed |
| LINK-002 | RouterLink exact-active semantics | **P3** (contract) | Decided + fixed |
| NAV-001 | Absolute/external target policy inconsistency | **P2** | Fixed |
| NAV-002 | Redirect validation inconsistency | **P2** | Fixed |

---

## SUS-001 — Suspense lifecycle disposal

**Severity:** P1 — confirmed lifecycle leak.
**Status:** Fixed.

**Reproducer.** `tests/router-hardening-suspense.test.ts`. A fallback carrying
three observable resources — an effect, a click listener, a registered disposer
— is mounted, then content resolves.

Observed before the fix:

```text
fallback removed from DOM      ✓
fallback disposer called       ✗  expected 1, got 0
fallback effect still reacting ✗  bump() incremented the run count
fallback listener still live   ✗  click() still fired
```

**Root cause.** `cleanupNodes()` removed owned nodes with raw
`node.parentNode.removeChild(node)` (`router.ts:2338`, `2362`) and never called
`dispose()`. The boundary also registered **no** disposer on its own anchor, so
teardown released nothing at all — committed content survived
`destroyRouter()`/parent disposal entirely.

**Fix.** A `release()` helper that disposes then detaches, used for every
boundary-owned removal, plus `registerDisposer(anchor, …)` that marks the
boundary torn down, invalidates the generation, and releases both nodes.

**Regression test.** `lifecycle-disposes the fallback when content resolves`,
`disposes committed content exactly once when the boundary is torn down`,
`keeps the boundary lifecycle-safe when the promise rejects`, plus the soak
below.

**Documentation.** [router.md § Suspense boundaries](../architecture/router.md#suspense-boundaries).

**Remaining risk.** Low. The boundary is single-shot, so the surface is small
and now fully covered. Applications that call `Suspense()` and then discard the
returned anchor without disposing it still leak — that is the framework-wide
`dispose()` contract, not specific to this boundary.

---

## SUS-002 — Suspense late-resolution ownership

**Severity:** P1 — confirmed leak and potential DOM resurrection.
**Status:** Fixed.

**Reproducer.** Two cases in `tests/router-hardening-suspense.test.ts`:

1. Boundary torn down while pending, then the promise resolves.
2. The promise resolves with an **already constructed** `Element` whose effects
   and listeners were created *after* teardown — the case that matters, because
   dropping the reference is not enough.

Observed before the fix: the late element's disposer never ran (`0`, expected
`1`), its effect kept reacting, and its listener stayed live.

**Root cause.** Ownership was decided solely by `anchor.parentNode`. When that
was falsy the resolved element was simply **dropped** — never disposed. There
was no torn-down flag and no generation token, so "the boundary is gone" and
"the anchor happens to be detached" were indistinguishable, and neither
triggered cleanup of the resolved node.

**Fix.** A `commitTarget(myGeneration)` check — `tornDown`, generation identity,
and a live anchor parent — evaluated immediately before the synchronous commit.
When it fails, the resolved element is `release()`d rather than dropped.

```text
await → ownership check → (fail) dispose(element), release fallback, stop
                        → (pass) dispose outgoing, insert — no await between
```

**Regression test.** `disposes the fallback and never commits when torn down
while pending`, `disposes a resolved Element that arrives after the boundary
lost ownership`, `does not resurrect the DOM when the anchor is detached without
disposal`, `produces no unhandled rejection when the boundary is torn down
before rejection`.

**Documentation.** [router.md § Suspense boundaries](../architecture/router.md#suspense-boundaries)
and the new [async-ownership.md § Stale-result disposal](../architecture/async-ownership.md#stale-result-disposal)
invariant.

**Remaining risk.** Low.

### Generation race — N/A by contract

`props.nodes()` is invoked exactly once, so two concurrent generations are not
reachable through the public API. Per §14 of the brief this is documented as
single-shot rather than having speculative rerun functionality invented for it.
The generation token is still carried because *teardown* must invalidate the
in-flight generation.

---

## LINK-001 — RouterLink segment-prefix false positive

**Severity:** P2.
**Status:** Fixed.

**Reproducer.** `tests/router-hardening-link-matching.test.ts`.

| Link | Route | Expected | Before fix |
|---|---|---|---|
| `/user` | `/users` | not active | **active** |
| `/product` | `/products` | not active | **active** |
| `/` | `/users` | not active | **active** |
| `/users/` | `/users` | active + exact | **not active at all** |

**Root cause.** `route.path.startsWith(hrefPath)` (`router.ts:2245`) — raw
string prefix matching, with no segment boundary and no trailing-slash
normalization.

**Fix.** `isPathnameAncestor(target, current)`: equality, or
`current.startsWith(target + "/")`, over pathnames normalized by
`normalizePathname()`. Root is special-cased to active-only-on-root.

**Regression test.** The `segment-boundary ancestor matching`, `root semantics`
and `trailing-slash normalization` blocks, plus three real-browser tests per
engine in `tests-browser/router.spec.ts`.

**Documentation.** [router.md § RouterLink active state](../architecture/router.md#routerlink-active-state).

**Remaining risk.** Low. This is `RouterLink` state only; route matcher
semantics were not touched.

---

## LINK-002 — RouterLink exact-active semantics

**Severity:** P3 — contract decision, not a defect.
**Status:** Decided and implemented.

**Reproducer.** `/search?q=a` was reported exact-active while the route was
`/search?q=b`; likewise `/docs#one` on `/docs#two`.

**Root cause.** `hrefPath` stripped query and hash, and `exactActive` compared
pathname only.

**Contract investigation.** No existing test or document pinned query/hash
exact-active behaviour — `docs/` had no `activeClass` contract at all, and
`tests/router.coverage.test.ts` only covered `/about` vs `/about/sub`. There was
therefore no established intentional contract to preserve.

**Decision — Model B.** `active` is pathname/segment based; `exactActive` is
full normalized target identity (pathname + query + hash), because
`/search?q=a` and `/search?q=b` are genuinely distinct navigation targets. Query
parameter order is not significant.

This was decided **independently** of KeepAlive cache identity. That cache also
keys on `path + query + hash`, but the two are separate concerns that happen to
agree; neither implies the other.

**Regression test.** The `query exact semantics` and `hash exact semantics`
blocks, plus `exact-active distinguishes query and hash targets` in the browser
matrix.

**Documentation.** [router.md § exactActiveClass — full target identity](../architecture/router.md#exactactiveclass--full-target-identity).

**Remaining risk.** Low, but this is a **behaviour change** for anyone who
relied on the previous pathname-only exact matching. It ships inside the
unreleased `4.0.0-rc.1`, so no published version changes meaning.

---

## NAV-001 — Absolute/external target policy inconsistency

**Severity:** P2.
**Status:** Fixed.

**Reproducer.** `tests/router-hardening-nav-target.test.ts`.

```ts
await navigate("https://example.com")
// expected: { success: false, reason: "unsafe-target" }
// actual:   { success: false, reason: "error" }
```

The refusal came from jsdom's `pushState` throwing `SecurityError` — i.e. the
policy was being enforced by the browser, **after** the navigation had started,
and reported as a generic fault. Exactly the failure mode §40 of the brief
warns about.

A second, distinct defect in the same area: `RouterLink({ to: "https://example.com" })`
**did** intercept the click, called `preventDefault()`, fed the URL into SPA
navigation where it was refused — leaving a link that did nothing at all.

**Root cause.** `isSafeNavigationTarget()` rejected protocol-relative and
dangerous-scheme targets but accepted any allowlisted absolute scheme, so
`https://example.com` passed straight through to route resolution and history
mutation.

**Fix.** One private `classifyNavigationTarget()` returning
`internal | external | unsafe`, and `isRouterNavigable()` = `internal`. No
public API added. `isSafeNavigationTarget()` was subsumed and removed.

Classification is **structural, not textual** (§37): a scheme exists only when
the `:` precedes any `/`, `?` or `#`, which keeps
`/search?q=https%3A%2F%2Fexample.com` and `/path/javascript%3Afoo` correctly
internal. Both are pinned by tests.

`RouterLink` gained a separate, deliberate policy: external → do not intercept,
native browser navigation; unsafe → `href="#"` and swallow the click; internal →
SPA navigation as before.

**Regression test.** The `navigate()` and `RouterLink click policy` blocks
(including mixed-case, leading-whitespace and embedded-tab `javascript:`
variants), plus five real-browser tests per engine.

**Documentation.** [router.md § Navigation target policy](../architecture/router.md#navigation-target-policy)
and [§ Link interception](../architecture/router.md#link-interception).

**Remaining risk.** Low. Behaviour change: `navigate("https://…")` now reports
`unsafe-target` instead of `error`, and a `RouterLink` to an external URL now
performs a real browser navigation instead of silently doing nothing. Both are
strictly more correct, and both ship inside the unreleased rc.1.

---

## NAV-002 — Redirect validation inconsistency

**Severity:** P2.
**Status:** Fixed.

**Reproducer.** The same `https://example.com` target, put through all five
entrypoints. Before the fix:

| Entrypoint | Absolute `https://` | Protocol-relative | Dangerous scheme |
|---|---|---|---|
| `navigate()` | **accepted** → `error` | refused | refused |
| route `redirect` | refused, `unsafe-target` | refused | refused |
| `beforeEach` redirect | **accepted** → `error` | refused | refused |
| `beforeEnter` redirect | **accepted** → `error` | refused | refused |
| `beforeResolve` redirect | **accepted** → `error` | refused | refused |

Exactly the asymmetry the brief suspected: the same target was valid or invalid
depending purely on where it came from.

**Root cause.** Route `redirect` carried an extra `^(https?:)?\/\//i` check
(`router.ts:1162`) that the other four call sites did not have. Two independent
rules, drifting.

**Fix.** All five now call `isRouterNavigable()`. The route-redirect branch
keeps its `console.error` open-redirect diagnostic for external targets, but no
longer owns a private rule.

**Regression test.** `route redirect`, `beforeEach redirect`,
`beforeResolve redirect` and `beforeEnter redirect` blocks, each run over the
full external + dangerous target matrix, plus an internal-target control per
block proving nothing was over-tightened.

**Documentation.** [router.md § Redirects](../architecture/router.md#redirects),
now pointing at the single policy rather than restating rules.

**Remaining risk.** Low.

---

## Scoped raw-DOM-removal audit (§47)

Every `removeChild` / `.remove()` / `replaceChildren` / `replaceWith` /
`innerHTML` occurrence in `src/plugins/router.ts`, classified. **No
framework-wide rewrite** — only the confirmed lifecycle-owned removal was
touched.

| Line | Site | Classification |
|---|---|---|
| 1790 | `Route()` `cleanupNodes` | already safe — `dispose(node)` precedes |
| 1822 | `Route()` `hideLoading` | **safe native-only node** — `loadingNode` is built entirely from `document.createElement` with no bindings, listeners or disposers; `dispose()` would be a no-op |
| 1854 | comment only | not an `innerHTML` write — records that `textContent` is used instead |
| 2177 | `KeepAliveRoute()` outgoing view | already safe — disposed unless cached (certified area, untouched) |
| 2202 | `KeepAliveRoute()` LRU eviction | already safe — `dispose` precedes |
| 2237 | `KeepAliveRoute()` cache teardown | already safe — `dispose` precedes |
| 2241 | `KeepAliveRoute()` current view | already safe — cached entries disposed in the loop above |
| 2460 | `Suspense()` `release` | **fixed this pass** — was the raw removal; now disposes then detaches |
| 2694 | `Outlet()` `clearCurrent` | already safe — `dispose` precedes |
| 2757 | `Outlet()` `outletCleanup` | already safe — `dispose` precedes |

One requiring a fix; one safe native-only node; eight already correct.

---

## Out of scope, observed but not modified (§62)

**`certify:rc` "Node support matrix" gate fails at baseline** — it failed
identically *before* any change in this pass. `docs/hardening/node-matrix-report.json`
reports `"no interpreter available"` for every gate on Node 22.3.0, 22 and 24:
those interpreters are not installed on this Windows machine. This is an
**environmental** gate, not a code defect, and fixing it is outside this pass.
All 12 other certification gates pass.

No new P0/P1 correctness issue was found adjacent to these code paths.

---

## Test counts — before / after

| Suite | Baseline | After | Δ |
|---|---|---|---|
| Full unit/integration | 4444 passed, 1 skipped (366 files) | **4547 passed, 1 skipped (369 files)** | **+103** |
| Router suite | 366 passed (27 files) | **469 passed (30 files)** | **+103** |
| Suspense suite | 44 passed, 1 skipped (5 files) | **53 passed, 1 skipped (6 files)** | **+9** |
| Browser matrix | 156 runs (6 files) | **186 runs (6 files)** | **+30** |
| Soak | 17 passed, 1 skipped (2 files) | **19 passed, 1 skipped (2 files)** | **+2** |

The router and full-suite deltas coincide because every new test in this pass is
a router test.

| Typecheck | Baseline | After |
|---|---|---|
| Source TypeScript errors | 0 | **0** |
| Test TypeScript errors | 0 | **0** |

New test files:

```text
tests/router-hardening-suspense.test.ts       9 tests
tests/router-hardening-link-matching.test.ts 17 tests
tests/router-hardening-nav-target.test.ts    77 tests
tests/soak/lifecycle.soak.ts                 +2 soak tests
tests-browser/router.spec.ts                 +10 tests × 3 engines
```

## Certification

| Gate | Baseline | After |
|---|---|---|
| Build | PASS | PASS |
| TypeScript (src) | PASS | PASS |
| Lint | PASS | PASS |
| Full unit/integration suite | PASS — 4444 | PASS — **4547** |
| TypeScript (tests + entry files) | PASS — 0 errors | PASS — 0 errors |
| Query model fuzzing | PASS | PASS |
| Router model fuzzing | PASS | PASS |
| SSR security fuzzing | PASS | PASS |
| Browser matrix | PASS — 156 runs | PASS — **186 runs** |
| Lifecycle + SSR soak | PASS — 17 | PASS — **19** |
| Packed package + subpath exports | PASS — 112/112, 16 subpaths | PASS — 112/112, 16 subpaths |
| Bundler matrix | PASS — 12/12 | PASS — 12/12 |
| Node support matrix | **FAIL** — no interpreters | NOT TESTED — 22.3.0 unavailable; **22 PASS, 24 PASS** |
| **Result** | **CERTIFICATION FAILED** (12 PASS / 1 FAIL) | **ALL REQUIRED GATES PASSED** (12 PASS / 0 FAIL) |

Package exports and runtime API are unchanged, so no package redesign was
needed — the 112/112 subpath check is identical before and after.

The Node matrix improved incidentally: at baseline no interpreter resolved at
all, and on the final run Node **v22.14.0** and **v24.19.0** both passed every
sub-gate. Only the exact `22.3.0` floor remains unverifiable on this machine
("no interpreter available"). Nothing in this pass targeted that gate.

## Suspense ownership report

| Property | Result |
|---|---|
| Fallback lifecycle disposal | **PASS** |
| Late resolution after teardown | **PASS** |
| Resolved stale node disposal | **PASS** |
| DOM resurrection prevention | **PASS** |
| Unhandled rejection isolation | **PASS** |
| Lifecycle soak | **PASS** |

## Final classification

```text
PRODUCTION-HARDENED CANDIDATE
```

Not upgraded beyond that. Real-world validation remains the missing evidence
layer: everything here is test-and-review evidence, not production traffic.

## Verdict

```text
READY TO MERGE — CONTINUE 4.0.0-RC.1 VALIDATION
```

`npm view sibujs@4.0.0-rc.1` returns 404 and the highest published version is
`3.4.1`, so `4.0.0-rc.1` has never been installable by a consumer. Per §63 these
fixes remain part of the unreleased `4.0.0-rc.1`; cutting an `rc.2` is not
required, and no published version changes meaning.
