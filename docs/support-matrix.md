# Supported environment matrix

Evidence-based. **Verified** means a suite was actually executed in that
environment during release-candidate certification. **Not tested** means exactly
that — it is never a synonym for "works".

Certification host: Windows 11 (win32 10.0.26200 x64), 12th-gen Intel Core
i7-12650H, 32 GB RAM. Node interpreters invoked directly from their install
roots, each with its own bundled npm.
Package under test: `sibujs@3.4.1`, installed from a real `npm pack` tarball in
throwaway consumer projects — never a workspace link.

## Browsers

| Environment | Status | Evidence |
|---|---|---|
| Chromium (Playwright 1.61.1) | **Verified** | 50/50 specs |
| Firefox (Playwright 1.61.1) | **Verified** | 50/50 specs |
| WebKit (Playwright 1.61.1) | **Verified** | 50/50 specs |

150/150 runs green. Coverage: router navigation and history, RouterLink
interception, replacement hydration, SSR Suspense swap, and native progressive
islands (`load`, `idle`, `visible`, `interaction`, `media`) against real
`IntersectionObserver`, `requestIdleCallback`, and `matchMedia`.

`browserslist` declares Chrome ≥ 80, Firefox ≥ 78, Safari ≥ 14, Edge ≥ 80.
**Those minimum versions were not tested** — only current engines were. Treat
the floor as a build-target declaration, not a verified claim.

## Node.js

| Environment | Status | Evidence |
|---|---|---|
| Node 22 (v22.14.0, npm 11.12.0) | **Verified** | 13/13 gates |
| Node 24 (v24.19.0, npm 11.17.0) | **Verified** | 13/13 gates |
| Node 18 / 20 | **Not supported** | below the declared floor — see below |

`package.json` declares `engines.node: ">=22.3.0"`, and **every version in that
range is executed by CI** (`.github/workflows/ci.yml`, `node-matrix` job) via
`node scripts/certify/node-matrix.mjs`. Per-version gates:

| Gate | Node 22 | Node 24 |
|---|---|---|
| `npm install` | PASS | PASS |
| `npm run build` | PASS | PASS |
| Source typecheck | PASS | PASS |
| Test typecheck | PASS (0 errors) | PASS (0 errors) |
| Unit suite | PASS (4 383 tests) | PASS (4 383 tests) |
| `npm pack` | PASS | PASS |
| ESM import — all 15 subpaths | PASS | PASS |
| CJS require — all 15 subpaths | PASS | PASS |
| DOM-less router (RC-001, NODE-001) | PASS | PASS |
| Query clean exit (RC-002) | PASS (141 ms) | PASS (132 ms) |
| SSR isolation, CJS (NODE-002) | PASS | PASS |
| SSR isolation, ESM (NODE-002) | PASS | PASS |
| Promise-returning route component (RC-003) | PASS | PASS |

### Why the floor is 22.3.0

It was `>=18.0.0` and CI ran Node 20 only. Executing the full range for the
first time found **NODE-002**: SSR request isolation depends on
`AsyncLocalStorage`, which the runtime loads through
`process.getBuiltinModule` — **added in Node 22.3**. The pre-22.3 fallback was
broken (it looked for `require` in global scope, where it does not exist in
either module format), so below 22.3 concurrent requests silently shared one
store: cross-request data bleed.

The CommonJS half is fixed and now isolates correctly on Node 18 through 24.
The ESM half cannot be fixed in place — there is no synchronous way to load a
builtin from ESM before `getBuiltinModule` existed, and a static
`import "node:async_hooks"` would break every browser bundle.

Node 18 (EOL April 2025) and Node 20 (EOL April 2026) are both end-of-life and
were the only versions failing any gate, so the floor was raised to the version
that actually provides the mechanism. **This is a breaking change** for anyone
on EOL Node.

On any runtime that reaches the fallback, `runInSSRContext` now emits a one-time
warning rather than degrading silently.

