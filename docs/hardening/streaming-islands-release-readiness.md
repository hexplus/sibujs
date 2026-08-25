# Streaming / Suspense / Islands / Route-Mismatch Readiness

Baseline, gates, and classifications for the phase covering streaming SSR, SSR
Suspense, progressive island activation, and initial server/client route
mismatch.

## Baseline (before this phase)

| | |
|---|---|
| SSR/streaming/island/hydration test files | 16 |
| Tests in those files | 333 |
| Full suite | 4 216 passing (1 GC-gated skip) |
| Browser tests | 114 (router 60 + hydration 54) |
| Node v24.19.0 · Vitest 3.2.7 · Playwright 1.61.1 | Chromium 1234 · Firefox 1532 · WebKit 2311 |
| Build / `tsc` / `biome` | clean |

Implementation surface audited (actual names): `renderToStream`,
`renderToReadableStream`, `collectStream`, `ssrSuspense`,
`renderToSuspenseStream`, `suspenseSwapScript`, `resetSSRState`,
`hydrateIslands`, `hydrateProgressively`, `mountIslands`, `registerIsland`,
`lazyIsland`, `unregisterIsland`, `hydrateRouter`, `resolveServerRoute`.

## Metrics: before → after

| Metric | Before | After |
|---|---|---|
| SSR-family jsdom tests | 333 | 398 |
| Full suite | 4 216 | 4 281 passing (1 skip) |
| Browser tests | 114 | 129 |
| `tsc` / `biome` / build | clean | clean |

65 net new jsdom tests. No public API changes.

## Gates

```
Streaming ordering:          PASS   (tree order; boundaries in array order)
Streaming escaping:          PASS   (security gate)
Streaming isolation:         PASS   (2 interleaved + 50 concurrent)
Streaming cancellation:      PASS   (generator + ReadableStream)
SSR Suspense:                PASS
Suspense streaming:          PASS
Suspense hydration:          PASS   (covered by the previous phase)
Progressive islands:         PASS
Island lifecycle cleanup:    PASS
Initial route mismatch:      PASS   (jsdom only)

Chromium:                    PASS   (129/129, existing suites)
Firefox:                     PASS
WebKit:                      PASS
```

**Security gate (§59): met.** No injection through any API documented as safe,
in either the shell or async chunks.

**Isolation gate (§60): met.** No cross-request contamination of output,
Suspense ids, or state.

**Lifecycle gate (§61): met.** Islands activate at most once; a torn-down island
cannot activate later (IS-001 fixed); observers and listeners are released.

**Browser gate (§62): partially met** — see classifications.

## Findings

| ID | Sev | Class | Summary |
|---|---|---|---|
| ST-001 | P3 | Confirmed bug | `renderToStream` omitted the `data-sibu-ssr` marker, so the two render paths produced different HTML |
| IS-001 | P2 | Confirmed bug | A lazy island resolving after `cleanup()` still activated, orphaning its disposer |
| RM-001 | P1 | Confirmed bug | Bootstrap hydrated the *server's* route, leaving DOM disagreeing with router and location |
| ST-002 | — | Design characteristic | `renderToSuspenseStream` awaits **all** boundaries before flushing any |
| ST-003 | — | Design characteristic | `renderToStream` has no async boundary handling at all |
| SS-001 | — | Design characteristic | Suspense rejection renders the fallback, with no error signal in markup |

## Subsystem classifications

| Subsystem | Classification |
|---|---|
| Streaming SSR | **PRODUCTION-CAPABLE WITH CAVEATS** |
| SSR Suspense | **PRODUCTION-READY** |
| Streaming + Suspense | **PRODUCTION-CAPABLE WITH CAVEATS** |
| Direct islands | **PRODUCTION-READY** |
| Progressive islands | **PRODUCTION-CAPABLE WITH CAVEATS** |
| SSR/client initial-route mismatch | **PRODUCTION-CAPABLE WITH CAVEATS** |

### Why each

**SSR Suspense → production-ready.** Meets every §69 criterion:
resolved/pending/rejected states are deterministic, nested and sibling
boundaries are isolated, out-of-order completion lands correctly, streaming
integration is tested, replacement-hydration integration was covered in the
previous phase, and a boundary resolving after its stream was abandoned emits
nothing. Ids are collision-free across 50 concurrent requests and allowlisted
against injection.

**Streaming SSR → capable with caveats**, upgraded from beta. Ordering,
escaping, isolation, cancellation, and terminal-state safety all pass, and no
P0/P1 streaming defect remains. Held below production-ready by ST-002: awaiting
all boundaries before flushing any means SibuJS "streaming" delivers an early
shell plus one batched flush, not incremental per-boundary delivery. That is a
capability ceiling users must know about before choosing it for a
latency-sensitive page. Also unmeasured: backpressure behaviour beyond what the
platform `ReadableStream` provides, and time-to-first-chunk under load.

**Direct islands → production-ready.** `hydrateIslands` isolation, independence,
state separation, and removal-before-activation were proven in the previous
phase and in real browsers.

**Progressive islands → capable with caveats.** All four strategies activate
exactly once, cancellation works, listeners do not leak across 200 cycles,
missing browser APIs fall back deterministically, and IS-001 is fixed. Held
below production-ready by the §62 browser gate: `IntersectionObserver`,
`requestIdleCallback`, and `matchMedia` behaviour was exercised against a
**controlled stub in jsdom**, not against native implementations in
Chromium/Firefox/WebKit. Real-browser evidence is required before this can be
called production-ready, and the plan is explicit about not substituting jsdom
for it. The `media` strategy in particular has no coverage in this phase.

**Initial route mismatch → capable with caveats.** There is now a documented
deterministic policy (Model A — the live URL wins) and bootstrap ends with DOM,
router, location, and history coherent across path, param, query, and hash
mismatches, including a stale-bootstrap-vs-navigation race. Held below
production-ready because §70 additionally requires surviving lazy routes,
redirects, guard rejection, and back/forward after recovery — none of which this
phase covered — and §49 requires real-browser verification, which was not done.

## Remaining gaps, in priority order

1. **Real-browser progressive island activation** — native
   `IntersectionObserver`, `requestIdleCallback`, `matchMedia` on
   Chromium/Firefox/WebKit. The single blocker for progressive islands.
2. **Route mismatch in real browsers**, plus the lazy-route, redirect,
   guard-rejection, and back/forward-after-recovery scenarios (§46–§49).
3. **`media` island strategy** — untested in this phase.
4. **Per-boundary progressive flushing** (ST-002) — a capability change, not a
   fix; would need a design decision before implementation.
5. **Streaming performance** — time-to-first-chunk, 100 async boundaries,
   backpressure under a slow consumer (§64).
6. **Nested island ownership** (§35) — not exercised.

## Architectural note (deliberately out of scope)

ST-002 and SS-001 both stem from `renderToSuspenseStream`'s batch-flush shape.
Per-boundary flushing would be a genuine improvement for latency-sensitive
pages, but it is a capability change to async server rendering — not a hardening
fix — and §77 explicitly rules that out of this phase. Recorded here rather than
attempted.
