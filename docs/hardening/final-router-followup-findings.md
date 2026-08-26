# Follow-up Findings — PR #52 ownership gaps

Second, narrowly-scoped pass. Companion to
[final-router-findings.md](./final-router-findings.md); baseline in
[final-router-hardening-baseline.md](./final-router-hardening-baseline.md).

Two correctness gaps were named for investigation; both reproduced. Chasing the
Outlet reproducers to root cause surfaced **two further P1 defects on the same
code path**, both reproduced with failing tests before any fix. The two optional
P3 items were also examined: one reproduced, one was a documentation error.

| ID | Title | Severity | Status |
|---|---|---|---|
| OUT-001 | Outlet component-factory reentrancy stale commit | **P1** | Fixed |
| OUT-002 | Outlet pending-load teardown ownership | **P1** | Fixed |
| OUT-003 | `Route()` has the identical two gaps | **P1** | Fixed — *not in the original brief* |
| OUT-004 | Component-loader validation probe leaks its node | **P1** | Fixed — *not in the original brief; root cause of OUT-002* |
| SUS-003 | Suspense fallback-factory reentrant teardown | **P1** | Fixed |
| LINK-003 | Non-internal links receive router-active classes | **P3** | Fixed (unsafe confirmed; external NOT CONFIRMED) |
| DOC-004 | Classifier comment misdescribes protocol-relative | **P3** | Fixed |

---

## OUT-001 — Outlet component-factory reentrancy stale commit

**Severity:** P1. **Status:** Fixed.

**Reproducer.** `tests/router-hardening-outlet-ownership.test.ts` — a child
component factory that synchronously calls `navigate()` before returning its
node, and a variant that synchronously calls `destroyRouter()`.

**Root cause.** `update()` checked `seq !== navSeq`, then ran `component()`
(arbitrary user code), then committed guarded only by `anchor.parentNode`. A
node that failed that guard was **dropped without disposal**.

Measured directly during the investigation: across two nested navigations,
**3 of 6** factory-created nodes were created and never disposed.

**Fix.** `commitTarget(seq)` — checks `outletTorn`, generation identity, and
re-reads `anchor.parentNode` — evaluated immediately before the synchronous
commit. A stale pass calls `release(node)` (dispose, then detach).

**Regression test.** Reproducers A, B, D and the ABA cycle.

**Remaining risk.** Low.

---

## OUT-002 — Outlet pending-load teardown ownership

**Severity:** P1. **Status:** Fixed.

**Reproducer.** Outlet mounted, child lazy load pending, outlet disposed, load
resolves. Before the fix the child component factory was invoked **3 times**
after teardown.

**Root cause.** `outletTorn` was declared *after* `update`, and `update` never
consulted it; `outletCleanup` did not advance `navSeq`.

**Fix.** `outletTorn` is declared before `update`, checked at pass entry and
inside `commitTarget`; the first ownership check moved *before* `component()` so
stale work never invokes user code at all; teardown now sets `outletTorn = true`
and `navSeq++` before releasing anything.

**Regression test.** Reproducer C.

**Remaining risk.** Low. The component loader still validates a freshly-loaded
module once (see OUT-004), so the factory can run once as part of cache-fill
even on a torn-down path. That probe node is disposed and never mounted, and the
outlet itself adds no call of its own. The test asserts exactly that (call count
`1`, down from `3`), and `router.md` documents it.

---

## OUT-003 — `Route()` has the identical two gaps

**Severity:** P1. **Status:** Fixed. **Not named in the brief.**

**Evidence.** `Route()`'s `update()` had exactly the same structure as
`Outlet()`'s: a single `seq !== navSeq` check, then `component()`, then a commit
guarded only by `anchor.parentNode`, with un-committed nodes dropped rather than
disposed. `routeTorn` was likewise declared after `update` and never consulted,
and `routeCleanup` did not advance `navSeq`.

The brief's preserved-areas list covers Suspense, RouterLink and navigation
target safety. `Route()`'s user-code reentrancy is in none of them, and the
Outlet reproducers could not pass while the identical defect sat one level up.

**Fix.** The identical pattern: `commitTarget(seq)`, `release(node)`, torn flag
consulted at pass entry, generation advanced on teardown.

**Regression test.** Covered transitively by every Outlet reproducer (each
mounts through `Route()`), plus the existing `Route()` suites.

---

## OUT-004 — Component-loader validation probe leaks its node

