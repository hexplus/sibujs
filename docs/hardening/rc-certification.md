# SibuJS 3.4.1 — release-candidate certification

Companion documents: [`rc-baseline.md`](rc-baseline.md) (pre-change state),
[`rc-findings.md`](rc-findings.md) (every finding with reproducer and fix),
[`rc-api-contract.md`](rc-api-contract.md) (pinned public semantics),
[`../support-matrix.md`](../support-matrix.md) (evidence-based environment support).

---

## Executive summary

SibuJS was taken outside its own repository for the first time and put through
package, bundler, browser, randomized, soak, and security certification.

**Three framework bugs were found and fixed**, each via the required workflow —
reproducer first, then root cause, then the smallest fix, then a targeted
regression test:

- **RC-001 (P1)** — constructing a router in any DOM-less runtime returned
  normally and then killed the process from a microtask with an *uncatchable*
  `ReferenceError`. `createMemoryRouter`, documented for "testing/SSR", was
  broken in exactly the environment it advertises. Invisible to 324 existing
  router tests because they all run under jsdom, where `window` always exists.
- **RC-002 (P2)** — the query cache's GC timer was not `unref`'d, pinning the
  Node event loop for the full 300-second retention window. Any CLI, SSG build,
  or serverless invocation that touched `query()` hung for five minutes after
  finishing.
- **RC-003 (P2)** — a plain `() => Promise<Element>` route component (valid per
  the exported `AsyncComponent` type) was misclassified by a syntactic heuristic,
  its promise dropped unawaited, producing a misleading error *and* an unhandled
  rejection.

All eleven required gates now pass. The two most consequential findings were
found by machinery that did not exist before this pass — RC-002 surfaced as a
timeout in the bundler matrix, RC-001 the first time a router was constructed
outside jsdom.

The pass also found **seven test-suite/harness defects**, four of them in
harnesses written *during* this certification. Those are reported in full rather
than quietly fixed, because a test that passes vacuously is as dangerous as no
test: one router fuzz ran 1 500 operations while exercising **zero** component
loads, and one SSR isolation test checked for cross-request data bleed where
**0 of 1 000** requests ever resolved any data.

