# SibuJS v4 Review Findings

Full-repo review of the `feature/split-core` branch (2026-07-08), covering
`@sibujs/core`, `sibujs`, `@sibujs/labs`, packaging, CI, and docs. Every
finding below was verified against the actual source; the highest-impact
engine findings were reproduced empirically with throwaway tests.

Severity: **Critical** = breaks users/CI/publish today. **Major** = real bug
with a concrete failure scenario. **Minor** = correctness/consistency gap with
limited blast radius.

Summary: 5 critical, 17 major, 31 minor.

---

## 1. Critical

### C1. `when`/`match`/`each` orphan their managed DOM when their anchor is disposed by an enclosing primitive

- `packages/core/src/core/rendering/directives.ts:94` (`when`), `:173` (`match`), `packages/core/src/core/rendering/each.ts:334`
- These primitives insert content as *siblings* of the returned Comment anchor, but the anchor's disposer only tears down the `track()` subscription — it never disposes or removes the current branch node / rows / `end` sentinel. Any parent that swaps the anchor out (nested `when`, a reactive child getter returning a `when()`/`each()` anchor, outer `match`) removes only the comment.
- Reproduced: `when(outer, () => when(inner, () => p("INNER")), () => p("ELSE"))` → after `setOuter(false)` the DOM reads `"ELSEINNER"`. An `each` swapped out by a conditional leaves `"EMPTY12"`. Stale content stays visible **and** its bindings are never disposed (leak).
- Fix: in the anchor's `registerDisposer`, also dispose + remove the live branch node / all rows + sentinel — exactly what `KeepAlive` (`keepAlive.ts:137-147`) and `Portal` (`portal.ts:63-70`) already do.

### C2. Legacy publish path ships the literal `workspace:*` dependency — published `sibujs` would be uninstallable