**Severity:** P1. **Status:** Fixed. **Not named in the brief. Root cause of OUT-002.**

**Evidence.** `ComponentLoader.doLoadComponent()` validates a synchronous
component by **invoking it** and checking the result is an `Element`, then
discards the node and returns the component for the caller to invoke again.
`awaitComponent()` does the same for async components. Neither disposed the
discarded node.

Traced live, this is what kept the Outlet reproducer failing after both Outlet
and Route were fixed: the probe node for a *parent layout* contains a live
`Outlet()` whose anchor sits in no tree any caller can reach, so no `dispose()`
ever finds it — and its update pass kept invoking child component factories long
after the real outlet was torn down.

It also demonstrates concretely that **`parentNode` is not a liveness test**: the
orphaned outlet's anchor still had a parent (its detached probe layout), so every
`anchor.parentNode` guard read as "still mounted".

**Fix.** `dispose(result)` / `dispose(testElement)` on the discarded probe node
in both paths.

**Test-suite impact — disclosed.** This changed observable behaviour in four
previously-certified tests in `tests/router-hardening-ownership.test.ts`. Those
tests record a disposal log and had been implicitly asserting the leak, because
probe disposals never fired. The extra entries were exactly one per route
definition, one-time and bounded — `102` vs `≤100` across 100 navigations, i.e.
99 replacements plus 3 probes.

Rather than weaken any assertion, the shared `tracked()` helper now records only
disposals of nodes that were actually **mounted** (`if (d.parentNode)` — disposal
always runs before detachment, so a genuinely mounted node still has a parent).
All four test bodies and all four expectations are unchanged.

This is the only place this pass touched a previously-certified test, and it is
called out here deliberately rather than absorbed silently.

**Documentation.** "Components are invoked twice on first load" is now stated in
`router.md` — it is user-visible for any component with side effects.

---

## SUS-003 — Suspense fallback-factory reentrant teardown

**Severity:** P1 — confirmed lifecycle leak *and* DOM resurrection.
**Status:** Fixed.

