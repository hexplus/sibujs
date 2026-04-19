# Changelog

All notable changes to SibuJS will be documented in this file.

This project follows [Semantic Versioning](https://semver.org/).

---

## [3.0.0] — 2026-04-19

### Breaking

- **`ErrorBoundary` drops the `nodes` option** — the subtree is now passed as the positional second argument, matching the tag-factory shorthand (`tag(props, children)`). This removes the last `nodes:` prop from the public framework surface (tag factories migrated in 1.3.0). Signature:

  ```ts
  ErrorBoundary(children: () => Element): Element;
  ErrorBoundary(options: ErrorBoundaryOptions, children: () => Element): Element;
  ```

  **Migration:**

  ```ts
  // Before
  ErrorBoundary({
    nodes: () => RiskyArea(),
    fallback: (err, retry) => …,
    onError,
    resetKeys,
  });

  // After
  ErrorBoundary(
    { fallback: (err, retry) => …, onError, resetKeys },
    () => RiskyArea(),
  );

  // Options-free form
  ErrorBoundary(() => RiskyArea());
  ```

  `ErrorBoundaryProps` is retained as a deprecated alias of the renamed `ErrorBoundaryOptions` so type imports keep compiling.

---

## [2.2.0] — 2026-04-18

Reactivity-core rewrite. Replaces the `Set<Subscriber>` / `Map<Signal, epoch>` subscription graph with doubly-linked `SubNode` edges, a node pool, and an `__activeNode` back-pointer for O(1) duplicate-dependency detection. Subscription is now O(1) on both add and remove, the hot path has no hash operations, and GC churn on create/destroy workloads drops sharply.

**Improvements over 2.1.0 on the reactivity stress-test suite (`benchmarks/`):**

- **Wide graph / 10k fan-out: ~73% faster** (56.8 ms → 15.4 ms)
- **Cascading effects: ~41% faster** (2.03 ms → 1.20 ms)
- **Memory & cleanup: ~21% faster** (51.3 ms → 40.6 ms)
- **Component tree propagation: ~10% faster** (23.0 ms → 20.6 ms)
- **Deep computed chain: ~7% faster** (3.87 ms → 3.60 ms)

**201/201 test files, 2187/2187 tests passing. No breaking changes to the documented public API** — `signal`, `derived`, `effect`, `batch`, `untracked`, `on`, `setMaxDrainIterations`, `setMaxSubscriberRepeats`, devtools introspection helpers, all behave identically.

### Added

- **`cleanup(subscriber)`** now exported from `sibujs/reactivity/track`. Disposes a subscriber directly without allocating an intermediate closure. Enables custom effect-like primitives to manage their own lifecycle without going through `track()`'s disposer.
- **`getSubscriberCount(signal)`** — O(1) count of active subscribers, read from the `__sc` counter maintained on every subscribe/unsubscribe.
- **`getSubscriberDeps(subscriber)`** — returns the signals a subscriber currently depends on, in record order. Replaces the previous `_dep` / `_deps` probe used by devtools.
- **`forEachSubscriber(signal, visit)`** — iterate a signal's subscriber list without exposing the internal linked-list structure to callers.

### Changed

- **Subscription storage migrated from Set + Map to doubly-linked `SubNode` edges.** Each `(signal, subscriber)` pair is one object linked into both the signal's subscriber list and the subscriber's dep list. O(1) subscribe / unsubscribe via pointer splice, no hash operations on the hot path, one allocation per edge instead of two.
- **Duplicate-dependency detection during tracking is now O(1)** via a `signal.__activeNode` back-pointer (Preact Signals' approach). A subscriber with 10 000 deps reading one signal twice no longer pays O(N²) in its inner loop.
- **Effects now re-run via `retrack()` instead of `track()`.** Stable-dep effects (the overwhelmingly common case) skip the cleanup-and-rebuild cycle entirely — epoch-based pruning at end of run handles any deps that were dropped this invocation. On the Cascading Effects benchmark this drops per-invocation cost by ~40 ns.
- **Effect internals consolidated behind an `EffectCtx` object.** Per-effect closure count went from six (`onCleanup`, `flushUserCleanups`, `wrappedFn`, `drainReruns`, `subscriber`, `dispose`) to three. `runSubscriber` and `runBody` are inlined directly into the per-effect closures, eliminating a function frame per invocation.
- **`track()` is stack-free.** The shared `subscriberStack` array is gone; `track()` uses a local `prev` / restore pattern, and `suspend/resumeTracking` capture `currentSubscriber` directly. ~5–10 ns saved per track call, universal improvement.
- **Signal state pre-initialises every internal slot** (`__v`, `__sc`, `subsHead`, `subsTail`, `__activeNode`, `__name`) at construction. V8 hidden classes stay monomorphic across all signals; inline caches in the reactivity hot paths don't transition on first subscribe.
- **Signal setter specialised at creation time** — one closure for the default `Object.is` equality path, one for custom `equals`, one dev-mode variant carrying the devtools-hook emission. No per-call branching on the hot path.
- **Cached `track()` disposer** via `sub._dispose ??= …` — allocated once per subscriber instead of once per `track()` call. Meaningful for high-churn workloads (large lists, create/destroy cycles).
- **Node pool** (cap 4 096) recycles freed `SubNode` objects. Shape-stable allocation keeps hidden classes monomorphic; a create/destroy cycle with 25 000 effects reuses edge nodes instead of allocating and freeing them.

### Removed

- **`signal.__s`** — the Set-based subscriber cache. Replaced by `subsHead` / `subsTail` linked-list anchors plus `__sc` (count). External consumers should read counts via `getSubscriberCount()`.
- **`signal.__f`** — the single-subscriber fast-path cache. A one-node linked-list walk is inherently as fast as the check it was avoiding.
- **Internal `subscriberStack`** — the shared push/pop array used by the old `track()` / `suspend/resume` pair. Not observable from user code.

### Internal

- `introspect.ts` delegates to the new `getSubscriberCount` / `getSubscriberDeps` / `forEachSubscriber` helpers. Public API surface (`ReactiveNodeInfo`, `getSignalName`, `getDependencies`, `inspectSignal`, `walkDependencyGraph`) unchanged.
- `devtools.ts` reads `node.ref?.__sc` instead of `node.ref?.__s.size`.
- A three-color CLEAN/CHECK/DIRTY propagation model was prototyped and reverted after benchmark regression (+122% on Deep Chain). The workloads in the current suite all produce new downstream values on every signal change, so the CHECK state has no work to skip — only overhead to add. A dedicated benchmark suite for stabilisation patterns needs to come first; re-introducing three-color propagation is parked for a future release.

---

## [2.1.0] — 2026-04-17

Reactivity-core hardening release. Closes correctness gaps around effect re-entry, derived stale deps, sibling-effect consistency, and cycle detection. **201/201 test files, 2187/2187 tests passing — no behavior changes to user code that was already correct.**

### Fixed

- **Effects that write to a signal they subscribe to no longer silently drop the update.** Previously the re-entrant invocation was dropped with a dev-only warning, leaving the effect's observed state out of sync with reality. Now the update is flagged as `rerunPending` and the effect re-runs after its current body completes, converging on consistent state. A 100-iteration safety cap breaks legitimate write-reads-self cycles with a loud `console.error` instead of hanging.

- **`derived()` no longer accumulates stale dependencies on conditional code paths.** A getter like `() => flag() ? a() : b()` used to keep both `a` and `b` subscribed forever once both had been read, causing spurious re-evaluations whenever the untaken branch fired. The `retrack()` pull path now tags each dependency with a per-evaluation epoch and unsubscribes any edge whose epoch is stale at end of run — bounded memory, no spurious work.

- **Sibling effects now converge to consistent state through the outermost notification.** Previously two paths of `notifySubscribers` diverged: the pure-effect fast path allowed re-enqueue (effects could run twice, final state consistent), while the mixed-computed slow path forbade it (effects ran once, possibly observing stale downstream state). Both paths now share a single drain with at-most-once enqueue dedup cleared before invoke — sibling effects that cross-write converge rather than one losing to the other.

- **Unbounded empty-`__s` allocation per signal.** Signals whose last subscriber disposed kept an empty subscriber `Set` on the signal object for the process lifetime. The set is now cleared when size drops to zero.

- **`subscriberStack` never released memory after a one-off nesting spike.** A transient deep-nesting excursion (e.g. a debug-mode traversal) could double the stack and retain it forever. The stack now shrinks lazily at end-of-`track()` when idle and over-allocated.

### Changed

- **Cycle detection is now per-subscriber repeat-counted instead of total-iteration-capped.** The previous 100 000-iteration cap conflated "infinite cycle" with "legitimate large fan-out" — apps with 100k+ effects in one batch flirted with false positives while real tight cycles could burn the full budget before tripping. The new detector counts per-subscriber firings within a drain and bails when any single subscriber exceeds `maxSubscriberRepeats` (default 50) — accurate, cheap, and tolerant of arbitrary legitimate fan-out. The absolute iteration cap is retained as a safety net at 1 000 000.

- **`setMaxDrainIterations(n)`** is now the safety-net knob rather than the primary cycle check; semantics unchanged for callers, default raised from 100 000 → 1 000 000.

### Added

- **`setMaxSubscriberRepeats(n)`** — raise/lower the per-subscriber repeat cap used for cycle detection. Returns the previous value.

### Internal

- Subscriber dep storage in the reactivity core migrated from `Set<signal>` to `Map<signal, epoch>` to carry per-edge epoch tags for `retrack()` pruning. Public API unchanged; the single-dep fast path still avoids `Map` allocation entirely.

- `__f` / `__s` fast-path invariant centralized in a `syncFastPath()` helper — same performance, simpler to reason about across add/remove sites.

- Devtools `introspect.getDependencies()` updated for the new `Map` layout; return type unchanged.

---

## [2.0.0] — 2026-04-14

Major hardening + features release. Spans reactivity, rendering, SSR, widgets, security, and build tooling. **2187/2187 tests passing, zero lint errors, zero type errors.**

### Breaking

- **Adapter method renames** — `redux.useSelector` → `redux.select`, `zustand.useSelector` → `zustand.select`. The `use*` prefix is no longer used anywhere in the framework.
  ```ts
  // before
  const count = redux.useSelector(s => s.count);
  // after
  const count = redux.select(s => s.count);
  ```

- **`useDefaultPluginRegistry` renamed to `setDefaultPluginRegistry`** — aligns with the verb-based convention used elsewhere.

- **`loadRemoteModule()` now refuses un-allowlisted URLs** — previously warned in dev and loaded anyway. Now rejects unless `{ allowedOrigins: [...] }` or `{ unsafelyAllowAnyOrigin: true }` is passed (CWE-829 supply-chain hardening).

- **`loadWasmModule()` / `preloadWasm()` require origin allowlist** — same policy as `loadRemoteModule`. Options bag now disambiguated via `allowedOrigins`/`unsafelyAllowAnyOrigin` keys only.

- **`compiled.staticTemplate()` / `precompile()` require `TrustedHTML`** — arbitrary strings no longer accepted to prevent silent `innerHTML` XSS sinks. Mint via `trustHTML(raw)` after your own sanitization pass.

- **Router refuses protocol-relative redirects** — `"//evil.com/path"` style redirect targets now throw `NavigationFailureError` instead of logging a warning (CWE-601 open redirect).

- **`hydrate()` / `hydrateIslands` / `hydrateProgressively` use replace strategy** — the prior in-place attribute-reconciliation silently orphaned reactive bindings to the discarded client tree, leaving the visible DOM frozen. The client subtree now replaces the server subtree (island markers and `data-sibu-hydrated` preserved) so reactive bindings actually drive the DOM.

- **`socket()` / `stream()` default `maxReconnects` is now 10** — was effectively unbounded. Permanently broken URLs no longer hammer servers forever. Exponential backoff with jitter added.

- **`optimisticList()` deprecated aliases removed** — `addOptimistic`/`removeOptimistic`/`updateOptimistic` were deprecated in 1.5.0 and are now gone. Use `add`/`remove`/`update`.

- **`contentEditable().setContent` signature widened** — takes either a string (raw HTML, legacy) or `{ text, html, sanitize }`. The options form is the recommended path.

### Added

- **`retrack()`** reactivity primitive for derived pull-path — skips the `track()` cleanup pass; uses save/restore of `currentSubscriber` instead of stackTop push/pop. Steady-state chains avoid Set.delete+add churn.

- **`effect((onCleanup) => { … })`** — canonical teardown pattern now built in. User cleanups run in reverse registration order before every re-run and on dispose; throwing cleanups are isolated and logged.
  ```ts
  effect((onCleanup) => {
    const handler = () => { … };
    window.addEventListener("resize", handler);
    onCleanup(() => window.removeEventListener("resize", handler));
  });
  ```

- **`derived(getter, { equals })`** — custom equality suppresses notifications when the recomputed value is equivalent to the previous.

- **`Dispose` canonical type** exported from `sibu`.

- **Widget ARIA `bind()` layer** — every headless widget now ships a `bind(els)` that wires roles, keyboard, and idempotent teardown per WAI-ARIA APG:
  - `Tabs` — role=tablist, roving tabindex, Arrow/Home/End
  - `Accordion` — aria-expanded/controls, Enter/Space
  - `Tooltip` — role=tooltip, aria-describedby splice, Escape dismiss, hoverable grace
  - `Popover` — role=dialog, aria-haspopup, Escape + click-outside
  - `Combobox` — Combobox 1.2 pattern, aria-activedescendant, typeahead
  - `Select` — role=listbox, aria-multiselectable, typeahead, disabled-aware
  - `FileUpload` — labeling, aria-describedby splice, drop-zone keyboard
  - `datePicker` — role=grid, arrow/Home/End, PageUp/Down, Shift+PageUp/Down (year)
  - All `bind()` returns are idempotent via WeakMap and restore every touched attribute on dispose.

- **`takePendingError()` exported** — ErrorBoundary now scans mounted subtrees for stashed errors from `lazy()` rejections that beat any boundary to mount. Multiple pending errors wrapped in `AggregateError`.

- **`trustHTML(html)` + `TrustedHTML` type** re-exported from `sibu` (was only on `sibu/ssr` and `sibu/performance`, which minted incompatible brands).

- **Test-reset helpers** — `__resetQueryCache`, `__resetDialogStack`, `__removeRouterPagehideHandler`.

- **Build/release hardening** — `tsup --clean`; `./cdn` subpath export; `publishConfig.access=public` + `provenance=true`; `publish.mjs` publishes BEFORE git commit/tag (so a publish failure leaves no orphan commit).

- **10 new tests** — `keepAlive.test.ts`, `pluginRegistry.test.ts`, `widgetsAria.test.ts`.

### Fixed — Reactivity

- **`derived` pull-path correctness under `suspendTracking`** — new conditional deps register their markDirty subscription even when the outer caller is in `untracked()` context.
- **`propagateDirty`** is iterative (no recursion) with already-dirty skip — closes O(depth²) walk on deep chains.
- **`batch.flushBatch`** wrapped in try/finally — a throwing subscriber can't strand `pendingSignals` for the next batch.
- **`effect()` disposer idempotent** — double-dispose no longer re-emits `effect:destroy` or re-walks subs lists.
- **`effect()` re-entry detection** — a re-entering update now warns in dev and drops (was silent).
- **`bindChildNode` diff** — O(n²) nested scan replaced with O(n+m) Set-based reuse detection; dedupes duplicate node refs in the output array.
- **Dead `signalSubscribers` WeakMap** removed (the `__s` property cache is authoritative).

### Fixed — Rendering & Lifecycle

- **`dispose()` re-entry safe** — snapshot-then-delete + bounded extra-pass drain. `Array.from(childNodes)` snapshot guards against disposers mutating the tree mid-walk.
- **`onUnmount` false-fires on same-tick re-parent** — `fireUnmount` defers one microtask and re-checks `isConnected`.
- **`lifecycle` descendant walk** short-circuited for leaf insertions.
- **`keepAlive` disposed-flag** prevents post-dispose microtask writes; cached subtrees properly disposed on anchor teardown.
- **`each` itemGetter** wraps in `untracked()` so per-row consumers don't subscribe to the whole-array signal.
- **`each`, `portal`, `lazy.Suspense` error propagation** — CustomEvent dispatched on the anchor's Element parent (Comment anchors don't bubble); deferred one microtask for pre-mount races.
- **`lazy()` pending-error stash** (`PENDING_ERROR` marker) — ErrorBoundary scans descendants on mount so failures before any boundary mounts aren't silently lost.
- **`hydrateProgressively` island marker preserved** on replacement.

### Fixed — Data & Platform

- **`workerFn` pool crosstalk** — per-worker FIFO queue with `addEventListener`; terminate-on-error so concurrent `run()` calls can't mis-route results.
- **`worker()` top-level** uses `addEventListener` + terminate-on-error.
- **`infiniteQuery` run-id generation** — stale responses discarded; `AbortController.abort()` at top of effect.
- **`offlineStore` atomic writes** — `idbPutWithChange` / `idbDeleteWithChange` single-transaction across `items`+`_changes`; cursor-snapshotted sync; pull skips items with pending local edits (conflict avoidance); `idbPutMany` batches remote items; `closed` flag checked between awaits; `sync()` error now logs via `devWarn` (was silent).
- **`query` dedup** captures `entry.promise` locally and re-checks identity after await; sync-throw from `withRetry` cleaned up; `onSettled` in `finally`; `dispose()` idempotent + gcTimer deduplicated.
- **`chunkLoader`** true LRU with `lastAccess`; `invalidate(id)` clears `preloaded`; `this.load` replaced with closure reference (destructure-safe); preload `.delete(id)` on failure.
- **`serviceWorker`** listener refs tracked; prior `statechange` detached before reassignment; all detached in `unregister()`.
- **`incrementalRegeneration`, `routerSSR`, `wakeLock`, `clearQueryCache` refetchers** — `.catch` instead of silent.
- **`mutation.mutate()`** fire-and-forget rejection now warns (was silent `catch(() => {})`).

### Fixed — SSR

- **`runInSSRContext`** uses Node's `AsyncLocalStorage` when available so concurrent requests don't share `ssrMode`/suspense counters.
- **`serializeState`** byte cap via `TextEncoder`; escapes U+2028/9; drops the `__SIBU_SSR_STATE_RAW__` fallback (defeated escape).
- **`deserializeState`** dev-warns when no `validate` guard is passed.

### Fixed — Widgets & UI

- **`datePicker` month/year overflow** — uses day-1 anchor (no Jan-31→Mar-3 drift).
- **`form.wrappedSet`** clears `manualErrors` on edit (server-side "email taken" errors no longer stick after user edits).
- **`Tooltip.bind()` teardown** splices its id out of the current `aria-describedby` so ids added by other libraries survive.
- **`a11y.FocusTrap`** `keydown` removed on dispose; announce live region checks `isConnected` before writing.
- **`inputMask.bind()`** returns a dispose function that removes input/focus listeners.
- **`customElement._teardown`** runs `dispose()` on rendered subtree before reconnect (reactive bindings no longer leak across reconnects).

### Fixed — Plugins & Router

- **`router.cleanupNodes`** calls `dispose(node)` before detaching — every reactive binding inside a route subtree is torn down on navigation.
- **`Route()` / `KeepAliveRoute()` / `Outlet()`** `track()` teardowns stored in `routeCleanups` (was leaking effects).
- **`RouterLink` click listener** removed via `registerDisposer`; navigate failures `.catch`'d.
- **Router `pagehide` listener lazy-initialized** on first `createRouter()` call (honors `sideEffects: false`).

### Fixed — Security

- **`URL_ATTRIBUTES`** expanded: `xlink:href`, `formtarget`, `ping`, `data` now run through `sanitizeUrl()` (was bypassed).
- **`persist` + `dragDrop` `JSON.parse`** revivers block `__proto__`/`constructor`/`prototype` (CWE-1321).
- **`each` error dispatch** logs via `devWarn` when anchor is detached (no silent swallow).

### Fixed — Performance

- **Spring animation** is `dt`-aware (`REF_DT_MS`, `MAX_STEP_RATIO=4`, NaN-guard) — frame-rate-independent; no runaway on tab-throttle.
- **`speech.ts` setInterval** polls only while actively speaking (was constant 5Hz).
- **`socket` / `stream` auto-reconnect** — exponential backoff with jitter.

### Fixed — DX

- **Error prefix standardized to `[SibuJS]`** (was mix of `[Sibu]` / `[Sibu strict]` / `[Sibu hydration]`).
- **`devtools.hmr`** calls `disposeNode` on replaced subtrees so HMR reloads don't leak effects/listeners.
- **`testing.unmount` / `unmountAll`** call `dispose()` before clearing DOM (was `innerHTML = ""`, leaked every effect/binding).
- **`tsconfig.json`** drops `"types": ["vitest"]` — zero `src/` deps on test-only types.
- **Unused `biome-ignore` suppressions** removed; unused variables cleaned.

### Migration

Most apps need no changes. If you hit any of these:

- **`redux.useSelector` / `zustand.useSelector`** → rename to `select`.
- **`useDefaultPluginRegistry`** → rename to `setDefaultPluginRegistry`.
- **`loadRemoteModule(url)` without options** → pass `{ allowedOrigins: [...] }` (recommended) or `{ unsafelyAllowAnyOrigin: true }` for opt-in.
- **`loadWasmModule(url)`** → same.
- **`compiled.staticTemplate(html)`** → wrap via `trustHTML(html)` after your sanitization.
- **`hydrate()` consumers relying on preserved server DOM refs** → client tree replaces server tree; grab refs after mount.
- **`socket({ autoReconnect: true })`** → now caps at 10 reconnect attempts; pass `maxReconnects: Infinity` to restore prior behavior.
- **Router redirects to `//other-host/path`** → now throw; rewrite as relative or absolute `https://` within an allowed origin.
- **`optimisticList().addOptimistic/removeOptimistic/updateOptimistic`** → rename to `add`/`remove`/`update`.

---

## [1.5.0] — 2026-04-11

Comprehensive bug-fix and hardening release. **30 bugs fixed across 29 files**, covering the reactive core, data fetching, state management, routing, rendering, lifecycle, forms, UI utilities, browser composables, and devtools. Full framework audit with 2178/2178 tests passing, zero regressions.

### Breaking

- **`optimistic()` return shape changed** — previously returned a `[getter, setter]` tuple; now returns a named object `{ value, pending, update }`. The `pending` signal was created internally but never exposed (Bug: users had no way to show loading indicators). The `update` method now uses a version counter to prevent stale reverts from concurrent operations. Migration:
  ```ts
  // before
  const [value, addOptimistic] = optimistic(0);

  // after
  const { value, pending, update } = optimistic(0);
  ```

- **`optimisticList()` method names shortened** — `addOptimistic` → `add`, `removeOptimistic` → `remove`, `updateOptimistic` → `update`. The old names are kept as deprecated aliases so existing code keeps working.

### Fixed — Core Reactivity

- **`deepEqual` shared-reference false positive** — the `seen` set tracked only `a`, not `(a, b)` pairs. Shared sub-objects compared against different partners were incorrectly treated as equal. Now tracks `Map<object, Set<object>>` pairs.
- **`deepEqual` constructor mismatch** — `deepEqual(new Date(), {})` returned `true` because Date has no enumerable keys. Added constructor guard before falling through to key comparison.
- **`deepEqual` Map/Set not compared** — `Map` and `Set` contents were invisible to `Object.keys`. Added explicit Map (deep value equality) and Set (shallow membership) branches, plus ArrayBuffer and TypedArray support.
- **`deepEqual` self-referential Map/Set** — cycle detection was placed after the Map/Set branches, causing infinite recursion on self-referential containers. Moved cycle detection before all container comparisons.
- **`derived` circular dependency** — circular derived chains caused silent stack overflow. Added an `evaluating` re-entrance flag that throws a clear `"Circular dependency detected"` error with the signal's debug name.
- **`drainNotificationQueue` infinite loop** — an effect writing to a signal it reads could loop forever. Added a `MAX_DRAIN_ITERATIONS = 1000` cap with a console error diagnostic.
- **`deferredValue` never updated** — had no reactive subscription on the source getter (no `effect`/`track`). Rewrote to use `effect()` for source tracking, scheduling LOW-priority updates via the scheduler.

### Fixed — Data Fetching

- **`resource.abort()` left `loading()` stuck at `true`** — the `AbortError` catch returned without resetting the loading signal. Now calls `setLoading(false)` in the abort path.
- **`query` subscriber leak on same-key re-run** — effect re-runs with an unchanged key double-counted `entry.subscribers`, preventing cache GC. Now only increments when the key actually changed or the entry has zero subscribers.
- **`mutation` concurrent state clobbering** — rapid `mutate()` calls raced without guard. Added a `runId` version counter; stale responses are silently ignored.
- **`withRetry` abort listener leak** — the `abort` event listener on `AbortSignal` was never removed when the delay timer resolved normally. Added `removeEventListener` in the timer resolve path.

### Fixed — State Patterns

- **`optimistic` concurrent stale reverts** — each operation now gets a version number; reverts only fire if no newer operation has started. Prevents stale snapshots from overwriting fresher optimistic state.
- **`optimistic` `pending` never exposed** — the `pending` signal was created but never returned. Now exposed in the return object for both `optimistic` and `optimisticList`.
- **`optimisticList.updateOptimistic` predicate failure after patch** — the success-path predicate re-ran against the already-mutated item. If the patch changed the matched property, the server result was silently dropped. Now captures patched references during the optimistic phase and matches by identity in the success path.
- **`persisted` effect not stopped by `dispose()`** — the persisting effect's return value was discarded, so `dispose()` only removed the storage listener but left the effect running. Now captured and called in `dispose()`.
- **`globalStore` shallow initial copy** — `reset()` could fail to fully restore nested objects if they were mutated in-place. Changed to `JSON.parse(JSON.stringify(...))` for a deep copy of initial state.

### Fixed — Routing

- **Wildcard route too permissive** — `/admin/*` incorrectly matched `/admin-panel` because the check used `path.startsWith(basePath)` without a segment boundary. Now requires `path === basePath || path.startsWith(basePath + "/")`.
- **Guard timeout/abort listener leak** — when `next()` was called asynchronously, the microtask-based cleanup had already run and missed it. Moved `clearTimeout` + `removeEventListener` into the `next()` callback itself. The abort handler now also clears the timeout timer.

### Fixed — Rendering & Lifecycle

- **`dispose()` one throwing disposer aborted entire subtree cleanup** — wrapped each disposer call in try/catch with a dev-mode warning.
- **`onMount` cleanup return discarded** — the type signature accepted a cleanup return function but `safeCall` discarded it. Now captured and registered via `registerDisposer(element, cleanup)`.
- **`onMount` MutationObserver leaked** — if an element was disposed before ever connecting to the DOM, the observer on `document.body` ran forever. Now registered for cleanup via `registerDisposer`.
- **`onUnmount` observer ran for element's entire lifetime** — the MutationObserver on `document.body` fired on every DOM mutation globally. Now registered for cleanup via `registerDisposer` and the callback itself is also wired through `registerDisposer` as the primary teardown path.
- **`Portal` cleanup via MutationObserver only** — didn't integrate with `dispose()`/`when()`/`match()`/`each()`. Replaced with `registerDisposer(anchor, ...)` so portal content is properly disposed and removed through the standard dispose system.
- **`lazy` stale load** — if the container was removed before the dynamic import resolved, the rendered component leaked subscriptions. Added a `disposed` guard that silently drops stale `.then()`/`.catch()` callbacks. Removed dead `_status`/`_error` signals that were created but never read.

### Fixed — UI Utilities

- **`bindField` merge order** — `{...fieldOn, ...extraOn}` let extras clobber field handlers (input/change/blur). Contradicted the 1.0.4 fix intent. Flipped to `{...extraOn, ...fieldOn}` so field handlers always win.
- **`form.handleSubmit` double-submit** — no guard against concurrent async submissions. Added a `submitting` signal; `handleSubmit` checks it before calling the callback and resets on resolve/reject. Exposed as `form.submitting()` on `FormReturn`.
- **`inputMask` cursor jump** — no cursor position restoration after mask application; cursor jumped to end on every keystroke. Added cursor tracking that counts raw chars before the old cursor position and places the cursor after that many filled slots in the masked output.
- **`inputMask` strip regex too aggressive** — `/[^a-zA-Z0-9]/g` stripped all special characters, making `*` mask slots unable to accept non-alphanumeric input. Now builds a pattern-aware strip regex: patterns with `*` only strip literal mask characters.
- **`transition` rapid enter/leave** — stale `setTimeout` callbacks from a previous enter/leave fired during the opposite animation, corrupting class state. Added `activeTimer` tracking with `cancelPending()` at the start of each enter/leave.
- **`scopedStyle` pseudo-element scoping** — scope attribute was appended after `::before`/`::after` pseudo-elements, producing invalid CSS selectors. Now splits at `::` and inserts `[attr]` before the pseudo-element.
- **`VirtualList` scroll listener leak** — the scroll event listener was never cleaned up. Added `registerDisposer` with `removeEventListener`.
- **`dialog` no dispose** — the global keydown listener leaked if the dialog was open when the component was destroyed. Added `dispose()` method that detaches the listener and resets state.
- **`FocusTrap` observer scope** — MutationObserver watched only the direct parent; ancestor removal leaked the observer and missed focus restore. Changed to `document.body` with `subtree: true`. Added `registerDisposer` integration for SPA cleanup. Zero-focusable-elements case now calls `e.preventDefault()` to prevent Tab from escaping the trap.

### Fixed — Browser Composables

- **`urlState` missing `hashchange` listener** — anchor clicks and `location.hash` assignments don't fire `popstate`, so `hash()` went stale. Added `hashchange` listener alongside `popstate`. Added deduplication guard to avoid unnecessary signal notifications. `setHash("#")` now clears the hash instead of keeping a bare `#`.
- **`scroll` non-reactive target** — the scroll target element was resolved once at creation and never re-evaluated. Rewrote to use `effect()` for reactive target tracking, re-attaching the listener when the element changes (same pattern as `resize`/`dragDrop`).
- **`socket.close()` auto-reconnected** — the `onclose` handler couldn't distinguish manual close from unexpected disconnect. Added a `manuallyClosed` flag set in `close()` and checked in `onclose` to suppress auto-reconnect.

### Fixed — DevTools

- **`createTraceProfiler` subscribed to non-existent events** — listened for `effect:start`/`effect:end`/`signal:set` but the core emits `effect:create`/`effect:destroy`/`signal:update`. Fixed event names and changed to instant (`"I"`) events since the core doesn't emit begin/end pairs.

### Changed

- **`optimistic()` returns a named object** — `{ value, pending, update }` instead of `[getter, setter]`. See Breaking section.
- **`optimisticList()` shorter method names** — `add`/`remove`/`update` with deprecated `addOptimistic`/`removeOptimistic`/`updateOptimistic` aliases.
- **`deepSignal` return type** — now infers from `signal()` directly, preserving the `Accessor<T>` brand on the getter.
- **`hotkey` `global` option removed** — was declared but never used (dead code).
- **`context` JSDoc updated** — accurately describes global reactive store semantics instead of falsely promising subtree-scoped DI.
- **JSDoc examples across 17 source files** — ~35 code examples converted from legacy `{ nodes: }` form to canonical positional shorthand.
- **README** — updated to canonical shorthand authoring style; `$(pattern matching)$` typo fixed.

### Tests

- **`deepSignal.test.ts`** — expanded from 4 → 52 tests covering Map, Set, TypedArray, shared refs, cycles, constructor mismatch.
- **`urlState.test.ts`** — expanded from 6 → 20 tests covering hashchange, dedup, edge cases, SSR.
- **`optimistic.test.ts`** — expanded from 5 → 17 tests covering pending, concurrent guards, predicate-after-mutation.
- Full suite: **2178 / 2178 passing** (up from 2105 in 1.4.0). Zero regressions.

---

## [1.4.0] — 2026-04-11

Cleanup release. Removes six public aliases that contradicted the SibuJS philosophy — plain verbs, no framework ceremony, no redundant synonyms for the same primitive. All of the removed APIs were either one-line forwards to an existing primitive or identity wrappers; every existing example can be rewritten by deleting the wrapper and calling the underlying primitive directly.

### Removed

- **`createSignal`** — was `return signal(value)`. Use `signal()` directly.
- **`createMemo`** — was `return derived(fn)`. Use `derived()` directly.
- **`createEffect`** — was `return effect(fn)`. Use `effect()` directly.
- **`memo`** — was `return derived(factory)`. Use `derived()` directly.
- **`memoFn`** — was `return derived(callback)`. Use `derived()` directly.
- **`composable`** — was `return setup` (identity function). Plain functions are already composables in SibuJS; just write one and call it.

The three removed files (`src/patterns/primitives.ts`, `src/core/signals/memo.ts`, `src/core/signals/memoFn.ts`) are currently empty stubs exporting nothing — they can be deleted from disk in a follow-up commit without further code changes.

### Migration

```ts
// before
import { createSignal, createMemo, createEffect, memo, memoFn, composable } from "sibujs";

const [count, setCount] = createSignal(0);
const doubled = createMemo(() => count() * 2);
const sorted = memo(() => items().slice().sort());
const handler = memoFn(() => (e: Event) => process(e));
createEffect(() => console.log(count()));
const useCounter = composable(() => { /* … */ });

// after
import { signal, derived, effect } from "sibujs";

const [count, setCount] = signal(0);
const doubled = derived(() => count() * 2);
const sorted = derived(() => items().slice().sort());
const handler = derived(() => (e: Event) => process(e));
effect(() => console.log(count()));
function useCounter() { /* … */ }
```

### Also updated

- `generateComponentMetadata`, `generateTypeStubs`, and the Vite/Webpack pure-annotation factory list in `sibujs/build` no longer mention the removed names.
- Lint rule `no-signals-in-conditionals` no longer checks `memo` / `memoFn` (they don't exist).
- `SignalNodeSnapshot.kind` comment updated to drop the `"memo"` tag.
- Test suite: `tests/primitives.test.ts`, `tests/memo.test.ts`, `tests/memoFn.test.ts` reduced to placeholder stubs; `tests/types.test.ts` and `tests/ide.test.ts` updated to assert the aliases are gone. Suite: **2105/2105 passing** (down from 2113 by exactly the 8 deleted alias-specific tests).

---

## [1.3.0] — 2026-04-11

Large minor release. Adds **27 new reactive/DOM primitives**, a full **SSR + OWASP security hardening pass** (A01, A02, A03, A10 + CWE-1321 prototype pollution), **10 ergonomic features** that stay inside the SibuJS philosophy (No VDOM, No JSX, No compilation, Zero dependencies, fine-grained reactivity), **typed tag factory overloads** for common elements, and a new **`tag(props, children)` positional shorthand** that removes the need for the `nodes:` key at every level of the tree. Test suite grew from **1875 → 2113** passing tests (+238, **0 regressions**).

### Added

#### Browser composables (`sibujs/browser`) — 20 new primitives

- **`visibility()`** — Page Visibility API wrapper. Pause polling / animations while the tab is hidden.
- **`network()`** — Network Information API reactive getters (`effectiveType`, `downlink`, `rtt`, `saveData`). Adapt image quality and prefetching to the real connection, not just online/offline.
- **`mouse({ target?, touch? })`** — reactive pointer position with optional touch unification.
- **`swipe(target, { threshold?, onSwipe? })`** — touch swipe detection with configurable threshold and direction callback.
- **`windowSize()`** — reactive viewport dimensions via the `resize` event (complements the element-scoped `resize()`).
- **`urlState()`** — reactive URL search params + hash with `setParams` / `setHash` backed by `history.pushState`/`replaceState` and `popstate` sync. Independent of `createRouter()`.
- **`broadcast(channelName)`** — BroadcastChannel wrapper exposing a reactive `last` signal and a `post(message)` sender.
- **`fullscreen()`** — Fullscreen API with reactive `isFullscreen` / `element` plus `enter` / `exit` / `toggle`.
- **`wakeLock()`** — Screen Wake Lock API with auto re-acquire on `visibilitychange`.
- **`animationFrame({ fpsLimit?, immediate? })`** — reactive `delta` / `elapsed` driven by `requestAnimationFrame`, with `pause` / `resume` / `dispose` and optional FPS limit.
- **`mutationObserver(target, options)`** — reactive DOM MutationObserver wrapper. Escape hatch for reacting to DOM changes outside the reactive system.
- **`bounds(target)`** — reactive `getBoundingClientRect()`. Updates on resize (ResizeObserver) AND on window scroll (capture-phase passive listener), so absolute top/left stay accurate for overlays.
- **`keyboard({ target?, keys? })`** — reactive set of currently-pressed keys with optional filter. Clears on `window.blur` to avoid stuck modifiers.
- **`speech()`** — Web Speech Synthesis wrapper with reactive `speaking` / `paused` and `speak(text, options)` supporting rate / pitch / volume / voice / lang.
- **`gamepad()`** — Gamepad API as reactive snapshots. Auto-polls via `requestAnimationFrame` only when at least one pad is connected, and emits updates only when button or axis state actually changes (deep equality short-circuit).
- **`pointerLock()`** — Pointer Lock API with reactive `locked` signal and `request(el)` / `exit()`.
- **`vibrate(pattern)`** — thin Vibration API wrapper; returns `false` on unsupported platforms.
- **`favicon(url)` / `svgFavicon(svg)`** — runtime favicon updater. Creates the `<link rel="icon">` if missing; `svgFavicon` encodes inline SVG to a data URI for notification-count badges.
- **`textSelection()`** — reactive text-selection tracker (`text`, `rect`, `hasSelection`, `clear`) for building selection toolbars and citation tools. Syncs via `selectionchange` (mouse drag, Shift+arrow, touch select).
- **`imageLoader(src)`** — reactive image-load status (`"pending"` | `"loaded"` | `"error"`) plus intrinsic `width` / `height`. Prevents CLS in lazy galleries. Gracefully aborts in-flight loads on `dispose()`.

#### Reactivity / core primitives

- **`defer(getter)`** — deferred mirror of a reactive getter. Converges to the source on a microtask + `requestAnimationFrame` so expensive derived views lag behind fast input.
- **`transition()`** — `{ pending, start }` handle that schedules work on `requestIdleCallback` (with rAF / setTimeout fallback). `pending()` stays reactive for both sync and async bodies; exceptions reset the state cleanly.
- **`nextTick()`** — await for DOM flush. Resolves on microtask + rAF so imperative code can read post-render state.
- **`asyncDerived(factory, initial)`** — async counterpart of `derived()`. Reactive `value` / `loading` / `error` triple with stale-response cancellation and a `refresh()` trigger.
- **`createId(prefix?)`** — stable unique id generator for a11y pairing (`aria-labelledby`, `for` + `id`). Exports `__resetIdCounter()` for deterministic tests and SSR.
- **`strict(fn)` / `strictEffect(fn)`** — dev-only double-invocation helpers that surface cleanup bugs (missing disposers, duplicate listeners). No-op in production.
- **`escapeScriptJson(json)`** — exported helper used internally by `serializeState` / `serializeRouteState` / `setStructuredData`. Escapes `<`, `>`, `&`, `U+2028`, `U+2029`.

#### UI helpers (`sibujs/ui`)

- **`interval(fn, ms)`** — declarative `setInterval` handle with `stop` / `pause` / `resume` / `isRunning`.
- **`timeout(fn, ms)`** — declarative `setTimeout` handle with `cancel` / `isPending`.
- **`hover(target)`** — reactive hover tracker using `pointerenter` / `pointerleave` (touch-friendly).
- **`scrollLock()`** — stacked body scroll lock that compensates for scrollbar width. Multiple concurrent overlays each own a handle; only the last `unlock()` restores the original styles.
- **`formAction(fn)`** — async form-action wrapper: reactive `pending` / `error` / `result` / `reset` / `onSubmit`. `onSubmit` is a ready-to-attach `<form>` handler that builds a `FormData` and invokes the action. Stale-response guard drops older in-flight calls on re-submit.
- **`createFocusManager(container, options?)`** — headless focus walker (`focusFirst` / `focusLast` / `focusNext` / `focusPrev`) with optional loop wrap-around.
- **`createListbox(container, options?)`** — full ARIA listbox wiring: `role="listbox"`, `aria-activedescendant`, Arrow / Home / End / Enter / Space keyboard navigation, click-to-select, multi-select. Stamps stable ids on every option via `createId()`.
- **`createDialogAria(element, options?)`** — returns stable `titleId` / `descriptionId`, sets `role="dialog"` (or `"alertdialog"`), `aria-modal`, `aria-labelledby` / `aria-describedby`, `tabindex="-1"`. Intentionally decoupled from focus trap and Escape-to-close.

#### Router

- **`LazyRoute` shorthand** — `{ path: "/page", lazy: () => import("./Page") }` is now accepted as a route definition. `createRouter()` and `setRoutes()` normalize the route tree recursively, so nested children get the shorthand too.

#### Hydration + SSR

- **`hydrate(component, container, { diagnostics, onMismatch })`** — dev-mode tree walker that reports the first tag / attribute / child-count / missing-child mismatch. Internal markers (`data-sibu-ssr`, `data-sibu-hydrated`, `data-sibu-island`) are excluded. Stops after five findings to prevent log spam on a broken tree.
- **`HydrateOptions`** and **`HydrationMismatch`** types exported from `sibujs/ssr`.
- **`renderToSuspenseStream(element, pending, { nonce? })`** — new `nonce` option propagated to the swap scripts for strict-CSP compatibility.
- **`serializeState(state, nonce?)`** / **`serializeRouteState(state, nonce?)`** — optional `nonce` argument for strict-CSP.

#### Components

- **`ErrorDisplay(props)`** — shared rich error UI with copy-to-clipboard (full message + stack + cause + metadata + env), colored severity header (`error` / `warning` / `info`), colored error-code badge (from `error.code` or `error.name`), parsed stack frames (Chrome/V8 + Firefox/Safari formats), `Error.cause` chain walked recursively, metadata + environment sections (URL, UA, ISO timestamp), optional retry + reload buttons. Dev/prod split — stack and metadata hidden in prod unless `alwaysShowDetails: true`.
- **`ErrorBoundary`** — new `resetKeys: Array<() => unknown>` prop. When any listed reactive getter changes after an error has been caught, the boundary auto-resets and re-renders the subtree.

#### Devtools

- **`captureSignalGraph()`** — synchronous snapshot of every observed signal node (id, kind, value preview, subscribers, dependencies, eval count). Empty snapshot when devtools are not enabled so tests and production code can call it unconditionally.
- **`diffSignalGraphs(before, after)`** — classifies nodes into `added` / `removed` / `reevaluated`. Useful for regression assertions like "navigating to /page X must not add more than N new signals".
- **`createTraceProfiler()`** — subscribes to `effect:start` / `effect:end` / `signal:set` events and emits a Chrome tracing JSON blob via `stopTrace()`. Drop the output into `chrome://tracing` or `ui.perfetto.dev` for a flamegraph. Distinct from the existing `createProfiler()` in `componentProfiler.ts`, which tracks per-component render counts.

#### Testing (`sibujs/testing`)

- **`queryByText` / `queryByTestId` / `queryByRole` / `queryByLabel`** — non-throwing finders.
- **`findByText` / `findByTestId` / `findByRole`** — async finders that poll until `timeout`.
- **`waitForSignal(getter, predicate, { timeout })`** — signal-aware wait. Subscribes to the getter and resolves immediately when the predicate matches, instead of polling.
- **`type(element, text)`** — dispatches one `InputEvent` per character + a final `change` event for realistic keyboard simulation.

#### Tag factory ergonomics

- **`tag(props, children)` positional shorthand** — every tag factory now accepts the children as an optional second argument. This removes the last reason to write `nodes:` in nested trees:

  ```ts
  div({ class: "page" }, [
    h1({ class: "title" }, "Welcome"),
    div({ class: "row" }, [
      label({ for: "email" }, "Email"),
      input({ id: "email", type: "email" }),
      button({ class: "primary", type: "submit" }, "Submit"),
    ]),
  ])
  ```

  All legacy forms (`tag({...props})`, `tag("className", children)`, `tag("text")`, `tag([...])`, `tag(node)`, `tag(() => child)`) continue to work unchanged. When both `props.nodes` and the positional second-arg are present, the positional wins.
- **Per-element typed prop overloads** — `a`, `input`, `img`, `button`, `form`, `select`, `textarea`, `label`, `option`, `video`, `audio` now have element-specific prop interfaces (`AnchorProps`, `InputProps`, `ButtonProps`, `FormProps`, `SelectProps`, `TextareaProps`, `LabelProps`, `OptionProps`, `ImgProps`, `VideoProps`, `AudioProps`, `MediaProps`, `InputType`) with full IDE autocomplete and typo detection. Runtime unchanged; the stronger typing is a zero-cost `TypedTagFunction<Props, El>` cast inside `html.ts`. The `[attr: string]: unknown` escape hatch is preserved for custom attributes.
- **`TypedTagFunction<Props, El>`** type exported for building custom typed factories.

#### Persistence

- **`persisted(key, initial, options)`** — new `syncTabs` option (default `true` for localStorage). Listens to the `storage` event so changes in one tab propagate to others. Reentry-guarded against bounce-back. `null` newValue from another tab resets to `initial`.
- The returned setter now carries a non-enumerable **`dispose()`** method that removes the cross-tab listener — previously there was no way to clean it up.

### Changed

- **Tag factory dispatch rewritten** — strings / numbers / arrays / nodes / functions each own an explicit branch, and the props-object path resolves children as `second ?? props.nodes`. Unblocks the `tag(props, children)` shorthand at every level of the tree. No hot-path regression — the fast paths for `tag()`, `tag("text")`, and `tag([...])` still short-circuit.
- **`ErrorBoundary`**'s default fallback is now rendered by `ErrorDisplay`. The legacy inline renderer and its local stack parser were removed. Any `ErrorBoundary` without a custom `fallback` prop gets the richer UI automatically.
- **`withSSR(fn)` is nesting-safe** — saves the prior SSR flag into `wasSSR` and only calls `disableSSR()` on exit when the outer scope was not already in SSR mode. A nested `withSSR(...)` call that throws no longer flips the outer scope's SSR flag back to `false`.
- **`routerSSR.renderRouteToDocument`** delegates meta/link/bodyAttrs validation to the shared hardened helper from `platform/ssr.ts` — the hand-rolled duplicate escaping functions are removed.
- **`tsconfig.json`** adds `"lib": ["ES2022", "DOM", "DOM.Iterable"]` so `Object.hasOwn` resolves while keeping `target: ES2020`.

### Fixed

- **`ErrorBoundary` `resetKeys` edge-cases** — a key-getter that throws is treated as a valid reactive dependency and does not crash the effect.
- **`bindAttribute`** refuses `on*` event-handler attribute bindings with a dev-mode warning that suggests the safe `on: { click: fn }` prop instead. Previously, `bindAttribute(el, "onclick", () => "alert(1)")` would call `setAttribute("onclick", ...)` and turn the string into inline JS.
- **`machine(...)` context merge** — replaced `{ ...ctx, ...patch }` with a filtered loop that drops `__proto__` / `constructor` / `prototype` keys. Prevents prototype pollution from action-returned patches parsed out of JSON.
- **`scopedStyle()`** — CSS sanitizer now decodes CSS hex escapes (`\75 rl(` → `url(`) before the dangerous-pattern scan, closing the obfuscation bypass for `url()` / `expression()` / `@import` / `-moz-binding` / `behavior`.
- **`persisted()`** — the cross-tab `storage` listener can now be cleaned up via a non-enumerable `dispose()` method on the returned setter.
- **`routerSSR.parseURL`** — wraps `decodeURIComponent` in a try/catch so malformed percent-sequences no longer crash SSR (DoS vector). `params` and `query` now use `Object.create(null)` and filter forbidden keys.

### Security

A complete OWASP audit beyond the top 10 was performed, with three review passes and 74 dedicated security tests.

**A01 Broken Access Control**

- **Router `navigate()`** — refuses `javascript:`, `data:`, `vbscript:`, and `blob:` URIs at **every** entry: the top-level `navigate()` call, `beforeEach` guard redirects, `beforeEnter` guard redirects, `route.redirect`, and `beforeResolve` guard redirects. Previously these could land in `history.state` and be reflected into anchor hrefs.

**A02 Cryptographic Failures**

- **`persisted()`** JSDoc no longer references a "simple XOR cipher for illustration" — the example now clearly states that XOR and `btoa()` / `atob()` are NOT encryption and points to AES-GCM via the Web Crypto API.
- **`persisted()`** cross-tab listener now cleanable (see Fixed).

**A03 Injection (XSS / prototype pollution / CSS injection)**

- **`renderToString` / `renderToStream`** — attribute names validated against `^[A-Za-z_:][-A-Za-z0-9_.:]*$`; `on*` event-handler attributes dropped; URL-bearing attributes (`href`, `src`, `action`, `formaction`, `cite`, `poster`, `background`, `srcset`, `ping`, `manifest`, `data`, `xlink:href`) routed through `sanitizeUrl`; attribute values escaped against both `"` and `'`; `<script>` and `<style>` elements stripped from the serialized output; comment-terminator forms (`-->`, `--!>`, `<!--`, trailing `--`) escaped inside comment bodies.
- **`renderToDocument`** — meta / link / bodyAttrs attribute names validated via `buildAttrString`; `on*` keys dropped; URL attributes pass through `sanitizeUrl`; `<meta http-equiv="refresh" content="0;url=javascript:…">` detected and refused via `isDangerousMetaRefresh`; the page `title` is HTML-escaped; script `src` entries go through `sanitizeUrl`.
- **`serializeState` / `serializeRouteState` / `setStructuredData`** — JSON payloads escaped against `<`, `>`, `&`, `U+2028`, `U+2029` so nothing inside a string literal can close the `<script>` tag or break out of JS string context on pre-ES2019 engines.
- **`suspenseSwapScript(id)`** — ids validated against `^[A-Za-z0-9_-]+$` and rejected otherwise. Previously a crafted id could inject context-breakers into the CSS selector or the JS string literal.
- **`bindAttribute`** — refuses `on*` event handlers (defense-in-depth — the tag factory already filters them, but `bindAttribute` is exported and could be called directly).
- **`machine(...)`** — filtered prototype-pollution keys from action-returned context patches.
- **`scopedStyle`** — CSS escape-sequence obfuscation bypass fixed (see Fixed).

**A10 Server-Side Request Forgery (client-side analogue)**

- **`socket()`** — `validateWsUrl()` restricts WebSocket URLs to `ws://` / `wss://` and strips control characters that would bypass a naïve `startsWith` check.
- **`stream()`** — `validateSseUrl()` routes EventSource URLs through `sanitizeUrl()` to block `javascript:` / `data:` / `blob:`.

**CWE-1321 Prototype pollution**

- **`routerSSR.parseURL`** — `params` and `query` created with `Object.create(null)`; `__proto__` / `constructor` / `prototype` filtered from both query-string parsing and pattern-captured route params.
- **`hydrateIslands` / `hydrateProgressively`** — island lookups go through `Object.hasOwn` instead of direct indexing. A `data-sibu-island="__proto__"` marker cannot resolve to `Object.prototype`.

**Head tag hardening**

- **`Head`** — meta / link / script attribute names validated; `on*` keys rejected; `base.href` routed through `sanitizeUrl` (an attacker-controlled base href could otherwise rewrite every relative URL on the page into a `javascript:` URI); `setStructuredData` escapes JSON via the shared `escapeScriptJson`; `<meta http-equiv="refresh">` with a dangerous URL dropped entirely.

### Testing

- **+238 tests, 0 regressions**. Full suite: **2113 / 2113 passing** (baseline was 1875).
- 74 dedicated security tests across `ssr-security.test.ts` (38), `head-security.test.ts` (11), `ssr-context.test.ts` (4), and `owasp-security.test.ts` (21).
- 10 new feature-test files covering concurrent primitives, `formAction`, `strict`, `ErrorBoundary resetKeys`, router `lazy` shorthand, hydration diagnostics, a11y primitives, testing queries, `ErrorDisplay`, and the devtools signal graph.
- New `shorthand-nested.test.ts` (10 tests) locks in the `tag(props, children)` dispatch including deep nesting, string/array/node/function second-args, positional-override-of-`nodes`, and legacy form compatibility.

---

## [1.2.0] — 2026-04-09

### Added

- **Inline lint disable comments** — The `no-direct-dom-mutation` rule (in both the build-system linter and `sibujs lint` CLI) now supports two inline disable forms:
  - `// sibujs-disable-next-line no-direct-dom-mutation` on the line above
  - `// sibujs-disable no-direct-dom-mutation` on the same line

### Fixed

- **Cached element DOM corruption in reactive `nodes`** — `bindChildNode` used a naive "remove all, insert all" strategy with no identity tracking. Returning the same `HTMLElement` instance from a reactive function across re-evaluations could cause duplicates or disappearing elements. The reconciler now builds a reuse set, skips removal of reused nodes, and computes the insertion anchor after cleanup to prevent stale references.
- **Boolean `false` silently ignored in tag factory attributes** — Passing `false` for an attribute (e.g., `textarea({ spellcheck: false })`) was silently skipped instead of removing the attribute. Boolean handling now matches the reactive `bindAttribute` behavior: `true` sets an empty attribute, `false` calls `removeAttribute()`, and IDL properties (`checked`, `disabled`, `selected`) are set as DOM properties directly.

---

## [1.1.0] — 2026-04-06

### Added

- **`Accessor<T>` brand type** — All reactive getters returned by `signal()`, `derived()`, `memo()`, `memoFn()`, `writable()`, `array()`, and `reactiveArray()` are now typed as `Accessor<T>` instead of the plain `() => T`. The brand is purely a compile-time phantom (zero runtime cost) and makes signal getters clearly distinguishable from regular functions in IDE hover tooltips and type signatures. `NodeChildren` and `NodeChild` have been updated to explicitly list `Accessor<NodeChild>` alongside the plain arrow-function form.

### Fixed

- **`isDev()` unsafe default** — The fallback when neither `globalThis.__SIBU_DEV__` nor the compile-time `__SIBU_DEV__` constant is set now evaluates `process.env.NODE_ENV !== "production"` instead of hard-coding `true`. In a browser environment without a Vite build (where `process` is undefined), this resolves to `false`, preventing DevTools from being silently active in production.
- **Prototype pollution in `globalStore`** — The `dispatch()` function now strips `__proto__`, `constructor`, and `prototype` keys from the action patch before spreading it into state. Previously a malicious or malformed action could pollute `Object.prototype` via `{ "__proto__": { isAdmin: true } }`.
- **`workerFn` / `worker()` CSP documentation** — Added a prominent JSDoc warning documenting that the inline worker pattern serializes functions via `.toString()` into a `blob:` URL (equivalent to `eval()`), is incompatible with strict `worker-src 'self'` CSP directives, and must never receive user-controlled or dynamically constructed function arguments.

---

## [1.0.9] — 2026-04-03

### Fixed

- **`when()` condition type widened to generic `T`** — The runtime already uses `===` identity comparison to decide re-renders, supporting non-boolean values (e.g. string IDs, object references). The TypeScript signature now reflects this: `when<T>(condition: () => T, ...)` instead of `when(condition: () => boolean, ...)`. Removes the need for `as unknown as () => boolean` casts.

### Changed

- **Enforce LF line endings** — Added `.gitattributes` with `* text=auto eol=lf` to prevent CRLF formatting drift on Windows.

---

## [1.0.8] — 2026-04-03

### Changed

- **`each()` render callback receives reactive getters** (**BREAKING**) — The render function signature changed from `(item: T, index: number)` to `(item: () => T, index: () => number)`. When a keyed item's data changes but its key stays the same, the DOM is reused without re-calling render — so the old plain-value parameter was a stale snapshot. The new getters are backed by a `keyIndexMap` updated on every reconciliation pass, ensuring they always return fresh data from the current array. **Migration:** add `()` after the item/index parameter wherever it is accessed inside the render callback.

### Added

- **`hotkey()` string combo syntax** — Supports `hotkey("ctrl+shift+z", handler)` in addition to the existing explicit-flags style. Recognized modifiers: `ctrl`/`control`, `shift`, `alt`, `meta`/`cmd`/`command`.
- **`hotkey()` `preventDefault` option** — `hotkey("ctrl+s", handler, { preventDefault: true })` calls `e.preventDefault()` automatically before invoking the handler.

---

## [1.0.7] — 2026-04-01

### Added

- **Nested Route Protection** — `beforeEnter` guards now evaluate for every segment in the matched route chain. Previously, only the leaf route's guard was checked. This ensures that parent layout protection (e.g., `/dashboard`) is respected regardless of which nested child is accessed.
- **Direct Access Protection** — The router now executes guard checks on initial page load and `popstate` events. Navigating directly to a protected URL will now trigger redirects before the component renders.

### Improved

- **Documentation Overhaul** — The `README.md` has been streamlined and now points to the official [sibujs.dev](https://sibujs.dev/) website.
- **Authoring Guide** — Added a clear comparison of the three supported component authoring styles (Tag Factory, Shorthand, and HTML Templates).

---

## [1.0.6] — 2026-03-29

### Fixed

- **`RouterLink` preserves user `class` prop** — The `class` prop was being discarded because the reactive effect overwrote `className` with only the active/exact classes. Now the base class is captured from props and always prepended, so user classes persist and active classes are appended on top. When inactive, the element retains its original class instead of becoming an empty string.

---

## [1.0.4] — 2026-03-28

### Added

- **`bindField()` helper** (`sibujs/ui`) — One-liner to wire a `FormField` to any input, select, or checkbox. Handles `value`, `input`, `change`, and `blur` events automatically. Accepts extra props (placeholder, class, etc.) as a second argument.
- **Toast severity shortcuts** — `toast()` now returns `.info()`, `.success()`, `.error()`, and `.warning()` convenience methods alongside the existing `.show()`.
- **`KeepAliveRoute()` component** (`sibujs/plugins`) — Route outlet that caches rendered components using LRU eviction, preserving signals, form state, and scroll position across navigations. Configurable via `RouterOptions.keepAlive` (boolean, string[], or number) or per-outlet options.
- **`RouterOptions.keepAlive`** — New router option to enable route-level KeepAlive caching. Accepts `true` (cache all), a string array of route names, or a number (max cache size).
- **`copyOnClick` action** — Copies element text (or custom getter value) to clipboard on click. Usage: `action(el, copyOnClick)`.
- **`autoResize` action** — Auto-grows a textarea to fit its content on input. Usage: `action(el, autoResize)`.

### Changed

- **`show()` accepts `Element`** — Signature widened from `show(condition, element: HTMLElement): HTMLElement` to `show<T extends Element>(condition, element: T): T`. Eliminates the `as HTMLElement` cast required on every call since tag factories return `Element`.
- **`contentEditable` uses modern Selection/Range API** — Replaced deprecated `document.execCommand()` with `range.surroundContents()` for bold/italic/underline. Supports toggle (unwrap) when already formatted. The `execCommand` method has been removed from the public API.
- **`renderToDocument()` `headExtra` requires `TrustedHTML`** — Now accepts a branded `TrustedHTML` type instead of plain `string`. Use `trustHTML()` to wrap developer-controlled HTML. Prevents accidental injection of unsanitized user input at compile time. Same change applied to `routerSSR`.

### Security

- **`scopedStyle()` CSS sanitization** — Strips `url()`, `@import`, `expression()`, `-moz-binding`, and `behavior` from CSS before injection. Prevents data exfiltration via attribute selectors and network requests.
- **`persisted()` encryption docs** — Removed misleading `btoa()`/`atob()` example (Base64 is encoding, not encryption). Updated guidance to recommend `crypto.subtle` / AES-GCM.
- **`TrustedHTML` branded type** — New `TrustedHTML` type and `trustHTML()` factory exported from `sibujs/ssr`. Enforces type-level safety for raw HTML injection points.

### Fixed

- **`bindField()` extras no longer clobber event handlers** — Passing `{ on: { click: handler } }` as extras now merges with the field's `input`/`change`/`blur` handlers instead of replacing them. Extras `value` is also ignored to prevent overriding the field getter.
- **`KeepAliveRoute` memory leak** — Evicted nodes are now properly `dispose()`d. Non-cached routes are disposed when navigating away. Cleanup function disposes all cached nodes.
- **`contentEditable` selection restore** — After unwrap, selection now targets the actual unwrapped content range instead of the parent container. After wrap, selection targets the wrapper's contents instead of `document.body`.
- **`sanitizeCSS` `url()` bypass** — Regex now handles quoted strings (`url("...")`, `url('...')`) as opaque tokens, preventing bypass via closing paren inside quotes.

---

## [1.0.3] — 2026-03-28

### Added

- **Wider `NodeChild` / `NodeChildren` types** — `NodeChild` now accepts `boolean`; `NodeChildren` accepts nested arrays and full reactive functions. Conditional patterns like `condition && element` work without `as any` casts. Boolean values are filtered out in `appendChildren`, `bindChildNode`, `Fragment()`, `htm.ts`, and `resolveChild`.
- **`onCleanup()` lifecycle hook** — `onCleanup(callback, element)` registers teardown logic (closing sockets, clearing timers, removing listeners) tied to an element's disposal. Integrates with the existing `dispose()` system so cleanup runs automatically when `when()`, `match()`, or `each()` swap content.
- **`query()` `select` option** — Optional `select` function that transforms cached data before returning it to consumers. Raw response stays in cache; `select` runs on read, enabling derived views without extra signals.
- **`formatNumber()` and `formatCurrency()`** — `Intl`-based formatting utilities exported from `sibujs/browser`. `formatNumber` wraps `Intl.NumberFormat`; `formatCurrency` is a convenience shorthand that sets `style: "currency"`.

### Fixed

- **Boolean values no longer render as text** — `false`, `true` are filtered in all rendering paths (`tagFactory`, `bindChildNode`, `Fragment`, `htm.ts`, `resolveChild`) preventing visible `"false"` text nodes.
- **Lint fixes** — Resolved unused variable in `router.basic.test.ts` and formatting issues flagged by Biome.

---

## [1.0.2] — 2026-03-27

### Fixed

- **`clearQueryCache()` now resets active queries** — Active subscribers get their signals reset (`data`, `error`, `isFetching`) and automatically refetch, instead of silently going stale.
- **`query()` cache entry recovery** — `doFetch()` recreates the cache entry if it was evicted mid-flight, preventing silent fetch failures.
- **`onCacheUpdate` handles missing entries** — Gracefully resets signals when a cache entry is cleared instead of bailing out silently.
- **`setData` propagates `undefined`** — `onCacheUpdate` now correctly syncs `undefined` data from cleared cache entries instead of skipping the update.

### Added

- **CI workflow** (`ci.yml`, `on: [pull_request]`) — GitHub Actions pipeline on pull requests: lint, test, and build (Node 20).

---

## [1.0.1] — 2026-03-27

### Security

- **DevTools disabled by default in production** — `initDevTools()` now defaults to `enabled: isDev()`. Production builds get a no-op API unless explicitly opted in, preventing signal/state exposure via `window.__SIBU_DEVTOOLS__`.
- **SSR error comments no longer leak internals** — Production renders `<!--SSR error-->` without the error message. Dev mode retains full details for debugging.
- **ErrorBoundary hides error details in production** — Default fallback shows a generic message instead of `err.message`, preventing exposure of file paths, DB strings, or stack traces.
- **CSP nonce support for SSR inline scripts** — `suspenseSwapScript(id, nonce?)` and `serializeState(state, nonce?)` accept an optional nonce for strict Content Security Policy compliance.
- **CSS injection guard** — New `sanitizeCSSValue()` blocks `url()`, `expression()`, `javascript:`, and `-moz-binding` in style property values. Applied automatically in `tagFactory` style bindings.
- **`persisted()` encryption support** — New `encrypt`/`decrypt` options for data-at-rest protection in localStorage/sessionStorage.
- **SSR state deserialization validation** — `deserializeState(validate?)` accepts an optional type guard to reject tampered payloads.

---

## [1.0.0] — 2026-03-27

### Added

- **`KeepAlive`** — Caches component DOM subtrees by key, preserving reactive bindings when switching views. Supports LRU eviction via `{ max }` option. Unlike `when()`/`match()`, toggling does NOT dispose the previous branch — scroll position, form state, and signal subscriptions survive.
- **`action()`** — Reusable element-level behaviors with automatic disposal. Built-in actions: `clickOutside` (close on outside click), `longPress` (sustained press detection), `trapFocus` (keyboard focus trapping for a11y). Custom actions return a cleanup function.
- **`writable()`** — Computed with setter. Combines a `derived()` getter with a user-provided setter for two-way computed state. Setter is automatically batched.
- **`springSignal()`** — Reactive spring-animated value with physics simulation (stiffness, damping, precision). Animates toward target via `requestAnimationFrame`. Respects `prefers-reduced-motion` (snaps instantly). Returns `[get, set, dispose]` tuple. Import from `sibujs/motion`.
- **`on()`** — Explicit dependency specification for effects. Only the deps getter is tracked; the handler runs untracked. Provides `(value, prev)` callback signature.
- **`untracked()`** — Execute a function without tracking signal reads as dependencies. Wraps the internal `suspendTracking()`/`resumeTracking()` pair.
- **`signal()` `equals` option** — Custom equality function via `signal(value, { equals: (a, b) => boolean })`. Defaults to `Object.is()`. `deepSignal` refactored to delegate to `signal()` with `equals: deepEqual`, eliminating code duplication.
- **`effect()` `onError` option** — Optional error handler via `effect(fn, { onError: (err) => ... })`. Zero overhead when not provided (no wrapper closure).

### Changed

- **`batch()` returns the callback's value** — Signature changed from `(fn: () => void): void` to `<T>(fn: () => T): T`. Existing code is unaffected (void return still works).
- **`deepSignal` refactored** — Now delegates to `signal()` with `equals: deepEqual`. Gains devtools support for free. `deepEqual()` is now exported for reuse.

### Fixed

- **Notification queue isolation** — One failing subscriber no longer crashes remaining subscribers. All subscriber invocation points in `track.ts` are wrapped in `safeInvoke()` with dev-mode warnings.
- **Dev-mode warnings in silent binding catches** — `bindAttribute` and `bindChildNode` now log `devWarn()` instead of silently swallowing errors. Zero cost in production (tree-shaken).
- **Lifecycle error protection** — `onMount`/`onUnmount` callbacks wrapped in `safeCall()` — throwing callbacks no longer crash the microtask queue or MutationObserver.
- **Per-item error isolation in `each()`** — A throwing render function for one item no longer kills the entire list. Failed items render as comment node placeholders; other items render normally.
- **SSR error handling** — `renderToString`, `renderToStream`, and `renderToDocument` now catch errors per child node, rendering `<!--SSR error: ...-->` comments instead of crashing the server. Error messages are HTML-escaped for security.

---

## [1.0.0-beta.7] — 2026-03-26

### Changed

- **derived() re-tracks dependencies on re-evaluation** — `computedGetter` now uses `track()` instead of `suspendTracking()` when re-evaluating, so derived-of-derived chains propagate correctly. Formula cells like `=SUM(F2:F4)` where F2 is itself `=SUM(B2:E2)` now update automatically.
- **propagateDirty simplified** — removed eager evaluation path; dirty flags propagate through the chain and lazy pull via `computedGetter` + `track()` handles re-evaluation with correct dependency registration.

### Added

- **`lazyEffect()`** — `import { lazyEffect } from "sibujs/ui"` — creates effects that only activate when the target element is visible (via IntersectionObserver). When the element leaves the viewport, the effect is disposed. Ideal for large grids with thousands of cells.
- Spreadsheet showcase demo upgraded: safe math parser (CSP-safe, no `eval`/`new Function`), circular reference detection (`#CIRC`), `lazyEffect` for scalable cell rendering

---

## [1.0.0-beta.6] — 2026-03-26

### Changed

- **ref() is now reactive** — reading `.current` tracks dependencies, writing `.current` notifies subscribers. Works directly with `resize()`, `draggable()`, `dropZone()`, and other APIs that accept reactive getters
- **Browser APIs accept ref or getter** — `resize()`, `draggable()`, `dropZone()` now accept `Ref<HTMLElement> | (() => HTMLElement | null)`
- **debugValue() is now reactive** — uses `effect()` internally to track signal changes; returns a dispose function
- **Router lazy() uses symbol marker** — `isAsyncComponent` now checks `Symbol.for("sibujs:lazy")` instead of relying on `AsyncFunction` constructor name heuristic
- **Widget reactive accessor methods** — `tabs().isActive(id)`, `accordion().isExpanded(id)`, `datePicker().isSelected(date)` — safe to use inside `each()` render callbacks

### Added

- **`onElement` prop** in tag factories — `input({ onElement: (el) => mask.bind(el) })` — called after element creation for imperative bindings
- 93+ interactive examples in sibujs-test covering every module
- 10-tab examples page in sibujs-web (Showcase, Core, Data, Browser, Patterns, Motion, UI & Widgets, Plugins, DevTools, Performance)
- Spreadsheet showcase demo (reactive formulas, SUM, keyboard navigation, cell editing)

## [1.0.0-beta.5] — 2026-03-26

### Fixed

- Comprehensive framework review: fix 23 bugs, clean up module structure
- Update documentation and module exports

---

## [1.0.0-beta.4] — 2026-03-26

### Fixed

- Correct subpackage import paths in README and documentation
- Update package references across all entry points

---

## [1.0.0-beta.3] — 2026-03-25

### Fixed

- Handle array expressions in `html` tagged template engine
- Documentation updates

---

## [1.0.0-beta.2] — 2026-03-25

### Changed

- Optimize reactivity core, `tagFactory`, and `html` template engine for performance
- General improvements and cleanup

### Fixed

- Update all references to match current `sibujs` API (renamed from old `sibu` naming)

---

## [1.0.0-beta.1] — 2026-03-20

Initial public beta release.