- `packages/sibujs/publish.mjs:202` (`npm publish --access public`), wired to `"publish:npm"` in `packages/sibujs/package.json`; dependency at `packages/sibujs/package.json` (`"@sibujs/core": "workspace:*"`)
- `npm publish` does not rewrite the `workspace:` protocol, so the tarball ships `"@sibujs/core": "workspace:*"` verbatim and every consumer `npm install sibujs` fails with `EUNSUPPORTEDPROTOCOL`. `release.sh` is likewise a single-package v3 flow (checks out `main`; its comment claims provenance is configured in package.json, which it isn't).
- Fix: delete or rewrite `publish.mjs` / `release.sh`; publish only via `pnpm -r publish` (which rewrites `workspace:*`), as `publish.yml` already does.

### C3. Both GitHub workflows fail at pnpm setup: `version: 9` conflicts with the `packageManager` pin

- `.github/workflows/ci.yml:14-16, 39-41`, `.github/workflows/publish.yml:18-21`; root `package.json` pins `"packageManager": "pnpm@9.12.0"`
- `pnpm/action-setup@v4` errors with "Multiple versions of pnpm specified" when the `version` input differs from `packageManager`. Every CI and publish run dies before install.
- Fix: remove the `version: 9` input from all three `pnpm/action-setup` steps and let the action read `packageManager`.

### C4. CI/publish run tests before build, but tests resolve workspace packages through `exports` → `dist/`, which is gitignored

- `.github/workflows/ci.yml` (test step before build), `.github/workflows/publish.yml` (Test before Build), `.gitignore` (`dist/`)
- `packages/labs/tests` import `sibujs/ssr`, `@sibujs/core`, etc., and `packages/sibujs/src` imports `@sibujs/core` — all resolved via exports maps to `dist/*.js`. On a fresh checkout, `dist/` does not exist. Verified empirically: renaming `packages/core/dist` makes `packages/labs/tests/entry-barrels.test.ts` fail 8/8.
- Fix: run `pnpm -r --if-present run build` before typecheck/test in both workflows (`pnpm -r` build is already topological: core → sibujs → labs).

### C5. `pnpm -r run lint` fails in all three packages — the blocking CI lint step cannot pass

- `packages/core` and `packages/labs` have lint scripts (`biome check src/ tests/`) but no `biome.json` in their config chain (the only config is `packages/sibujs/biome.json`, which does not apply to siblings), so Biome defaults fire (e.g. `lint/suspicious/noExplicitAny` in `packages/core/src/core/dev.ts`). `packages/sibujs` also fails today with `assist/source/organizeImports` diagnostics across `src/data/*`.
- Fix: add a shared root `biome.json` (or per-package configs matching sibujs's) and run `biome check --write` on the unsorted imports.

---

## 2. Major — `@sibujs/core`

### CO-1. `DocumentFragment` as a reactive child is unremovable

- `packages/core/src/reactivity/bindChildNode.ts:68, 88`; same pattern in `when`/`match` (`result instanceof Node`) and `each`'s `resolveNodeChild`
- A getter returning `Fragment([...])` is tracked as one "node"; insertion spills its children and empties the fragment, so the next commit's dispose + remove hits an empty, parentless fragment — old children stay in the DOM forever and stack up. Reproduced: toggling `Fragment([p("A"), p("B")]) ↔ p("C")` yields `"AB" → "CAB"`. `KeepAlive` (`keepAlive.ts:92-97`) explicitly guards this; the binding paths don't.
- Fix: expand fragments into their child node list before tracking them in `lastNodes`.

### CO-2. `htm` boolean expression attributes: `disabled=${false}` disables the element

- `packages/core/src/core/rendering/htm.ts:399-407`
- The non-function expression path does `String(val)` + `setAttribute` for any non-null value, so `false` sets `disabled="false"` — which in HTML means *disabled*. Reproduced: `` html`<button disabled=${false}>` `` → `hasAttribute("disabled") === true`. `tagFactory` (`tagFactory.ts:369-377`) handles booleans correctly.
- Fix: mirror tagFactory's boolean branch (true → `""`, false → skip/remove; property path for `checked`/`disabled`/`selected`).

### CO-3. ErrorBoundary fallback memoization cross-wires error/retry between boundary instances

- `packages/core/src/components/ErrorBoundary.ts:213-243`
- The cache is keyed by `(fallback fn, error.message)` in a module-global WeakMap. Two boundaries sharing one module-level fallback fn, hitting errors with the same message, both render a factory closed over the **first** boundary's `Error` and `retry` closure — the second boundary shows the wrong error and its Retry button resets the *other* boundary. Also stale within one boundary: a new error with an identical message renders the old error object. Reproduced.
- Fix: scope the cache per boundary instance and key by error identity, or drop the memoization (fallback render is not hot).

### CO-4. `derived` `equals` option does not do what it documents

- `packages/core/src/core/signals/derived.ts:29-31, 73` + `packages/core/src/reactivity/track-core.ts:624-666`
- Docs promise "when the recomputed value equals the previous, downstream subscribers are not notified", but propagation is push-eager: `propagateDirty` enqueues all downstream effects at write time, before the computed is pulled; `equals` only prevents the cached value from changing. Reproduced: an effect on `derived(() => n() % 2, { equals })` re-ran when `n` went 0 → 2 (parity unchanged).
- Fix: implement a pull-validate step before running enqueued effects, or correct the documentation (it currently promises memo semantics the engine doesn't have).

### CO-5. `asyncDerived` can never be disposed

- `packages/core/src/core/signals/asyncDerived.ts:44-95`
- The internal `effect()`'s disposer is discarded and the returned state exposes no teardown, so dependency subscriptions (and re-fetch behavior) live for the life of the source signals — a guaranteed leak plus post-unmount fetch/state writes for any component-scoped usage.
- Fix: expose `dispose` on the returned object (as `defer()` does in `concurrent.ts:79-83`).

### CO-6. `enhance().attr` bypasses the shared attribute-sanitization policy

- `packages/core/src/platform/enhance.ts:192-211`
- It writes `setAttribute(name, String(v))` directly: no event-handler-attribute guard and no URL sanitization, even though `sanitize.ts:17` claims to be the single shared policy for every attribute-writing path. `ctx.attr(t, "href", () => url)` passes `javascript:` URLs that `bindAttribute` blocks, and `ctx.attr(t, "onclick", …)` writes an executable handler attribute. Islands feed server data into these bindings, making this the package's most exposed sanitization gap.
- Fix: route through `sanitizeAttributeString` and refuse `on*` names, same as `bindAttribute.ts:29-77`.

---

## 3. Major — `sibujs` (std)

### SD-1. `query()`: aborting one subscriber's fetch permanently wedges other subscribers of the same key

- `packages/sibujs/src/data/query.ts:150-176` (dedup branch), `:180` (`abortController?.abort()`)
- Instances A and B share key K; A starts the fetch (fetcher gets A's AbortSignal), B awaits the deduped promise. A's key changes or A is disposed → A aborts → the shared promise rejects. A's catch clears `entry.promise`; B's catch then sees `entry.promise !== captured`, skips the cache update, and never clears `isFetching` or retries. B shows `fetching()/loading() === true` forever with no data and no error.
- Fix: in the awaiter's catch, always clear `isFetching` (and optionally re-issue the fetch when the entry has no data and no new promise).

### SD-2. Router hash mode writes real pathnames, never the hash — back/forward broken

- `packages/sibujs/src/plugins/router.ts:1101-1113` (`updateHistory`) vs `:819-827, 863-864`
- `mode: "hash"` reads from `location.hash` and listens to `hashchange`, but `updateHistory` unconditionally does `history.pushState(state, "", base + to.path + …)`, mutating the pathname. Consequences: the URL bar shows `/users/1` instead of `#/users/1` (a reload hits the server route hash mode exists to avoid), and `pushState` fires no `hashchange`, so browser Back/Forward changes the URL without the router reacting.
- Fix: in hash mode write `location.hash` (or push `#${path}`) and handle history accordingly.

### SD-3. Constructing a router in Node/SSR crashes one microtask later despite the SSR guard

- `packages/sibujs/src/plugins/router.ts:815-840` (`initialize`), `:860-875` (`getCurrentPath`)
- Only the event-listener setup is guarded with `typeof window !== "undefined"`; the `queueMicrotask` still calls `handleLocationChange()` → `getCurrentPath()` → `window.location.…` — a ReferenceError inside a microtask → `uncaughtException` in Node. The comment claims `createMemoryRouter` is safe for testing/SSR; it is not (and `createMemoryRouter` also ignores its `_initialPath` argument entirely, `:2378-2394`).
- Fix: guard the microtask body (or `getCurrentPath`) with the same `typeof window` check; honor `_initialPath`.

### SD-4. Navigating by route `name` produces wrong URLs for nested routes

- `packages/sibujs/src/plugins/router.ts:1055-1060` (`resolvePath`) vs `:284-312` (`buildIndex`)
- `namedRoutes` maps name → `RouteDef`, and `resolvePath` uses `namedRoute.path`, which for a child route is only the segment (e.g. `/profile`), not the indexed full path (`/users/profile`). `navigate({ name: "profile" })` targets a path that doesn't exist in the trie.
- Fix: store the full indexed path alongside the named route.

### SD-5. Stale navigation can commit over a newer one (no abort check before commit)

- `packages/sibujs/src/plugins/router.ts:1034-1046` (`performNavigation` tail), `:977-998` (beforeEnter loop)
- `beforeEnter` guards are plain promises not wired to the abort signal; `signal.aborted` is checked only at the top of each loop iteration. Nav A awaits a slow guard; nav B starts (aborting A's signal) and commits; A's guard then resolves and A falls through to `updateHistory` + `currentRouteSetter(to)` with no final abort check — clobbering B's committed route and pushing a stale history entry.
- Fix: check `signal.aborted` immediately before `updateHistory`/`currentRouteSetter`.

### SD-6. SSR silently destroys inline SVG (and any non-HTML element)

- `packages/sibujs/src/platform/ssr.ts:143-145` (`renderToString`), `:565-568` (`renderToStream`)
- `SVGElement` is not `instanceof HTMLElement`, so an `<svg>` subtree (a supported feature — see `svgElement` in `src/platform/customElement.ts:97`) hits the fallback `return escapeHtml(element.textContent || "")`: the whole SVG serializes as its concatenated text. Missing server-rendered content plus a guaranteed hydration mismatch.
- Fix: branch on `element instanceof Element` / `nodeType === 1` and serialize SVG through the same attribute pipeline.

### SD-7. Build tooling emits/refers to a wrong npm package name (`"sibu"`) — generated code is broken

- `packages/sibujs/src/build/vite.ts:203, 206, 231` — the template compiler injects `import { div, … } from "sibu"` / `import { staticTemplate } from "sibu"` into user code; `sibu` is not this framework's package, so builds using `compileTemplates`/`staticOptimize` fail to resolve (or pull a foreign package).
- Same drift: `vite.ts:103-105, 148, 152, 332, 351` (`optimizeDeps.include`, `ssr.noExternal`, dev-helper detection), `src/build/routeSplitting.ts:141` (generated route files), `src/build/declarations.ts:110-111` (tsconfig paths to `node_modules/sibu`), `src/build/cdn.ts:12` (`PACKAGE_NAME = "sibu"` → all CDN URLs/import maps wrong; `generateImportMap` also maps subpaths to `dist/core/index.js`, `dist/reactivity/index.js`, … which don't exist in the v4 dist layout).
- Fix: replace with `sibujs` and the real v4 dist paths throughout the build tier.

### SD-8. Vite plugin injects TypeScript-only syntax into `.js` files

- `packages/sibujs/src/build/vite.ts:96-110` (`injectDevHelpers`)
- The injected line contains a TS cast (`globalThis as unknown as Record<string, unknown>`) but the transform runs (with `enforce: "pre"`) on `**/*.js` / `**/*.jsx` too. Any plain-JS file importing the framework gets a syntax error in dev mode.
- Fix: emit plain JS (`globalThis.__SIBU_DEV__ = true`).

### SD-9. `offlineStore`: `SyncAdapter.conflictStrategy` is a required field that is never read

- `packages/sibujs/src/data/offlineStore.ts:36`
- `sync()` hard-codes one behavior (pending local edits shadow pulled rows, roughly client-wins). A user selecting `"server-wins"` or `"manual"` silently gets different semantics — local dirty data survives and is pushed over the server's on the next round.
- Fix: implement the strategies or remove the field.

---

## 4. Major — `@sibujs/labs`

### LB-1. `deferredValue()` creates an undisposable effect; permanent subscription leak on the source signal

- `packages/labs/src/performance/concurrent.ts:34-38`
- The `effect(...)` teardown is discarded and the returned API is just the getter — there is no way to dispose. After a component using `deferredValue(searchQuery)` unmounts, the source signal still holds the effect subscriber: every source change re-runs the getter and queues a LOW-priority scheduler task forever; repeated mounts accumulate without bound.
- Fix: return `{ value, dispose }` (or attach `dispose` on the getter, as `persisted()` does in `patterns/persist.ts:177`).

### LB-2. Redux/Zustand adapter `select()` mints an eagerly-subscribed `derived` per call with no dispose

- `packages/labs/src/ecosystem/adapters/redux.ts:60-62`, `zustand.ts:61-63`
- `derived()` performs an eager initial `track()`, permanently linking into the adapter's app-lifetime `getState` signal. The documented usage is per-component (`const count = redux.select(s => s.counter)`), so every mount adds a subscriber + retained selector closure removable only by `destroy()`ing the whole adapter. `patterns/globalStore.ts:112-119` documents exactly this leak and fixed its own `select` by returning a plain getter; the adapters were not given the same fix.
- Fix: `return () => selector(getState());` (matching globalStore), or return a disposable derived.

---

## 5. Major — packaging / publish

### PK-1. Publishing 4.0.0-alpha.0 to the `latest` dist-tag

- `.github/workflows/publish.yml:47` — `pnpm -r publish --access public --no-git-checks` has no `--tag`. `npm install sibujs` and the README's CDN URL (`packages/sibujs/README.md:178`, `…sibujs@latest/dist/cdn.global.js`) would serve the alpha to all v3 users.
- Fix: add `--tag next` (or `alpha`) until stable; pin the README CDN URL to a concrete version for the alpha period.

### PK-2. `require` consumers get ESM-flavored type declarations (TS1479); the emitted `.d.cts` files are shipped but never referenced

- `packages/core/package.json`, `packages/sibujs/package.json`, `packages/labs/package.json` — every exports entry uses a single top-level `"types": "./dist/X.d.ts"` for both conditions. All packages are `"type": "module"`, so under `moduleResolution: node16/nodenext` a CJS TS consumer resolving `require` pairs an ESM-declared `.d.ts` with `.cjs` runtime → "masquerading as ESM" errors. tsup already emits `dist/*.d.cts` in all three packages; they're dead weight in the tarball.
- Fix: nest conditions — `"import": { "types": "./dist/X.d.ts", "default": "./dist/X.js" }, "require": { "types": "./dist/X.d.cts", "default": "./dist/X.cjs" }`.

### PK-3. `workspace:*` publishes as an exact pin, maximizing the duplicate-engine risk the architecture exists to prevent

- `packages/sibujs/package.json` (`"@sibujs/core": "workspace:*"`), `packages/labs/package.json` (both deps)
- pnpm rewrites `workspace:*` to the exact current version. A consumer with `sibujs@4.0.0-alpha.1` plus a direct `@sibujs/core@4.0.0-alpha.0` (or labs one release behind sibujs) gets two engine copies — exactly the duplicate-runtime scenario the core tripwire warns about.
- Fix: use `workspace:^` so published ranges overlap across releases (or move core to peerDependencies).

---

## 6. Minor

### `@sibujs/core`

1. **The `Symbol.for("sibujs.reactive.v1")` registry is not dev-only — only its warning is** (`packages/core/src/reactivity/track.ts:69-124`). In prod, a second copy silently delegates to the first; the legacy v3 monolith bundle publishes the same key (confirmed present in `packages/sibujs/dist/cdn.global.js`). Any future change to subscriber-node layout without bumping `.v1` (also `batch.ts:91`) breaks mixed-version pages silently. Documentation should say "prod-active first-copy-wins delegation", not "dev-only tripwire".
2. **Barrel collisions in `packages/core/index.ts:24-26, 82`**: the `<html>` tag factory is silently shadowed by the `html` template re-export (unreachable from the public API), and the public name `track` resolves to the `<track>` *element factory*, not the reactive primitive — importing `track` expecting reactivity silently builds a `<track>` element.
3. **`applyStyle` string/function paths skip `sanitizeCSSValue`** (`tagFactory.ts:94-106`) — whole-string styles bypass the per-property sanitization; inconsistent `url()`-exfiltration policy.
4. **`htm` bypasses `BLOCKED_TAGS`** (`htm.ts:381`) — `` html`<script src=…>` `` builds an executable script element that `tagFactory` refuses by policy. Low exploitability (template strings are author-controlled) but the invariant is inconsistent across the two public builders.
5. **`htm` mixed attributes stringify functions and are never reactive** (`htm.ts:411-429`) — `class="a ${sig}"` embeds the accessor's source code and never updates; no dev warning.
6. **`each` render callbacks and `DynamicComponent` factories run inside the tracked update** (`each.ts:211`, `dynamic.ts:79-94`) — a signal read synchronously in a row's render subscribes the whole-list reconciliation. Wrap in `untracked()`.
7. **`Suspense` never disposes the fallback subtree** (`lazy.ts:160-174`) — `replaceChildren(el)` detaches the fallback without `dispose()`; a reactive fallback leaks its bindings.
8. **`each` uses the anchor's current parent for removals/inserts of old rows** (`each.ts:249-252, 311-315`) — throws `NotFoundError` mid-reconciliation if the anchor was reparented between updates. Use `node.parentNode`.
9. **Islands activation race after cleanup** (`islands.ts:124-158`) — an in-flight `resolveSetup()` still calls `enhance()` after cleanup and pushes its disposer into the already-spliced array. Guard the `.then` with a disposed flag.
10. **`math` factory creates an `HTMLUnknownElement`** (`html.ts:104`) — MathML requires `createElementNS("http://www.w3.org/1998/Math/MathML", …)`.
11. **`store.getSnapshot` is documented "(non-reactive)" but reads through tracking getters** (`store.ts:86-93`) — inside an effect it subscribes to every key. Suspend tracking in the public path only (`subscribe()` relies on the tracked reads internally).
12. **Cycle break discards the remaining drain queue** (`track-core.ts:583-601`) — after `cycleError` the `break` drops all other pending subscribers for that drain pass, starving unrelated effects.
13. **Leftover scratch file**: `packages/core/tests/__review_scratch.test.ts` contains only review verification scaffolding (file deletion was blocked by permissions). Delete it.

### `sibujs` (std)

14. **`query()` `isStale` never flips by time passing** (`src/data/query.ts:139-146`) — it's a `derived` whose only reactive dep is `data()`; the `Date.now()` comparison is cached until data changes.
15. **`setQueryData` doesn't clear `entry.error`** (`query.ts:389-396`) — listeners re-apply the old error next to fresh data.
16. **`mutation`: a user-initiated AbortError is rethrown without state cleanup** (`src/data/mutation.ts:103`), leaving `loading() === true` forever. Distinguish via `signal.aborted`, not the error name.
17. **`throttle` trailing emission doesn't restart the cooldown** (`src/data/throttle.ts:38-50`) — two emissions can land ~1 ms apart, violating "at most once per interval".
18. **`RouterLink` active state uses `startsWith` without a segment boundary** (`router.ts:1888`) — a link to `/foo` is "active" on `/foobar`.
19. **`routeCleanups` grows without bound** (`router.ts:1412, 1638, 1827, 2251`) — executed disposers are never removed from the module-level array; one retained closure per outlet ever mounted.
20. **`Suspense` `fallback` type `() => HTMLElement | HTMLElement` parses as `() => HTMLElement`** (`router.ts:1966-1968`) — the runtime supports a plain element fallback but the type rejects it.
21. **`CustomElementOptions.extends` is declared but never passed to `customElements.define`** (`src/platform/customElement.ts:10-15, 120`) — customized built-ins silently don't work.
22. **`"serviceWorker" in navigator` throws ReferenceError in Node** (`src/platform/serviceWorker.ts:48`) — no `navigator` global on Node 18/20, and this ships in the `sibujs/ssr` entry.
23. **`scopedStyle` skips any selector starting with `to`/`from`** (`src/ui/scopedStyle.ts:118`) — the keyframe check uses `startsWith`, so `tool-tip`, `toolbar`, etc. leak globally unscoped.
24. **`renderToSuspenseStream` waits on `Promise.all(pendingBoundaries)` before flushing anything** (`src/platform/ssr.ts:863-872`) — one slow boundary degrades progressive streaming into all-or-nothing.
25. **`offlineStore.openDB` handles no `onblocked`** (`src/data/offlineStore.ts:79-93`) — a version upgrade while another tab holds the DB leaves the promise pending forever.
26. **Stale pre-split metadata exported publicly**: `src/plugins/modular.ts:174-186` (`packageInfo` — name `"sibu"`, version `"1.0.0"`, entry points to files that don't exist; `generateExportsMap` emits `.mjs` paths the build never produces), `src/plugins/ecosystem.ts:85-107` (`generateImportMap` → `node_modules/sibu/src/...`), `src/plugins/versioning.ts:29` (`VERSION = "1.0.0"` vs actual 4.0.0-alpha.0).
27. **`cdn.ts:6` header comment says the file is served as `dist/sibu.global.js`** while the build and exports map produce `dist/cdn.global.js`.

### `@sibujs/labs`

28. **`springSignal.set()` calls rAF with no feature guard** (`src/motion/springSignal.ts:100-113`) — any `set(target)` under SSR/Node throws ReferenceError; the rest of the package guards this. On missing rAF, snap to target (same path as the reduced-motion branch).
29. **`wakeLock`: concurrent `request()` calls orphan the previous sentinel** (`src/browser/wakeLock.ts:52-70`) — the screen stays awake until tab hide because only the latest sentinel is releasable. Return early if a live sentinel exists, or release the old one first.
30. **Devtools: unbounded node registry, dead `maxSignals` option, listener stacking on re-init** (`src/devtools/devtools.ts:269-339, 45, 544`) — nothing prunes on `effect:destroy` (core emits it), `maxSignals` is never read, and `destroy()` never unsubscribes the 7 `hook.on(...)` listeners, so a second `initDevTools()` (HMR/tests) stacks listener sets. Dev-only.
31. **`preloadResource()`/`prefetch()`/`preloadImage()` have no SSR guards** (`src/performance/domRecycler.ts:113-168`) — they touch `document` / `new Image()` unconditionally, inconsistent with `chunkLoader.ts:287` and the package convention.

### Packaging / docs / config

32. **`files` omissions**: no package includes `CHANGELOG.md` in `files`, and `packages/sibujs/package.json` omits `MIGRATION.md` even though the 4.0.0-alpha.0 changelog entry says "See `MIGRATION.md`". The README has no migration link at all.
33. **`sideEffects: false` will tree-shake the CDN bundle** (`packages/sibujs/package.json`) — a bundler user writing `import "sibujs/cdn"` gets the IIFE eliminated. Use `"sideEffects": ["./dist/cdn.global.js"]`.
34. **No node10 types fallback for subpaths** — tarballs contain only `dist/`, no `typesVersions`, so TS consumers on `moduleResolution: "node"` can't resolve `sibujs/data`, `@sibujs/core/internal`, etc. (The repo's own `tsconfig.base.json` uses `"moduleResolution": "node"` and only works in-repo thanks to the unpublished root `*.ts` stubs.) Add `typesVersions` or document node16+-only.
35. **tsconfig `include` gaps**: `packages/core/tsconfig.json` never typechecks `internal.ts` (a published entry); `packages/sibujs/tsconfig.json` never typechecks `data.ts`, `ui.ts`, `ssr.ts`, `plugins.ts`, `build.ts`, `testing.ts`, `cdn.ts`.
36. **labs README misdescribes its dependencies** (`packages/labs/README.md`) — "install those alongside it" contradicts the manifest: `@sibujs/core` and `sibujs` are regular dependencies installed automatically.
37. **`sibujs` package.json `description` names competitor frameworks** (`packages/sibujs/package.json:4`) — this renders on the npm page, a public artifact; reword to describe SibuJS on its own terms.
38. **Mixed package managers in scripts** (`packages/sibujs/package.json`) — `prepublishOnly` and `test:browser` invoke `npm run` inside a pnpm workspace; `prepublishOnly` also redundantly rebuilds during `pnpm -r publish`. Use `pnpm run build`.
39. **No tag/version guard in `publish.yml`** — the workflow publishes whatever versions the manifests contain regardless of the release tag name; a mistagged release silently publishes the wrong version. Add a step asserting tag == workspace version.

---

## 7. Verified clean areas

- **Reactivity engine** (`track-core.ts` linked-list core, `batch`, `signal`, `effect`, `watch`, `context`, `writable`, `ref`, `deepEqual`, reactive arrays): traced nested track/retrack, active-node save/restore, epoch pruning, node-pool reuse, re-entrancy/disposed guards — sound.
- **Sanitization** (`sanitize.ts` URL/scheme/srcset handling, `dispose.ts` traversal, `lifecycle.ts` shared-observer bookkeeping, `ssr-context`/`createId`/`globalSingleton`): correct.
- **SSR escaping** (`ssr.ts`, `routerSSR.ts`, `head.ts`): attr-name allowlists, `on*` stripping, URL/srcset sanitization, comment-terminator and `U+2028/29` escaping, prototype-pollution guards, `TrustedHTML` brand gating — no XSS gap found.
- **std data/ui utilities** (`retry`, `resource`, `formAction`, `toast`, `eventBus`, `pagination`, `timers`, `hover`, `scrollLock`, `dialog`, `form`, testing tier, worker pool): cleanup/abort/latest-wins handling is careful; no failure constructed.
- **labs browser tier** (30 modules): uniformly SSR-safe, correct teardown, async races guarded. **Widgets**: idempotent binds, full listener/timer cleanup. **Patterns**: `persisted`, `optimistic`, `machine`, `timeline`, `globalStore` sound. **Scheduler**: correct tier re-arming and SSR fallbacks.
- **Import hygiene, all packages**: no deep imports into another package's `src/**`; everything goes through `@sibujs/core`, `@sibujs/core/internal`, or published `sibujs` subpaths; dependency direction strictly labs → sibujs → core; all imported internal names verified to exist.
- **Exports maps vs dist**: all subpaths in all three packages correspond 1:1 to tsup entries; tsup external/noExternal split (module builds external, CDN inlined) correct; `pnpm -r publish` order is topological.
- **Docs accuracy**: README/MIGRATION subpath tables match real exports maps; CHANGELOGs correctly scoped per package; all English.
