# Changelog

All notable changes to SibuJS will be documented in this file.

This project follows [Semantic Versioning](https://semver.org/).

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
