# Supported environment matrix

Evidence-based. **Verified** means a suite was actually executed in that
environment during release-candidate certification. **Not tested** means exactly
that — it is never a synonym for "works".

Certification host: Windows 11 (win32 10.0.26200 x64), Node v24.19.0,
npm 11.17.0, 12th-gen Intel Core i7-12650H, 32 GB RAM.
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
| Node 24 (v24.19.0) | **Verified** | full suite, soak, SSR, packaged consumers |
| Node 18 / 20 / 22 | **Not tested** | no other runtime installed on the certification host |

`package.json` declares `engines.node: ">=18.0.0"`. Only Node 24 was exercised.
The 18/20/22 claim is **inherited, not verified** — running the suite on each is
the single highest-value gap to close before a stable release, and is cheap in
CI (a matrix job).

One Node-specific behaviour was found and fixed during this pass (RC-002: an
un-`unref`'d cache timer holding the event loop open), which is a reminder that
Node-side behaviour is not free just because jsdom passes.

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
per-request suspense id sequences). On runtimes **without** `AsyncLocalStorage`
the implementation falls back to a mutated module-global store, and **concurrent
request isolation is not guaranteed there**. Anyone running SSR off-Node must
confirm `AsyncLocalStorage` is available.

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
| TypeScript 5.9.3, `strict: true` | **Verified** | `tsc --noEmit` clean over `src` |
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
   in a DOM-less runtime. Construction and initial resolution are safe
   (RC-001); these remain client-only calls.
9. **A raw `NUL` byte does not survive HTML serialization** — a conforming
   parser yields `U+FFFD` or drops it, and `CRLF`/`CR` fold to `LF`. This is the
   HTML format, not SibuJS.
