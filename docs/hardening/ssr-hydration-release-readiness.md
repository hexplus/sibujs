# SSR / Hydration Release Readiness

Covers the SSR, hydration, islands, and server-routing audit. Baseline, findings,
and browser evidence are recorded here rather than split across thin documents.

## Baseline (before this pass)

| | |
|---|---|
| SSR/hydration/island/stream test files | 12 |
| Tests | 260 passing, 0 failing, 0 skipped |
| Browser hydration tests | **0** |
| Node | v24.19.0 · Vitest 3.2.7 (jsdom 26) · Windows 11 |
| Build / `tsc` / `biome` | clean |
| `src/platform/ssr.ts` | 968 lines |
| `src/plugins/routerSSR.ts` | 650 lines |
| `src/core/ssr-context.ts` | 179 lines |

Public API inventory (actual names): `renderToString`, `renderToDocument`,
`renderToStream`, `renderToReadableStream`, `collectStream`, `hydrate`,
`hydrateProgressively`, `island`, `hydrateIslands`, `ssrSuspense`,
`renderToSuspenseStream`, `suspenseSwapScript`, `serializeState`,
`deserializeState`, `escapeScriptJson`, `trustHTML`, `resetSSRState`;
`resolveServerRoute`, `renderRouteToString`, `renderRouteToDocument`,
`serializeRouteState`, `deserializeRouteState`, `hydrateRouter`,
`createSSRRouter`; `runInSSRContext`, `withSSR`, `isSSR`,
`getRequestScopedCache`.

## Metrics: before → after

| Metric | Before | After |
|---|---|---|
| SSR/hydration jsdom tests | 260 | 333 |
| SSR/hydration browser tests | 0 | **54** (18 × 3 engines) |
| Full suite | 4 143 | 4 216 passing (1 GC-gated skip) |
| Known P0 SSR issues | 0 | 0 |
| `tsc` / `biome` / build | clean | clean |

73 net new jsdom tests, 18 new browser tests run on three engines.

## Gate results

| Gate | Result |
|---|---|
| Cross-request isolation | **PASS** |
| SSR escaping | **PASS** |
| Serialized-state escaping | **PASS** |
| SSR without browser globals (module/context/routing) | **PASS** |
| SSR without browser globals (rendering) | **N/A — DOM required by design (S-001)** |
| Hydration identity preserved | **FAIL by design — replace strategy (H-003)** |
| Duplicate-effect prevention | **PASS** |
| Duplicate-DOM prevention | **PASS** |
| Mismatch recovery | **PASS** |
| SSR/client route parity | **PASS** |
| Island isolation | **PASS** |
| Hydration memory bounded | **PASS** |
| Chromium / Firefox / WebKit | **PASS** (54/54) |

The security gate (§67) is met: no confirmed injection through any API
documented as safe, and no cross-request isolation defect.

## Subsystem classifications

| Subsystem | Classification |
|---|---|
| SSR renderer | **PRODUCTION-CAPABLE WITH CAVEATS** |
| SSR security (escaping + serialization) | **PRODUCTION-READY** |
| SSR request isolation | **PRODUCTION-READY** (Node only) |
| SSR router (`routerSSR`) | **PRODUCTION-READY** |
| Hydration | **PRODUCTION-CAPABLE WITH CAVEATS** |
| Islands | **PRODUCTION-CAPABLE WITH CAVEATS** |
| Streaming SSR | **BETA QUALITY** |
| SSR → client router handoff | **PRODUCTION-READY** |

### Why each

**SSR security — production-ready.** Hostile input was pushed through text,
attributes, data attributes, nested content, serialized state, and a hostile
nonce. Nothing escaped its context; `</script>`, `<!--`, U+2028/9 are all
neutralised; values round-trip losslessly. `trustHTML()` is the one intentional
opt-out and is named accordingly.

**SSR request isolation — production-ready on Node.** AsyncLocalStorage-backed,
verified by deliberately interleaved renders and 100 concurrent renders released
in reverse order. Downgraded to caveated on runtimes without ALS, where the
store falls back to a module global and concurrent isolation does **not** hold.

**SSR router — production-ready.** Full parity with the production-ready client
router across 8 URL shapes including encoded and Unicode paths, plus a
1 000-route table. Works entirely without a DOM. Redirect loops bounded.

**SSR renderer — caveated.** Correct and safe, but it requires a DOM
implementation on the server (S-001). That is a real deployment constraint, not
a defect, and it is now documented rather than discovered.

**Hydration — caveated.** No correctness defects remain and all three engines
pass, but the replace strategy (H-003) means it does not satisfy the usual
industry expectation of hydration: no DOM adoption, no identity preservation,
and **pre-hydration user input, checkbox state, and focus are discarded**. That
is a legitimate design trade — mismatches structurally cannot corrupt the DOM —
but applications with forms above the fold need to handle it explicitly.

**Islands — caveated.** Isolation, independence, state separation, and
removal-before-activation all pass in jsdom and in browsers. Caveated because
only the direct `hydrateIslands()` path was audited; the strategy-driven
activation modes in `src/platform/islands.ts` (`idle`, `visible`, `interaction`,
`media`) were **not** exercised in this pass.

**Streaming SSR — beta.** `renderToStream`, `renderToReadableStream`, and
`renderToSuspenseStream` exist and their pre-existing suites pass, but this
audit added **no** coverage for chunk ordering, streamed-chunk escaping,
mid-stream rejection, or cancellation. Classified on absence of evidence, not
on evidence of defects.

## Framework-level recommendation

Scoped by application type, as the plan requires:

| Application type | Recommendation |
|---|---|
| **Client-only SibuJS** | **Production-ready.** Reactive core, disposal, and client router are all independently hardened. |
| **SSR + hydration** | **Production-capable with caveats.** Safe and correct; understand the replace strategy and the server DOM requirement before committing. |
| **Islands** | **Production-capable with caveats.** Core isolation proven; activation strategies unaudited. |
| **Streaming SSR** | **Beta.** Do not deploy on framework evidence alone. |

Do not read "the client router is production-ready" as "SibuJS SSR is
production-ready". They are separate claims with separate evidence.

## Remaining work, in priority order

1. **Streaming SSR audit** — chunk ordering contract, streamed-chunk escaping,
   mid-stream rejection, cancellation. The largest evidence gap.
2. **Island activation strategies** — `idle`, `visible`, `interaction`, `media`,
   including activation after container removal.
3. **Suspense SSR/hydration matrix** — the four server/client resolution
   combinations (§26) were not covered.
4. **Server/client initial-route mismatch policy** (§38) — server renders `/a`,
   browser boots at `/b`. Undefined and untested.
5. **Hydration fuzzing** (§56–57) — seeded tree generation and controlled
   mismatch injection.
6. **ErrorBoundary + hydration** (§45) and **context propagation across
   concurrent SSR requests** (§46).
7. Large-tree render/hydrate performance (§58).