**Recommendation: `PRODUCTION-HARDENED CANDIDATE — BEGIN REAL-WORLD VALIDATION`**,
with the qualification in [Release recommendation](#release-recommendation): the
declared Node 18/20/22 support is inherited rather than verified, and closing
that is the one cheap gap that should precede a stable release.

---

## Environment matrix

Full detail in [`../support-matrix.md`](../support-matrix.md).

| Environment | Status |
|---|---|
| Chromium / Firefox / WebKit (latest) | **Verified** — 150/150 |
| Node 24.19.0 | **Verified** |
| Node 18 / 20 / 22 | **Not tested** — declared in `engines`, not exercised |
| Bun / Deno | **Not tested** — not installed on the host |
| Cloudflare Workers / DOM-less edge | **Supported only with a DOM implementation** |
| Vite 7 / Rollup 4 / esbuild 0.25 / Webpack 5 | **Verified** |
| ESM | **Verified** |
| CJS | **Verified**, with a size/duplication caveat (PKG-002) |
| TypeScript 5.9.3 `strict` over `src` | **Verified** |
| Consumer-side `node16`/`bundler` resolution | **Not tested** |

Certification host: Windows 11 (10.0.26200 x64), Node v24.19.0, npm 11.17.0,
i7-12650H (16 threads), 32 GB RAM.

---

## Package certification

Built with `npm pack` — the identical tarball that would be published.

| Check | Result |
|---|---|
| Tarball size | 747 973 B, 113 entries |
| Non-`dist/` contents | `package.json`, `README.md`, `LICENSE` — nothing else |
| Development artifacts (tests, configs, coverage, fixtures) | **none** |
| `.env` / keys / tokens / credentials / `.npmrc` / `.git` | **none** |
| Source maps | **not published**; no dist file references a missing `sourceMappingURL` |
| License / repository / homepage / bugs metadata | present and correct (MIT) |
| Runtime `dependencies` | **zero** |
| `peerDependencies` | none |
| Subpath exports resolving after packing | **112/112 checks across 16 subpaths** |
| Import-time side effects | none beyond documented `Symbol.for` registries |

Every one of the 16 subpaths was verified to: have its declared `import`,
`require`, and `types` targets physically present in the tarball; import
successfully in bare Node; export a non-empty namespace; start no timers;
install no listeners; and create no string-keyed globals.

**README install smoke (§95).** The quickstart in `README.md` was followed
literally against the packed tarball in a fresh consumer project — `npm install
sibujs`, then the counter example copied verbatim. It renders, the `"counter"`
lone-string argument is applied as a class, the event binding fires, and
reactivity updates the heading:

```text
initial : Count: 0Increment
after x2: Count: 2Increment
class   : counter class applied
README SMOKE: PASS
```

The only thing the example needs beyond the package is a DOM, which the SSR
caveat already documents.

**Vulnerability scan:** 4 advisories (3 high, 1 low) — `brace-expansion`,
`nanoid`, `postcss`, `esbuild`. **All are transitive *dev* dependencies** of the
vitest/tsup toolchain. With zero runtime dependencies and a tarball containing
only `dist/`, none reach a consumer. Not upgraded, per the certification-pass
dependency freeze (§90).

**Open packaging findings:** PKG-001 (`./package.json` not exported, P3),
PKG-002 (CJS duplicates the runtime into all 15 entries — 2.18× ESM size, P2,
correctness verified unaffected), PKG-003 (`sibujs/plugins` aggregates i18n with
the router, P3, by design).

---

## Bundler certification

All against the packed tarball installed into a throwaway consumer project —
never a workspace link.

| Bundler | Builds | Runtime | Clean exit | Tree-shaking |
|---|---|---|---|---|
| Vite 7 | 3/3 | 3/3 | 3/3 | 2/3 clean |
| Rollup 4 | 3/3 | 3/3 | 3/3 | 2/3 clean |
| esbuild 0.25 | 3/3 | 3/3 | 3/3 | 2/3 clean |
| Webpack 5 | 3/3 | 3/3 | 3/3 | 2/3 clean |
| **Total** | **12/12** | **12/12** | **12/12** | **8/12** |

"Clean exit" is a first-class gate rather than part of "runtime": a probe can
produce a correct result and still pin the event loop. That distinction is what
isolated RC-002, which first appeared as a confusing failure on a row whose own
captured output said `OK`.

`sideEffects: false` is **safe**: no bundler eliminated required initialisation,
and every bundled probe produced correct results.

The 4 non-clean tree-shaking results are all the same known characteristic
(PKG-003): importing only `createRouter` from `sibujs/plugins` retains i18n.
Core, data, and SSR isolation are clean — a `signal`-only bundle contains no
router, no query, no SSR renderer, no islands, and no devtools.

---

## Browser certification

**150/150 runs green** — 50 specs × Chromium, Firefox, WebKit, on real
Playwright engines. jsdom is not counted toward this gate.

| Area | Specs |
|---|---|
| Router navigation, history, link interception, focus | 20 |
| Replacement hydration | 18 |
| SSR Suspense swap | 7 |
| Native progressive islands | 4 |
| Lazy island code-splitting over real HTTP | 1 |

Native island strategies (`load`, `idle`, `visible`, `interaction`, `media`) run
against real `IntersectionObserver`, `requestIdleCallback`, and `matchMedia` —
not stubs.

---

## SSR certification

| Gate | Result |
|---|---|
| Import `sibujs/ssr` in bare Node (no browser globals) | **PASS** |
| All 16 subpaths import in bare Node | **PASS** |
| Router construction in a DOM-less runtime | **PASS** (was RC-001) |
| 10 000 sequential renders, unique markers | **PASS** — no cross-request marker |
| 1 000 concurrent interleaved requests | **PASS** — 1 000 distinct cache maps |
| Per-request suspense id sequences | **PASS** — every request starts at `sibu-sus-0` |
| 10 000 `serializeState` calls | **PASS** — no payload bleed |
| 2 000 stream start/consume/complete cycles | **PASS** |
| 500 streams abandoned mid-consumption | **PASS** — later requests unaffected |

**DOM dependency (§53/§54), stated unambiguously:** `renderToString` takes real
DOM nodes, so SSR requires a server DOM implementation. It is **not** a package
dependency — SibuJS ships zero runtime dependencies and the consumer supplies
their own (`jsdom`, `linkedom`, `happy-dom`). On DOM-less edge runtimes SSR is
**NOT SUPPORTED** without a polyfill; importing the module still succeeds.

Request isolation depends on `AsyncLocalStorage`. Where it is unavailable the
implementation falls back to a module-global store and **concurrent isolation is
not guaranteed**.

---

## Data-layer fuzz results

`tests/fuzz-query-model.test.ts` — deterministic mulberry32, seeds
`1, 42, 123456, 999999, 7, 31337`, **400 operations per seed = 2 400 operations**,
with a full invariant sweep after every single operation. No `Math.random()`,
so it runs in ordinary CI and any failure replays byte-identically with the
seed, step, and complete operation log.

Operations: create observer, dispose, change key, resolve, reject, invalidate,
`clearQueryCache`, `setQueryData`, refetch.

Invariants checked after each step:

| # | Invariant | Result |
|---|---|---|
| I1 | subscriber count never logically negative | PASS |
| I2 | `listeners` / `refetchers` / `subscribers` maintained as one unit | PASS |
| I3 | an entry never holds more subscribers than live observers exist | PASS |
| I4 | a disposed observer receives no further local commit | PASS |
| I5 | no live observer stuck fetching with nothing in flight | PASS |
| I6 | idle observers agree with their cache entry | PASS |

Terminal state per seed: everything drained, no observer fetching, and every
entry back to zero subscribers.

---

## Router fuzz results

`tests/fuzz-router-model.test.ts` — same seeds, **250 operations per seed =
1 500 operations**, against a **mounted `Route()` outlet** so async component
loading is genuinely exercised.

Operations: navigate, replace, back, forward, settle load, fail load, guard
allow / reject / redirect.

| # | Invariant | Result |
|---|---|---|
| I1 | the router's path is always coherent | PASS |
| I2 | a redirect source is never a destination | PASS |
| I3 | route context stays internally consistent | PASS |
| I4 | a rejecting guard never commits the guarded path | PASS |
| I5 | the outlet replaces rather than accumulates route content | PASS |
| — | terminal router/outlet consistency after full drain | PASS |

The file carries **per-seed and suite-level vacuity guards** that fail if async
loads, async commits, or guard rejections were never exercised. These are not
decoration: the first version of this fuzz ran all 1 500 operations while
performing **zero** component loads, because `navigate()` does not load
components — only the outlet does (rc-findings TEST-005).

---

## Soak results

`npm run test:soak` — 15 tests + 1 GC-gated, ~4 s, excluded from PR CI.

| Soak | Scale | Result |
|---|---|---|
| Signal writes | 100 000 | exact notification count; no residual subscribers |
| Reactive create/dispose cycles | 50 000 | binding count returns to baseline exactly |
| Dynamic dependency branch switches | 10 000 | exact edge count — no stale or dropped edges |
| Batched writes | 100 000 | collapse to exactly 1 notification |
| Keyed-list mount/update/dispose | 2 000 cycles × 3 reconciliation paths | bindings return to baseline |
| Query observer create/dispose | 10 000 | zero retained subscribers |
| `clearQueryCache` under live observers | 500 replacements | refcounts stay exact |
| Router navigations | 10 000 (with supersession) | router still correct and disposable |
| Router create/destroy | 500 | no listener accumulation |
| SSR renders | 10 000 sequential + 1 000 concurrent | no marker bleed |
| Streams | 2 000 complete + 500 abandoned | no retained request state |

---

## Memory results

Evidence is **deterministic framework counters**, not heap size. A counter that
returns to baseline proves bounded ownership; a heap that happens not to grow
proves nothing.

| Counter | After soak |
|---|---|
| Active DOM bindings (`checkLeaks()`) | returns to baseline exactly |
| Signal subscriber counts | return to baseline |
| Query cache entries / subscriber refcounts | zero retained |
| Router listeners and disposers | no accumulation across 500 lifecycles |
| Pending timers after teardown | none unexpected — RC-002 removed the one that was |

Heap comparison under `node --expose-gc` is layered on as corroboration with a
deliberately loose tolerance (`npm run test:soak:gc`, 10/10 including the
GC-gated test). It is not used as a precise assertion, because heap measurement
in a JS runtime is not precise.

**Unhandled rejection gate: PASS.** RC-003 was found by turning this into a real
gate; the router fuzz surfaced escaping rejections the moment it began
exercising real async component loads.

---

## Security results

`tests/fuzz-ssr-security.test.ts` — seeds `1, 42, 123456, 999999`, roughly
**2 800 generated hostile payloads per run**, assembled from a 40-fragment
alphabet covering `< > & " ' / \`` , `<script>`, `</script>`, `<!--`, `-->`,
`]]>`, `javascript:` / `vbscript:` / `data:` in mixed case and with embedded
whitespace and control characters, NUL and C0 controls, U+2028/U+2029, RTL
override, zero-width characters, BOM, astral-plane emoji, and combining marks.

| Surface | Cases | Result |
|---|---|---|
| SSR text content | 1 000 | PASS — no markup escape, text round-trips |
| Attribute values | 1 000 (>500 round-trips verified) | PASS — boundary never broken |
| Attribute names | 13 hostile forms | PASS — no `on*` ever emitted |
| URL attributes | 11 obfuscated scheme forms | PASS |
| Serialized state | 600 nested structures | PASS — cannot terminate its script context |
| `escapeScriptJson` | all terminator forms | PASS |
| Streaming output | 240 | PASS — byte-identical to string rendering |
| Large input | ~500 KB hostile payload | PASS — escapes, never truncates |

Assertions **parse** the output and inspect the resulting DOM rather than
pattern-matching the string. That change mattered: the regex formulation
produced three false failures because decoding an escaped payload manufactures
the very `onmouseover=` pattern it searches for (rc-findings TEST-006).

The raw-HTML boundary was checked and deliberately left alone: `trustHTML()`
returns a branded `TrustedHTML` and is intentionally unsafe; everything else
escapes; `renderToString` additionally strips `<script>`/`<style>`, validates
attribute names, drops `on*`, and routes URL attributes through `sanitizeUrl`.

---

## Performance results

**The benchmark regression gate is currently NOT USABLE, and this is reported as
a finding rather than as a pass.**

`bench-baseline.json` was recorded 2026-06-26, two months before this commit and
on different conditions. Running `npm run bench:check` on the **unmodified**
tree reports **21 regressions**; running it with the three RC fixes applied
reports **18**. The deltas are confined to DOM element-creation benchmarks
(+50 % to +360 %), a path none of the three fixes touch.

The differential is the meaningful measurement, and it is the one that matters
for this pass:

| Tree | Reported regressions |
|---|---|
| HEAD, unmodified | 21 |
| HEAD + RC-001/002/003 | 18 |

**The RC fixes introduce no performance regression** — they measure marginally
*better* than the unmodified tree, which is itself within noise. All reactivity
benchmarks (signal read/write, derived propagation, diamond graphs, batching)
and all keyed-list reconciliation benchmarks are within ±11 % on both trees.

What this does not tell us is whether the absolute DOM-creation slowdown against
the June baseline is real drift or an environment change (Node version, jsdom
version, machine). Resolving that requires re-recording the baseline on a
controlled host and is listed as a release recommendation.

Bundle sizes (unchanged by this pass except `plugins.js`, which grew 482 B from
the RC-001/RC-003 fixes):

| Artifact | Bytes |
|---|---|
| `index.js` | 5 261 |
| `data.js` | 935 |
| `ssr.js` | 1 897 |
| `plugins.js` | 67 436 (was 66 954) |
| `cdn.global.js` (minified IIFE) | 75 053 |
| Tarball | 747 973 |

---

## Findings

Full detail with reproducers in [`rc-findings.md`](rc-findings.md).

**Confirmed framework bugs (3, all fixed):** RC-001 (P1, router DOM-less crash),
RC-002 (P2, event loop pinned), RC-003 (P2, unhandled rejection).

**Packaging findings (3, open):** PKG-001 (P3), PKG-002 (P2), PKG-003 (P3).

**Test-suite / harness defects (7):** TEST-001…TEST-007. Four were in harnesses
written during this pass and were caught before their results were believed;
TEST-004 (`tests/` never type-checked — 130 pre-existing errors) and TEST-007
(`npm test` not hermetic — 31 tests fail without a prior build) are
pre-existing and remain open.

**Documentation findings:** the streaming-Suspense description, the
`context()`/`withContext()` semantics, the `retry` option shape, and the
`query()`-under-SSR behaviour are now pinned in
[`rc-api-contract.md`](rc-api-contract.md). Several vacuous tests found during
this pass were written against a *plausible* contract rather than the real one,
which is the concrete cost of that gap.

**Environment limitations:** Node 18/20/22, Bun, Deno, minimum browser versions,
and consumer-side `node16`/`bundler` TypeScript resolution are all **not
tested** and are marked as such everywhere.

**Security findings:** none in the framework. 4 dev-only transitive advisories.

**Performance regressions:** none attributable to this pass; benchmark baseline
is stale (see above).

---

## Known caveats

Documented architectural characteristics, not defects. Full list in
[`../support-matrix.md`](../support-matrix.md#known-caveats).

1. Replacement hydration rather than node adoption.
2. Global synchronous context semantics.
3. Batched — not per-boundary progressive — Suspense streaming.
4. SSR Suspense markup does not distinguish permanent failure from pending.
5. A server DOM implementation is required for SSR and is not bundled.
6. Plain `<a href>` is never intercepted.
7. `query()` does not fetch under SSR.
8. `router.go()/back()/forward()` remain client-only and throw without a DOM.
9. A raw NUL does not survive HTML serialization (HTML's rule, not SibuJS's).

---

## Subsystem classifications

Not averaged. Each stands on its own evidence.

| Subsystem | Classification |
|---|---|
| Reactive core | **PRODUCTION-HARDENED CANDIDATE** |
| DOM rendering | **PRODUCTION-HARDENED CANDIDATE** |
| Lifecycle / disposal | **PRODUCTION-HARDENED CANDIDATE** |
| Keyed reconciliation | **PRODUCTION-HARDENED CANDIDATE** |
| Client Suspense | **PRODUCTION-READY** |
| Client router | **PRODUCTION-HARDENED CANDIDATE** |
| Data layer | **PRODUCTION-HARDENED CANDIDATE** |
| SSR renderer | **PRODUCTION-READY** |
| SSR security | **PRODUCTION-HARDENED CANDIDATE** |
| SSR router | **PRODUCTION-READY** |
| Replacement hydration | **PRODUCTION-READY** |
| Direct islands | **PRODUCTION-READY** |
| Progressive islands | **PRODUCTION-READY** |
| Streaming SSR | **PRODUCTION-CAPABLE WITH CAVEATS** |
| Streaming + Suspense | **PRODUCTION-CAPABLE WITH CAVEATS** |
| Packaging | **PRODUCTION-READY** |
| Bundler integration | **PRODUCTION-READY** |

Reasoning for the non-uniform entries:

- **Hardened candidate** requires production-ready *plus* seeded fuzzing, soak,
  memory evidence, package/bundler evidence, security fuzzing, and failure
  recovery. Reactive core, DOM/lifecycle/keyed reconciliation, router, data
  layer, and SSR security each have all of that.
- **Production-ready** (not candidate) where the subsystem is well covered and
  has no known P0/P1, but did not receive dedicated randomized or soak coverage
  in this pass — client Suspense, SSR renderer, SSR router, hydration, islands.
  Islands and hydration do have full three-engine browser verification.
- **Production-capable with caveats** for streaming + Suspense: it is correct,
  safe under fuzzing, and leak-free, but its semantics are *batched* rather than
  progressive and the markup cannot distinguish failure from pending. Both are
  documented; neither is a bug. It should not be marketed as progressive
  streaming.
- **Packaging** is production-ready rather than a hardened candidate because
  PKG-002 (CJS runtime duplication) remains open. It is a size and
  developer-experience issue, not a correctness one — correctness was verified
  by cross-copy probes rather than assumed.

**Overall: SibuJS 3.4.1 is a production-hardened candidate for client
applications, SSR-with-a-server-DOM, routing, and data fetching; streaming
Suspense remains production-capable with documented caveats.**

---

## Release blockers

**Unresolved P0: none. Unresolved P1: none.**

Non-blocking, recommended before a *stable* release (not before an RC):

1. **Run the suite on Node 18, 20, and 22.** `engines` claims `>=18` on
   inherited evidence. This is a cheap CI matrix job and is the single largest
   unverified claim in the package. RC-002 is proof that Node-specific
   behaviour does not come free with a green jsdom suite.
2. **Re-record `bench-baseline.json`** on a controlled host so
   `npm run bench:check` becomes a usable gate instead of reporting 21 false
   regressions on an untouched tree.
3. **Burn down the 130 test type errors** (TEST-004). Some indicate tests
   exercising APIs in ways the type system forbids, which weakens what they
   prove.

---

## Certification gate results

`npm run certify:rc` — all gates, one run, exit 0.

```text
Full unit/integration suite:       PASS   (4 373 tests, 361 files, 1 skipped)
Chromium:                          PASS   (50/50)
Firefox:                           PASS   (50/50)
WebKit:                            PASS   (50/50)

Packed package install:            PASS
ESM consumer:                      PASS
CJS consumer:                      PASS   (with PKG-002 caveat)

Vite:                              PASS
Rollup:                            PASS
esbuild:                           PASS
Webpack:                           PASS

Tree shaking:                      PASS   (8/12 clean; 4 = known PKG-003)
Subpath exports:                   PASS   (112/112 checks, 16 subpaths)

SSR bare Node:                     PASS
SSR concurrent isolation:          PASS   (1 000 concurrent requests)
SSR security fuzz:                 PASS   (~2 800 payloads/run)

Progressive native islands:        PASS   (3 engines, real browser APIs)
Route mismatch browser matrix:     PASS   (3 engines)

Query model fuzzing:               PASS   (2 400 operations, 6 seeds)
Router model fuzzing:              PASS   (1 500 operations, 6 seeds)

Lifecycle soak:                    PASS
Memory/leak gate:                  PASS
Unhandled rejection gate:          PASS

Bundle regression:                 PASS   (recorded; no gate breach)
Benchmark regression:              NOT USABLE — stale baseline; differential
                                   shows no regression from the RC fixes

TypeScript (tests + entries):      FAIL   130 pre-existing errors [non-blocking]

Node 18 / 20 / 22:                 NOT TESTED
Bun / Deno / DOM-less edge:        NOT TESTED / NOT SUPPORTED
Minimum browser versions:          NOT TESTED
```

`NOT TESTED` is never reported as `PASS`. The runner counts unverified gates
separately and prints them explicitly.

---

## Final test counts

| Family | Baseline | After |
|---|---|---|
| Total test files | 355 | **361** |
| Total tests | 4 340 (+1 skipped) | **4 373** (+1 skipped) |
| Reactivity | 24 | 24 |
| Router | 16 | **19** |
| SSR / hydration / islands / streaming | 19 | **20** |
| Data layer | 11 | **13** |
| Security | 11 | **12** |
| Fuzz (seeded model tests) | 0 | **3** |
| Soak files | 0 | **2** (15 tests + 1 GC-gated) |
| Browser runs | not run | **150** |
| Package/bundler checks | 0 | **112 export checks + 12 bundler probes** |

Counts are supporting evidence, not the conclusion. The three framework bugs
were found by six new files, not by the other 355.

---

## Release recommendation

```text
PRODUCTION-HARDENED CANDIDATE — BEGIN REAL-WORLD VALIDATION
```

The evidence supports it: the published package works outside the repository;
all four supported bundlers consume it; tree-shaking is correct and its one
exception is documented; three real browser engines pass; native island
activation works against real browser APIs; SSR and streaming survive fuzzed
hostile input; shared-data and router concurrency survive randomized testing;
lifecycle and memory ownership remain bounded under soak; failure paths
terminate; no unhandled async work remains; and the public documentation has
been corrected to match the implementation.

This is explicitly **not** a claim of `PRODUCTION-HARDENED`. That status
requires sustained real-world production evidence, which no amount of automated
testing can substitute for. The three distinctions:

- **Production-ready** — normal and failure paths tested, lifecycle verified,
  docs match behaviour, no known P0/P1.
- **Production-hardened candidate** — the above plus fuzzing, soak, memory,
  package/bundler, security, and failure-recovery evidence. **SibuJS is here.**
- **Production-hardened in real-world usage** — the above plus sustained
  production operation. **SibuJS is not here, and cannot be until it runs.**

### Recommended next phase

1. **Freeze features.** Accept only fixes, docs, and release tooling.
2. **Close the Node version gap** — a CI matrix on 18/20/22. This is the one
   item that could still invalidate a support claim.
3. **Release the RC.**
4. **Deploy to reference applications** — at minimum one client-only app, one
   SSR app, and one data-heavy app.
5. **Monitor over real usage**: uncaught errors, browser exceptions, memory over
   long sessions, navigation correctness, query cache behaviour, SSR latency and
   request isolation under genuine concurrency.
6. **Then** promote to stable, and only after sustained clean operation
   describe SibuJS as production-hardened.

Two of the three bugs found here — a five-minute process hang and a
process-killing microtask throw — would have shown up as *deployment* failures,
not test failures. That is the argument for step 4: the remaining unknowns are
in the shape of real workloads, not in the shape of more tests.

### CI layering

Recommended, matching the tooling this pass added:

| Layer | Contents | Trigger |
|---|---|---|
| Fast PR CI | build → `tsc` → lint → unit suite | every PR |
| Browser CI | Playwright × 3 engines | every PR or merge queue |
| Package/bundler CI | `exports-audit` + bundler matrix | merge to main |
| Scheduled fuzz | fuzz suites with an expanded seed list | nightly |
| Scheduled soak | `test:soak` with raised iteration counts | nightly/weekly |
| RC certification | `npm run certify:rc` | release candidates |

The soak and fuzz suites are already separated so no developer waits on them per
commit. Scheduled runs should widen the seed list beyond the six committed seeds
and record any failing seed, since a failing seed is a complete, replayable
reproducer by construction.
