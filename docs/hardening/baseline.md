# Hardening Baseline

State of SibuJS **before** the production-readiness hardening pass. Recorded so
that every subsequent claim in this effort can be measured against a fixed
point. No pre-existing failure was fixed before it was recorded here.

## Environment

| | |
|---|---|
| Package | `sibujs@3.4.1` |
| Node | v24.19.0 |
| npm | 11.17.0 |
| Vitest | 3.2.7 |
| Test environment | jsdom 26 |
| OS | Windows 11 (win32-x64) |
| Browsers | Playwright specs exist for Chromium/Firefox/WebKit; **not executed** in this pass |

## Test suite

| Metric | Value |
|---|---|
| Test files | 328 |
| Tests | 3 998 |
| Passing | 3 967 |
| Failing | 31 |
| Skipped | 0 |
| Duration | ~52 s |

**All 31 failures were in a single file, `tests/consumption.test.ts`,** and were
environmental rather than behavioural: the file asserts against build artefacts
in `dist/`, which did not exist because `npm run build` had not been run. After
building, that file passes 35/35 with no source change.

**Corrected baseline: 3 998 / 3 998 passing.**

## Static checks

| Check | Result |
|---|---|
| `tsc --noEmit` | clean, no diagnostics |
| `biome check src/ tests/` | clean, 527 files |
| `npm run build` | succeeds (ESM + CJS + IIFE + d.ts) |

## Bundle sizes

Measured from `dist/` after a clean build. SibuJS is modular, so the core entry
is small and subsystems are separate subpath entries; the figures below are the
entry chunks, not the full transitive graph.

| Artifact | Size |
|---|---|
| `dist/index.js` (core entry) | 5 211 B |
| `dist/ssr.js` (SSR entry) | 1 897 B |
| `dist/cdn.global.js` (IIFE, minified, self-contained) | 74 021 B |

## Not executed in this pass

Recorded as gaps rather than results — these were **not** run, and no claim in
this effort rests on them:

- Real-browser Playwright specs (Chromium / Firefox / WebKit)
- Benchmark suite (`npm run bench`)
- Bundle-size / tree-shaking validation across Vite, Rollup, esbuild, Webpack

## Source scale

| | |
|---|---|
| TypeScript source files | 199 |
| Total source lines | ~37 200 |
| Largest module | `src/plugins/router.ts` (2 394 lines) |

The router's size is noted as a maintainability risk; it is a P3 item and was
not refactored in this pass.
