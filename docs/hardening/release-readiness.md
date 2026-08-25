# Release Readiness

Scope: one hardening pass over SibuJS 3.4.1, covering P0 (baseline) through the
core of P2 (hardening). Written to be checked, not believed — every claim below
names the test that backs it, and every gap is stated rather than omitted.

## Executive summary

**Assessment: production-capable with caveats.**

The reactive core and keyed reconciliation are genuinely strong. Both were
attacked with pathological workloads designed to break them, and neither
produced a single defect: 1 200 seeded random list mutations verified against an
external reference model, 2 000 conditional-branch flips, diamond graphs,
reentrant writes, throwing batches, and 1 000 subscribe/dispose cycles all
behaved correctly.

The weakness was **lifecycle, not rendering.** Three separate P1 defects were
found and fixed, all instances of one root cause: a DOM subtree removed through
a path that bypassed SibuJS disposal. In each case the framework rendered
correctly and cleaned up incorrectly — orphaned subtrees stayed subscribed and
kept updating off-screen forever.

That class of bug is now substantially harder to reintroduce: ownership is
formally specified, a shared safe-replacement helper exists, and leak detection
is assertable in tests without relying on garbage collection.

It is **not** "production-hardened", because significant parts of the plan were
not executed — the router, SSR, and hydration subsystems received no dedicated
hardening, and no real-browser test was run. Those are stated below.

## What was verified

| Area | Evidence |
|---|---|
| DOM disposal invariant | `tests/hardening-disposal.test.ts` (9) |
| Async completion after disposal | `tests/hardening-async-race.test.ts` (6) |
| Keyed reconciliation correctness | `tests/hardening-keyed-reconciliation.test.ts` (31) |
| Reactive runtime under stress | `tests/hardening-reactivity.test.ts` (20) |
| Leak-free mount/destroy cycles | `tests/hardening-memory.test.ts` (8, 1 GC-gated) |
| Leak detector is not vacuous | `tests/__vacuity_check.test.ts` (2) |
| Documented runtime limits | `tests/__depth_probe.test.ts` (2) |

## Metrics: before → after

| Metric | Baseline | After |
|---|---|---|
| Test files | 328 | 335 |
| Tests | 3 998 | 4 077 (4 076 passing, 1 GC-gated skip) |
| Failing | 0 (after build) | 0 |
| `tsc --noEmit` | clean | clean |
| `biome check` | clean | clean |
| P1 lifecycle defects known | 3 (undiscovered) | 0 |
| Core entry bundle | 5 211 B | 5 211 B |
| SSR entry bundle | 1 897 B | 1 897 B |
| CDN IIFE (minified) | 74 021 B | 74 021 B |

78 net new tests. No bundle-size change — the fixes reuse an existing disposal
path rather than adding machinery.

**Public API:** nothing was changed or removed. One symbol was *added*:
`replaceChildrenSafely()`. Because `index.ts` re-exports
`src/core/rendering/dispose.ts` wholesale, this is publicly exported. That is
deliberate and appropriate — application code that calls
`container.replaceChildren()` on SibuJS-managed content hits exactly the bug
this pass fixed, and the helper belongs beside the already-public `dispose()`
and `checkLeaks()`. It is additive, so it is not a breaking change.

**Performance:** verified, not assumed. See "Benchmark baseline is stale" below.
Comparing modified against unmodified code in the same session on the same
machine, every `each()` list benchmark landed within the ±2% noise floor
established by untouched control benchmarks (element creation), and several
measured slightly faster. The teardown path the `each()` fix touches is not
represented in the benchmark suite; its added cost is O(n) `removeChild` calls
on an operation that is already O(n) in disposing n rows.

## Architecture changes

1. **`replaceChildrenSafely()`** added to `src/core/rendering/dispose.ts`. The
   only new API surface in this pass. Introduced because five call sites across
   three modules genuinely needed it, not pre-emptively.
2. **`each()` range disposal.** The anchor now owns and tears down its whole
   logical range, matching what `KeepAlive()` already did.
3. **Async disposal guards** in `ErrorBoundary`, closing the
   commit-after-teardown hole.
4. **Ownership model documented** in
   [`docs/architecture/dom-ownership.md`](../architecture/dom-ownership.md),
   including the previously-unstated rule that *the source owns portal content*.

## Release gates

| Gate | Status |
|---|---|
| All unit tests passing | **Met** — 4 076/4 076 |
| TypeScript clean | **Met** |
| Lint clean | **Met** |
| Build succeeds | **Met** |
| Zero known P1 lifecycle bugs | **Met** — all three found were fixed |
| No growing runtime counters after mount/unmount cycles | **Met** — `checkLeaks()` returns to baseline |
| Zero known P1 memory leaks | **Met**, within tested subsystems |
| Architecture documentation complete | **Partial** — 2 of 10 planned documents |
| All browser tests passing | **Not met** — not run |
| All SSR tests passing | **Not verified** — existing suite passes; no hardening pass |
| All hydration tests passing | **Not verified** — same |
| Zero known P1 router race conditions | **Not verified** — not investigated |
| Stress suite | **Not built** as a separate tier |
| Published benchmark methodology | **Not done** |
| Bundle-size / tree-shaking validation | **Not done** |
| Stability tier classification | **Not done** |

## Not covered by this pass

Stated plainly, because a hardening report that hides its gaps is worse than no
report:

- **Router** (`src/plugins/router.ts`, 2 394 lines). Not refactored, and no
  race-condition, navigation-torture, or listener-growth testing. Its removal
  call sites were not audited in depth. This is the largest remaining risk.
- **SSR and hydration.** The existing suites pass, but no dedicated escaping
  matrix, no hydration-mismatch suite, no interaction-after-hydration testing.
- **Real browsers.** Everything here ran in jsdom. jsdom is not a browser;
  `MutationObserver` timing, focus, forms, and history behaviour are not
  verified against Chromium, Firefox, or WebKit.
- **Benchmarks** and **bundle-size/tree-shaking validation** across bundlers.
- **API consistency audit** and **stability tiers**.
- **MutationObserver lifecycle audit** (mount/unmount vs. reparent semantics).

## Known limitations

- Derived chains are stack-bounded at roughly 2 000–3 000 links (H-005).
  Documented and pinned, deliberately not redesigned.
- `ErrorBoundary` observes only the promise *returned by* children, not
  fire-and-forget async rejections. Pre-existing and documented.
- Duplicate keys in `each()` collapse to a single node. Development builds warn;
  production behaviour is silent collapse.
- Application code that detaches a SibuJS-managed node using native DOM APIs
  must call `dispose()` itself. The framework does not globally observe
  arbitrary removals.

## Recommendation

**RELEASE WITH DOCUMENTED LIMITATIONS.**

The core runtime — signals, derivations, effects, bindings, disposal, and keyed
lists — is well-tested and, on this evidence, reliable. Three real lifecycle
defects were removed and pinned with regression tests. Nothing found in this
pass argues against shipping the core.

Blockers for a **"production-hardened" / 4.0** claim, in priority order:

1. Router hardening — audit, race-condition suite, navigation torture tests.
2. A real-browser run across Chromium, Firefox, and WebKit.
3. SSR escaping matrix and a hydration-mismatch suite.
4. Benchmark methodology and bundle-size validation, both published and
   reproducible.
5. The remaining eight architecture documents and the stability-tier split.

Until those land, "production-ready" should be scoped to the core runtime rather
than claimed for the whole feature surface.
