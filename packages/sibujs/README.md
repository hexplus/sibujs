# SibuJS

A lightweight, function-based frontend framework with fine-grained reactivity, direct DOM rendering, and zero compilation. **No Virtual DOM. No magic.**

[[NPM Version]](https://www.npmjs.com/package/sibujs)
[[License]](https://github.com/hexplus/sibujs/blob/main/LICENSE)

## Why SibuJS?

- **Zero VDOM:** Signals bind straight to the DOM, so only the exact node that changed updates — no diffing, no reconciliation.
- **Function-Based:** Components are plain functions returning nodes. No classes, no hooks rules, no compiler-only syntax.
- **Fine-Grained Reactivity:** `signal`, `derived`, and `effect` track dependencies automatically and update at the value level.
- **No Build Step Required:** Runs natively in the browser (or via a `<script>` tag), with an optional Vite plugin for template compilation and other build-time optimizations.
- **Modular & Lean:** The core stays small; every advanced capability ships as a tree-shakeable subpath import, so you pay only for what you use.
- **Full-Featured:** When you need more, it's already there — router, i18n, SSR with streaming and hydration, islands & progressive enhancement, data fetching, state machines, and reactive wrappers for dozens of browser APIs.
- **TypeScript-First:** Written in TypeScript with typed props for common elements and full type inference across signals and components.

## Quick Start

```bash
npm install sibujs
```

```javascript
import { div, h1, button, signal, mount } from "sibujs";

function Counter() {
  const [count, setCount] = signal(0);

  return div("counter", [
    h1(() => `Count: ${count()}`),
    button(
      { on: { click: () => setCount(count() + 1) } },
      "Increment",
    ),
  ]);
}

mount(Counter, document.getElementById("app"));
```

### Authoring Style

Every tag factory accepts children as an optional second positional
argument. This is **the canonical authoring style** — no `nodes:` key
at any level of the tree. The first argument can be a className string,
a props object, or the children themselves.

> **Lone string = text child.** A string is treated as a className only when
> children follow it (`div("card", [...])`). A *lone* string is a text child —
> `div("Hello")` renders the text "Hello". For a childless styled element use
> `div({ class: "..." })`. Dev builds warn when a lone string looks like a class
> list (e.g. `div("space-y-6")`) so the class names don't silently render as text.

```javascript
import { div, h1, label, input, button } from "sibujs";

// Positional className + children — the default form for styled wrappers
div("page", [
  h1("title", "Welcome"),
  div("row", [
    label({ for: "email" }, "Email"),
    input({ id: "email", type: "email" }),
    button(
      { class: "primary", type: "submit", on: { click: handleSubmit } },
      "Submit",
    ),
  ]),
]);

// Children-only — bare containers
div([h1("Hello"), p("World")]);

// Text-only
h1("Hello, world!");

// Reactive children
div(() => `Count: ${count()}`);
```

Legacy forms — the `{ class, nodes }` prop object and the `html` tagged
template — remain supported by the runtime so existing code keeps
working, but they are no longer the recommended authoring style. When
both `props.nodes` and the positional second argument are present, the
positional wins.

## Learn More

For full documentation, guides, and advanced examples, visit our official website:

### 🌐 [sibujs.dev](https://sibujs.dev/)

---

## Core (`sibujs`)

The lean core: reactivity, rendering, and components. Everything below imports from the root.

### Reactivity
- **`signal`** — reactive value returned as a `[get, set]` tuple; reads inside effects auto-track.
- **`derived`** — memoized value computed from other signals.
- **`asyncDerived`** — derived value from an async computation, with loading/error state.
- **`effect`** — run a side effect whenever its tracked dependencies change.
- **`watch`** — observe specific sources and react to their new/old values.
- **`batch`** — group multiple updates into a single flush.
- **`untracked` / `retrack`** — read signals without subscribing, or re-enable tracking.
- **`store`** — simple keyed state container.
- **`deepSignal`** — deep reactive proxy over nested objects/arrays.
- **`reactiveArray`** — reactive array with fine-grained item tracking.
- **`writable`** — writable derived (two-way computed).
- **`ref`** — hold a DOM element or mutable value.
- **`nextTick`** — await the next reactive flush.

### Rendering & Control Flow
- **HTML/SVG tag factories** — `div`, `span`, `button`, … and SVG tags with the correct namespace.
- **`mount`** — render a component into a DOM node.
- **`html`** — tagged-template authoring (compiler-free, legacy-friendly).
- **`when`** — conditionally swap subtrees; **`show`** — toggle visibility without unmounting.
- **`each`** — efficient keyed list rendering (LIS-based diffing).
- **`match`** — pattern-matching over a value to pick a branch.
- **`Fragment`** — group children without a wrapper element.
- **`Portal`** — render a subtree elsewhere in the DOM.
- **`DynamicComponent`** — render a component chosen at runtime.
- **`lazy` / `Suspense`** — code-split async components with a fallback.
- **`slot` / `getSlot`** — named content slots.
- **`KeepAlive`** — cache and preserve unmounted subtrees.
- **Directives** — `clickOutside`, `longPress`, `copyOnClick`, `autoResize`, `trapFocus`.
- **`action`** — register reusable element behaviors.

### Components & Lifecycle
- **Functional components** — plain functions returning nodes.
- **Lifecycle** — `onMount`, `onUnmount`, `onCleanup`.
- **`context`** — dependency injection down the tree.
- **`ErrorBoundary` / `ErrorDisplay`** — catch and render render-time errors.
- **`Loading`** — standard loading placeholder.
- **`catchError` / `catchErrorAsync`** — scoped error handling helpers.

### Islands & Progressive Enhancement
- **`enhance` / `enhanceAll`** — attach fine-grained reactivity to existing server-rendered HTML with no build step (the third rendering mode alongside `mount` and `hydrate`).
- **`island` / `registerIsland` / `hydrateIslands`** — hydrate isolated interactive regions on demand.

---

## Subpath Modules

Import advanced features from focused entry points for optimal tree-shaking. `sibujs/extras` re-exports all of them for convenience.

### `sibujs/data` — Data fetching & realtime
`query` (cached async fetching), `mutation`, `infiniteQuery`, `resource`, `routeLoader`, `offlineStore`, `retry`, `debounce`, `throttle`, `previous`, plus `socket` and `stream` for realtime connections.

### `sibujs/browser` — Reactive browser APIs
Reactive wrappers for `media` queries, `resize`, `scroll`, `online`/`network`, `geo`, `battery`, `idle`, `permissions`, `clipboard`, `dragDrop`, `title`/`favicon`, `colorScheme`, `visibility`, `mouse`/`swipe`, `windowSize`, `urlState`, `broadcast`, `fullscreen`, `wakeLock`, `animationFrame`, `mutationObserver`, `bounds`, `keyboard`, `speech`, `gamepad`, `pointerLock`, `vibrate`, `textSelection`, `imageLoader`, and `format`.

### `sibujs/ui` — UI utilities
`form` & `formAction` (validation/binding), `virtualList`, `intersection`, `inputMask`, `a11y` / `a11yPrimitives`, `scopedStyle`, `reactiveAttr`, `dialog`, `toast`, `infiniteScroll`, `pagination`, `eventBus`, `timers`, `hover`, `scrollLock`, `lazyEffect`, plus composable/HOC patterns.

### `sibujs/widgets` — Pre-built components
Accessible `Combobox`, `Tabs`, `Accordion`, `Popover`, `Select`, `Tooltip`, `FileUpload`, `contentEditable`, and `datePicker`.

### `sibujs/motion` — Transitions & animation
`transition`, `TransitionGroup`, `animationPresets`, `viewTransition`, `springSignal`, and `reducedMotion`.

### `sibujs/patterns` — State & component patterns
`machine` (finite state machines), `persist`, `optimistic`, `timeTravel`, `globalStore`; plus `hoc`, `composable`, `componentProps`, and `contracts`.

### `sibujs/plugins` — First-party plugins
**Router** — `createRouter`, `Route`/`Outlet`/`RouterLink`, nested routes, guards (`beforeEach`, `beforeResolve`, `afterEach`), programmatic navigation, `preloadRoute`, memory router, and per-route transitions. **i18n** — `setLocale`, `t`, `Trans`, `registerTranslations`, reactive locale switching. Plus the plugin system (`modular`, `ecosystem`, `versioning`, `startup`).

### `sibujs/ssr` — Server rendering
`renderToString`, `renderToReadableStream`, `renderToDocument`, `hydrate`, streaming `Suspense`, `head` management, static site generation, incremental regeneration, route actions/middleware, scroll restoration, service worker & web/wasm workers, and microfrontend helpers.

### `sibujs/performance` — Scheduling & optimization
Concurrent rendering (`startTransition`, `scheduleUpdate`), cooperative `scheduler`, `domRecycler`, `compiled` templates, `chunkLoader`, `bundleOptimize`, and `normalize`.

### `sibujs/devtools` — Developer tools
`debug`, `debugValue`, `componentProfiler`, `signalGraph`, `introspect`, `devtoolsOverlay`, HMR support, and source maps.

### `sibujs/build` — Build tooling
Bundler plugins (`vite`, `webpack`), template compilation, route splitting, static analysis, linting, `.d.ts` declaration generation, CDN helpers, and IDE integration.

### `sibujs/ecosystem` — Adapters
Adapters bridging third-party state managers (e.g. Redux, MobX) and UI component libraries.

### `sibujs/testing` — Test helpers
Utilities for testing components and reactivity.

### `sibujs/cdn` — Script-tag bundle
Self-registering IIFE build exposing `window.Sibu`, for use without a bundler.

```html
<script src="https://unpkg.com/sibujs@latest/dist/sibu.global.js"></script>
<script>
  const { signal, effect, div, mount } = window.Sibu;
</script>
```

---

## Ecosystem

- [SibuJS UI](https://github.com/hexplus/sibujs-ui) - Component library.

## License

MIT © [hexplus](https://github.com/hexplus)
