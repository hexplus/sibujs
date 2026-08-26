# Final Router Hardening — Baseline

Recorded **before** any production-code change in this pass, so every later number
is diffable against a known-good starting point.

## Repository state

| Item | Value |
| --- | --- |
| Commit | _not a git repository_ — `git rev-parse` fails in `c:\Projects\mine\sibujs`; the working tree is the only reference point |
| Package | `sibujs` |
| Version | `4.0.0-rc.1` |
| npm publication state | **`4.0.0-rc.1` is NOT published.** `npm view sibujs@4.0.0-rc.1` → 404. Highest published version is `3.4.1`. |

Because `4.0.0-rc.1` has never been installable by a consumer, fixes from this pass
remain part of the unreleased `4.0.0-rc.1` (see §63 of the brief). No `rc.2` is required.

## Gate results

| Gate | Command | Baseline |
| --- | --- | --- |
| Full unit/integration suite | `npx vitest run` | **4444 passed, 1 skipped (4445), 366 files** — green |
| Router suite | `npx vitest run tests/router* tests/route* tests/fuzz-router-model tests/build-routeSplitting tests/ssr-hardening-route-mismatch` | **366 passed, 27 files** — green |
| Suspense-bearing suite | `npx vitest run tests/hardening-async-race tests/hardening-disposal tests/hardening-memory tests/lazy tests/lazy.coverage` | **44 passed, 1 skipped (45), 5 files** — green |
| Browser matrix | `npx playwright test --list` | **156 tests, 6 files** (Chromium / Firefox / WebKit × 52) |
| Soak | `npm run test:soak` | **17 passed, 1 skipped (18), 2 files** — green |
| Source typecheck | `npx tsc --noEmit` | **0 errors** |
| Test typecheck | `npx tsc -p tsconfig.test.json` | **0 errors** |
| Lint | `npx biome check src/ tests/` | **clean** — 569 files checked, no diagnostics |
| Build | `npm run build` | **green** |
| `certify:rc` | `node scripts/certify/run.mjs` | **FAIL** — 12 gates pass, 1 fails: see below |

### Baseline `certify:rc` failure (pre-existing, environmental)

The baseline certification run failed on exactly one gate:

```text
FAIL   Node support matrix   22.3.0:INCOMPLETE 22:FAIL 24:FAIL
```

`docs/hardening/node-matrix-report.json` attributes every sub-gate to
`"no interpreter available"` — the Node interpreters the matrix wants are not
installed on this Windows machine. This is an **environmental** gate failure
recorded *before* any change in this pass, not a code defect, and remediating it
is out of scope (§62). All 12 other gates pass at baseline:

```text
Build · TypeScript (src) · Lint · Full unit/integration suite · TypeScript (tests)
Query model fuzzing · Router model fuzzing · SSR security fuzzing
Browser matrix (Chromium/Firefox/WebKit) 156 runs · Lifecycle + SSR soak
Packed package + subpath exports 112/112 · Bundler matrix 12/12
```

## Scope of this pass

Only the three areas named in the brief are in scope:

| ID | Area | Suspected severity |
| --- | --- | --- |
| P1 | Router-plugin `Suspense()` async ownership / disposal | P1 |
| P2 | `RouterLink` active-route segment matching | P2 |
| P2 | Absolute / cross-origin navigation target policy | P2 |
| P3 | `RouterLink` query/hash exact-active semantics (contract decision) | P3 |

### Explicitly preserved (already certified, not touched)

`KeepAliveRoute` generation ownership · KeepAlive cache identity · `scrollBehavior`
isolation · query observer isolation · data lifecycle callback isolation ·
SSR `AsyncLocalStorage` · hydration semantics · progressive islands · query cache
ownership · Node >=22.3 support · package exports.

## Suspect code, as it stands at baseline

All three suspects live in `src/plugins/router.ts`.

**Suspense (`src/plugins/router.ts:2326-2412`)** — module-local `currentNode` /
`fallbackNode` / `isLoading`, ownership decided solely by `anchor.parentNode`, and
removal performed with raw `node.parentNode.removeChild(node)` (line 2338, 2362). No
`registerDisposer(anchor, …)` is present.