## Server runtimes

| Environment | Status | Notes |
|---|---|---|
| Node.js (bare, no DOM globals) | **Supported** | all 16 subpaths import cleanly; see the DOM caveat below |
| Bun | **Not tested** | not installed on the certification host |
| Deno | **Not tested** | not installed on the certification host |
| Cloudflare Workers / DOM-less edge | **SUPPORTED WITH A DOM IMPLEMENTATION** | see below |

### SSR requires a DOM implementation

`renderToString(element: HTMLElement | DocumentFragment | Node)` takes **real
DOM nodes** — SibuJS builds an element tree and serializes it, rather than
emitting strings directly. Rendering therefore requires a server DOM.

Consequences, stated plainly rather than left ambiguous (§54):

- **Node**: supported. Supply a DOM (`jsdom`, `linkedom`, `happy-dom`). Note
  that the DOM is **not** a runtime dependency of the package — `sibujs` ships
  with **zero** runtime dependencies, and the DOM used by this repo's own tests
  comes from `devDependencies`. A consumer must provide their own.
- **DOM-less edge runtimes** (Workers, Deno Deploy without a DOM shim): SSR is
  **not supported** without a DOM polyfill. Importing `sibujs/ssr` succeeds
  there; *rendering* is what needs the DOM.

Importing every subpath in bare Node — no `window`, no `document` — was verified
to work and to have no import-time side effects beyond the documented
`Symbol.for` registries. Post-RC-001, constructing a router in a DOM-less
runtime is also safe.

### AsyncLocalStorage and request isolation

Request-scoped SSR state is backed by `AsyncLocalStorage`, verified across 1 000
genuinely interleaved concurrent requests (1 000 distinct cache maps,
per-request suspense id sequences) and re-verified per Node version in both ESM
and CommonJS.

On runtimes **without** `AsyncLocalStorage` the implementation falls back to a
mutated module-global store, and **concurrent request isolation is not
guaranteed there**. A fully synchronous render is still correct — the fallback
saves and restores around the call — but two requests interleaving across an
`await` share one store.

That fallback is now **loud**: `runInSSRContext` emits a one-time warning when it
is reached on a Node runtime, so the degradation cannot pass unnoticed the way
NODE-002 did. Browsers and DOM-less edge runtimes reach it legitimately and are
not warned.

Anyone running SSR off-Node must confirm `AsyncLocalStorage` is available.

## Bundlers

| Environment | Status | Evidence |
|---|---|---|
| Vite 7 | **Verified** | 3/3 probes build, run, exit cleanly |
| Rollup 4 | **Verified** | 3/3 |
| esbuild 0.25 | **Verified** | 3/3 |
| Webpack 5 | **Verified** | 3/3 |

12/12 production builds, 12/12 runtime smoke tests, 12/12 clean process exits,
all against the packed tarball in a fresh consumer project. No bundler emitted
warnings that were suppressed.

Minified bundle sizes for a single-primitive import (`signal` from `sibujs`):

| Bundler | core-minimal | data-only | router-only |
|---|---|---|---|
| esbuild | 10 670 B | 16 562 B | 24 055 B |
| Vite | 10 457 B | 16 358 B | 23 927 B |
| Webpack | 10 582 B | 15 667 B | 25 229 B |
| Rollup | 21 948 B | 34 432 B | 47 737 B |

Rollup's figures are roughly double because the probe config does not minify
beyond tree-shaking; the others run their production minifiers.

## Module formats

| Format | Status | Notes |
|---|---|---|
| ESM | **Verified** | all 16 subpaths import, types resolve, one shared runtime chunk |
| CJS | **Verified — with a caveat** | all 15 `require()`-able subpaths work; see below |
| IIFE / CDN (`sibujs/cdn`) | **Verified (resolve + build)** | 75 053 B minified global build |