**Reproducer.** A fallback factory that synchronously disposes the boundary (and
a variant that disposes the boundary's parent), then returns a live reactive
node. Before the fix the fallback was **inserted into a torn-down boundary** and
**never disposed**.

**Root cause.** `showFallback()` read `const parent = anchor.parentNode` *before*
calling `props.fallback()`, then inserted using that stale parent. Because
teardown's `cleanupNodes()` had already run and set `fallbackNode = null`, the
later assignment resurrected an untracked node that nothing would ever dispose.

**Fix.** `showFallback(myGeneration)` runs the factory first, then calls
`commitTarget(myGeneration)` — re-reading the parent — and `release()`s the
returned node when ownership was lost. A cheap pre-check still avoids running
user code when there is no parent at all.

**Generation-without-teardown: N/A.** The boundary is single-shot —
`props.nodes()` is invoked once and `showFallback` is reached once — so a
generation change without full teardown is unreachable through the public API.
Marked N/A rather than inventing rerun functionality for it.

**Regression test.** Four tests, including a non-function-fallback case proving
existing semantics are preserved, and a control proving a well-behaved factory
still mounts.

---

## LINK-003 — Non-internal links receive router-active classes

**Severity:** P3. **Status:** Fixed. **Partially confirmed.**

- **Unsafe targets: CONFIRMED.** `javascript:`, `data:`, `vbscript:` and
  `//host` collapse to `href="#"`, whose pathname normalizes to `/` — so every
  such link was `active` **and** `exactActive` on the root route.
- **External targets: NOT CONFIRMED.** `https://example.com/users` normalizes to
  the pathname `https://example.com/users`, which matches no route. No reproducer
  was found. The guard covers the case anyway and a test pins it, but it is
  reported here as not-reproduced rather than claimed as a fixed defect.

**Fix.** `isActive` and `isExactActive` are gated on `kind === "internal"`.

**Documentation.** [router.md § Non-internal links are never active](../architecture/router.md#non-internal-links-are-never-active).

---

## DOC-004 — Classifier comment misdescribes protocol-relative

**Severity:** P3. **Status:** Fixed.

The `classifyNavigationTarget` doc comment listed protocol-relative `//host`
under `external`, while the implementation classifies it `unsafe` — and the
explanatory paragraph directly beneath the list said exactly that, contradicting
the bullet. Introduced by the previous pass. The bullet now reads `unsafe`.

The implementation and `docs/architecture/router.md` were already correct; only
the comment was wrong.

---

## Test counts - before / after

| Suite | Baseline | After | Delta |
|---|---|---|---|
| Full unit/integration | 4547 passed, 1 skipped (369 files) | **4570 passed, 1 skipped (370 files)** | **+23** |
| Router suite | 469 passed (30 files) | **492 passed (31 files)** | **+23** |
| Outlet suite | 6 passed (2 files) | **18 passed (3 files)** | **+12** |
| Suspense suite | 53 passed, 1 skipped (6 files) | **57 passed, 1 skipped (6 files)** | **+4** |
| Browser matrix | 186 runs (6 files) | **192 runs (6 files)** | **+6** |
| Soak | 19 passed, 1 skipped (2 files) | **21 passed, 1 skipped (2 files)** | **+2** |

| Typecheck | Baseline | After |
|---|---|---|
| Source TypeScript errors | 0 | **0** |
| Test TypeScript errors | 0 | **0** |

New/changed test files:

```text
tests/router-hardening-outlet-ownership.test.ts   12 tests (new)
tests/router-hardening-suspense.test.ts           +4 tests
tests/router-hardening-link-matching.test.ts      +7 tests
tests/soak/lifecycle.soak.ts                      +2 soak tests
tests-browser/router.spec.ts                      +2 tests x 3 engines
tests/router-hardening-ownership.test.ts          helper adjusted (see OUT-004)
examples/router-browser.html                      nested-outlet reentrancy fixture
```

## Certification

| Gate | Baseline | After |
|---|---|---|
| Build | PASS | PASS |
| TypeScript (src) | PASS | PASS |
| Lint | PASS | PASS |
| Full unit/integration suite | PASS - 4547 | PASS - **4570** |
| TypeScript (tests + entry files) | PASS - 0 errors | PASS - 0 errors |
| Query model fuzzing | PASS | PASS |
| Router model fuzzing | PASS | PASS |
| SSR security fuzzing | PASS | PASS |
| Browser matrix | PASS - 186 runs | PASS - **192 runs** |
| Lifecycle + SSR soak | PASS - 19 | PASS - **21** |
| Packed package + subpath exports | PASS - 112/112 | PASS - 112/112 |
| Bundler matrix | PASS - 12/12 | PASS - 12/12 |
| Node support matrix | NOT TESTED - 22.3.0 unavailable; 22 PASS, 24 PASS | NOT TESTED - 22.3.0 unavailable; 22 PASS, 24 PASS |
| **Result** | ALL REQUIRED GATES PASSED (12/0) | **ALL REQUIRED GATES PASSED (12/0)** |

### Node floor

Exact Node **22.3.0** is not installed on this machine, so the matrix reports
`no interpreter available` for it. Recorded as **NOT TESTED on this run** -
neither PASS nor FAIL. Node v22.14.0 and v24.19.0 passed every sub-gate. The
previously certified exact-floor evidence is not reinterpreted here.

## Final ownership report

### Outlet

```text
Post-load ownership check:          PASS
Post-component ownership check:     PASS
Teardown invalidates generation:    PASS
Late lazy load invokes component:   NO (by the outlet)
                                    - the loader's one-time cache-fill
                                      validation probe still runs; its node is
                                      disposed and never mounted
Stale created node disposed:        PASS
Reentrant navigation protected:     PASS
Reentrant teardown protected:       PASS
```

### Suspense fallback

```text
Fallback factory ownership recheck: PASS
Reentrant teardown:                 PASS
Stale fallback disposed:            PASS
Fallback resurrection prevented:    PASS
```

### RouterLink P3

```text
External active class:              PASS (guarded; original defect NOT CONFIRMED)
Unsafe active class:                PASS (defect confirmed and fixed)
Classifier documentation:           UPDATED
```

## Scope discipline

Untouched, as instructed: `classifyNavigationTarget()` semantics, `navigate()`
target policy, redirect target policy, RouterLink external native behaviour,
RouterLink unsafe neutralization, segment active matching, exactActive Model B,
the data layer.

Two defects outside the brief (OUT-003, OUT-004) were fixed because the named
OUT-002 reproducer could not pass without them; both were reproduced first and
are reported above rather than folded into the named findings. One
previously-certified test helper was adjusted, disclosed under OUT-004.