**RouterLink active matching (`src/plugins/router.ts:2245-2246`)** —
`route.path.startsWith(hrefPath)` with `hrefPath = href.split("?")[0].split("#")[0]`.

**Navigation target policy (`src/plugins/router.ts:19-33`, `1034`, `1106`, `1142`,
`1162-1172`, `1185`)** — `isSafeNavigationTarget()` rejects protocol-relative and
dangerous-scheme targets but accepts `https://example.com`; route `redirect` adds a
second, stricter `^(https?:)?\/\//i` check that the other four entrypoints do not have.

---

# Follow-up baseline — PR #52 ownership gaps

Recorded **before** any production-code change in the follow-up pass. This is the
post-first-pass state, i.e. the state PR #52 currently proposes.

| Item | Value |
| --- | --- |
| Commit | _not a git repository_ — `git rev-parse` fails; the working tree is the only reference point |
| Version | `4.0.0-rc.1` (still unpublished — `npm view sibujs@4.0.0-rc.1` → 404) |

| Gate | Command | Baseline |
| --- | --- | --- |
| Full unit/integration suite | `npx vitest run` | **4547 passed, 1 skipped (4548), 369 files** — green |
| Router suite | router/route/fuzz/split/ssr-route files | **469 passed, 30 files** — green |
| Outlet suite | `tests/router.nested*.test.ts` | **6 passed, 2 files** — green |
| Suspense suite | `router-hardening-suspense` + async-race/disposal/memory/lazy | **53 passed, 1 skipped (54), 6 files** — green |
| Browser matrix | `npx playwright test --list` | **186 tests, 6 files** (Chromium/Firefox/WebKit) |
| Soak | `npm run test:soak` | **19 passed, 1 skipped (20), 2 files** — green |
| Source typecheck | `npx tsc --noEmit` | **0 errors** |
| Test typecheck | `npx tsc -p tsconfig.test.json` | **0 errors** |
| Lint | `npx biome check src/ tests/` | **clean** — 572 files |
| `certify:rc` | `node scripts/certify/run.mjs` | **ALL REQUIRED GATES PASSED** — 12 PASS / 0 FAIL / 1 NOT TESTED (Node 22.3.0 floor: no interpreter available on this machine) |

## Scope of the follow-up

Two correctness gaps, two optional P3 cleanups. Nothing else.

| ID | Area | Suspected severity |
| --- | --- | --- |
| OUT-001 | `Outlet()` commits after `component()` user code without re-checking ownership | P1 |
| OUT-002 | `Outlet()` pending load ignores `outletTorn`; teardown does not invalidate the generation | P1 |
| SUS-003 | `Suspense.showFallback()` captures the parent before running the fallback factory | P1/P2 |
| LINK-003 | non-internal `RouterLink`s can receive router-active classes | P3 |
| DOC-004 | classifier comment misdescribes protocol-relative targets | P3 |

### Explicitly preserved (approved in PR #52 review, not touched)

`classifyNavigationTarget()` · `navigate()` target policy · route-redirect policy ·
`beforeEach`/`beforeEnter`/`beforeResolve` consistency · RouterLink external native
navigation · RouterLink unsafe neutralization · segment-boundary active matching ·
exactActive Model B · all previously certified areas · the data layer.

## Suspect code at follow-up baseline

**`Outlet()` (`src/plugins/router.ts:2706-2748`)** — `seq !== navSeq` is checked at
2734, then `component()` runs arbitrary user code at 2736, and the commit at
2738 re-checks only `anchor.parentNode`. `outletTorn` is declared at 2756, after
`update` closes over nothing of the sort, and `update` never consults it.
`outletCleanup` (2757) does not advance `navSeq`. A node that fails the
`anchor.parentNode` test is dropped, never disposed.

**`Suspense.showFallback()` (`src/plugins/router.ts:2477-2492`)** — `parent` is
read at 2479, *before* `props.fallback()` executes at 2483; the insert at 2487
uses that stale parent, and `fallbackNode` is assigned after any teardown-driven
`cleanupNodes()` would already have run.

**`RouterLink` (`src/plugins/router.ts`, active-class effect)** — `kind` is
computed but not consulted when deriving `isActive`/`isExactActive`.