`sideEffects: false` is safe: every bundler kept the initialisation the runtime
needs, and every bundled probe produced correct results.

**CJS caveat (rc-findings PKG-002).** `tsup` code-splits ESM but not CJS, so all
15 CJS entries embed their own copy of the runtime — 1 592 789 B total against
729 477 B for ESM (2.18×). A consumer requiring two or more subpaths therefore
loads several copies and sees a `Multiple instances of the reactive runtime
detected` warning on stderr. **Correctness is unaffected**, and this was
verified rather than assumed: cross-copy probes confirmed shared reactivity,
shared batching, and a single shared query cache across three separate CJS
copies. Prefer ESM.

## Tree-shaking

| Import | Router | Query | SSR renderer | Islands | Devtools | Result |
|---|---|---|---|---|---|---|
| `signal` from `sibujs` | absent | absent | absent | absent | absent | **clean** |
| `query` from `sibujs/data` | absent | present | absent | absent | absent | **clean** |
| `createRouter` from `sibujs/plugins` | present | absent | absent | absent | absent | i18n retained |

8 of 12 bundler×probe combinations are fully clean. The 4 exceptions are all the
same known characteristic: `sibujs/plugins` aggregates i18n with the router in
one entry (rc-findings PKG-003), so a router-only bundle carries the i18n
registry. This is an entrypoint-granularity trade-off, not a tree-shaking
failure.

## TypeScript

| Environment | Status | Notes |
|---|---|---|
| TypeScript 5.9.3, `strict: true` | **Verified** | `tsc --noEmit` clean over `src`; `tsc -p tsconfig.test.json` clean over `tests/` + all 16 entry files (was 130 errors) |
| Declared minimum TS version | **None declared** | no `typesVersions`, no documented floor |
| Consumer-side `moduleResolution: bundler` / `node16` | **Not tested** | see below |

The package publishes both `.d.ts` and `.d.cts` for every subpath, and all 16
declared `types` targets were verified to exist in the packed tarball. What was
**not** done is compiling a standalone consumer project under `node16`/`bundler`
resolution — the declaration files were verified to *exist* and to be referenced
correctly, not to *compile cleanly in a fresh consumer*. Closing that gap is
recommended alongside the Node version matrix.

**No minimum TypeScript version is claimed**, and none is asserted here.

## Known caveats

These are documented architectural characteristics, not defects:

1. **Replacement hydration, not node adoption.** `hydrate()` replaces
   server-rendered DOM; node identity is not preserved.
2. **Global synchronous context.** `context()` is application-global, not
   request-scoped; `withContext()` does not survive an `await`.
3. **Batched Suspense streaming.** `renderToSuspenseStream` emits an early shell
   then flushes async boundaries as a batch — not per-boundary progressive
   streaming.
4. **SSR Suspense markup does not distinguish failure from pending.** Timeout,
   rejection, and still-loading all render the fallback.
5. **A server DOM implementation is required for SSR** and is not bundled.
6. **Plain `<a href>` is never intercepted** — only `RouterLink` routes.
7. **`query()` does not fetch under SSR** — effects are suppressed; SSR data
   comes from loaders and `serializeState()`.
8. **`router.go()/back()/forward()` call `history.*` unguarded** and will throw
   in a DOM-less runtime. Construction, initial resolution, and now `push` /
   `replace` / redirects are all safe there (RC-001, NODE-001); these three
   remain client-only calls into browser-history semantics a memory router
   cannot provide.
9. **SSR request isolation requires `AsyncLocalStorage`** — Node ≥ 22.3 under
   ESM (any supported Node under CommonJS). Where it is unavailable the runtime
   warns once and falls back to a shared store; synchronous renders are still
   correct (NODE-002).
10. **A raw `NUL` byte does not survive HTML serialization** — a conforming
   parser yields `U+FFFD` or drops it, and `CRLF`/`CR` fold to `LF`. This is the
   HTML format, not SibuJS.
