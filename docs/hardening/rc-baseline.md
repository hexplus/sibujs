# Release-candidate certification — baseline

Recorded **before** any production-code change in the RC certification pass.
Everything here is measured, not estimated. Nothing was repaired before being
recorded.

## Environment

| Item | Value |
|---|---|
| Commit SHA | `35a103a18eab76f801fbfc085c43cb5f96ab84c6` |
| Commit subject | `fix(query): attach observers by cache-entry identity, not key` |
| Working tree | clean (`git status --porcelain` empty) |
| Package version | `sibujs@3.4.1` |
| Node | v24.19.0 |
| npm | 11.17.0 |
| TypeScript | 5.9.3 |
| Playwright | 1.61.1 |
| OS | Windows 11 (win32 10.0.26200, x64) |
| CPU | 12th Gen Intel Core i7-12650H, 16 logical cores |
| RAM | 31.6 GB |

Declared support surface (from `package.json`):

| Field | Value |
|---|---|
| `engines.node` | `>=18.0.0` |
| `browserslist` | Chrome ≥ 80, Firefox ≥ 78, Safari ≥ 14, Edge ≥ 80 |
| `type` | `module` |
| `sideEffects` | `false` |
| `main` / `module` / `types` | `dist/index.cjs` / `dist/index.js` / `dist/index.d.ts` |
| runtime `dependencies` | **none** |
| public subpaths | 16 (`.`, `./data`, `./browser`, `./patterns`, `./motion`, `./ui`, `./widgets`, `./ssr`, `./devtools`, `./performance`, `./ecosystem`, `./plugins`, `./build`, `./testing`, `./extras`, `./cdn`) |

Note: there is **no `sibujs/router` subpath**. The router ships from
`sibujs/plugins` (`src/plugins/router.ts`). All certification work uses the
real subpath list above, not the illustrative names in the certification brief.

## Suite status

| Gate | Result |
|---|---|
| `vitest run` (jsdom unit/integration) | **PASS** — 355 files, 4 340 passed, 1 skipped (GC-gated) |
| Suite wall time | 49.8 s |
| `tsc --noEmit` | **PASS** — clean |
| `biome check src/ tests/` | **PASS** — clean, 554 files |
| `npm run build` (tsup, esm+cjs+dts+iife) | **PASS** — no errors, no warnings |
| `npm pack` | **PASS** |

### Test counts by family (file counts, jsdom suite)

| Family | Files |
|---|---|
| Total | 355 |
| Reactivity (signal/effect/derived/track/batch/computed) | 24 |
| Router | 16 |
| SSR / hydration / islands / streaming | 19 |
| Data layer (query/mutation/infinite/cache) | 11 |
| Security (escape/sanitize/xss/trust) | 11 |

### Browser suite (Playwright, `tests-browser/`)

| Spec | Test declarations |
|---|---|
| `router.spec.ts` | 20 |
| `hydration.spec.ts` | 18 |
| `ssr-suspense.spec.ts` | 7 |
| `islands.spec.ts` | 4 |
| `lazy.spec.ts` | 1 |
| **Total declarations** | **50** |
| **Runs** (× chromium/firefox/webkit) | **150** |

Browser suite had **not been run** at baseline capture time; it is a
certification gate below, not a baseline claim.

## Build outputs

Tarball: `sibujs-3.4.1.tgz`, **747 578 B** (730 KB), **113 entries**.
Non-`dist/` entries: `package.json`, `README.md`, `LICENSE` — nothing else.

`dist/` total: 3 059 929 B across 110 files (ESM + CJS + both declaration
flavours + shared chunks + CDN IIFE).

Entry-point ESM shim sizes (these are re-export shims over shared chunks, not
standalone bundles — real consumer cost is measured in the bundler matrix):

| Entry | Bytes |
|---|---|
| `index.js` | 5 261 |
| `data.js` | 935 |
| `ssr.js` | 1 897 |
| `browser.js` | 1 125 |
| `patterns.js` | 923 |
| `motion.js` | 715 |
| `ui.js` | 12 264 |
| `widgets.js` | 543 |
| `plugins.js` | 66 954 |
| `extras.js` | 10 005 |
| `devtools.js` | 4 805 |
| `performance.js` | 1 395 |
| `ecosystem.js` | 679 |
| `testing.js` | 66 766 |
| `build.js` | 77 163 |
| `cdn.global.js` (IIFE, minified) | 75 053 |

No `.map` files are emitted or published — source maps are **not** published.

## Subsystem classifications carried in from prior passes

These are the starting points this pass must confirm, raise, or lower.

| Subsystem | Prior classification | Source |
|---|---|---|
| Reactive core | Production-ready (lifecycle pass) | `release-readiness.md` |
| DOM rendering / disposal | Production-ready | `release-readiness.md` |
| Keyed reconciliation | Production-ready | `release-readiness.md` |
| Client router | **PRODUCTION-READY** | `router-release-readiness.md` |
| SSR renderer / hydration | Hardened, pass complete | `ssr-hydration-release-readiness.md` |
| Streaming / islands | Hardened, pass complete | `streaming-islands-release-readiness.md` |
| Data layer (query/mutation/infinite) | Hardened, pass complete | `async-data-findings.md` |
| Packaging / bundler integration | **NOT TESTED** | — |
| Tree-shaking | **NOT TESTED** — explicitly open in `release-readiness.md` | — |
| Browser matrix (full) | Router only (60/60); rest not certified | — |

Explicitly open gates inherited from `release-readiness.md`:

- Bundle-size / tree-shaking validation — **not done**
- Published benchmark methodology — **not done**
- Stress/soak suite as a separate tier — **not built**
- Stability tier classification — **not done**

## Pre-existing failures

**None.** No test, typecheck, lint, or build failure existed at baseline. No
failure was repaired before this document was written.
