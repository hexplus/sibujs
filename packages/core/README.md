# @sibujs/core

The reactivity + rendering engine of [SibuJS](https://sibujs.dev) — fine-grained
signals, direct-DOM rendering, control flow, components, lifecycle, and
islands/progressive-enhancement primitives. No Virtual DOM, no compiler.

Most applications install [`sibujs`](https://www.npmjs.com/package/sibujs), which
re-exports this package plus the router, i18n, SSR, data, and UI layers. Depend on
`@sibujs/core` directly when you want only the engine, or when building a library
that should share a single engine instance with its host app.

## Install

```bash
npm install @sibujs/core
```

## Quick start

```javascript
import { div, h1, button, signal, mount } from "@sibujs/core";

function Counter() {
  const [count, setCount] = signal(0);
  return div("counter", [
    h1(() => `Count: ${count()}`),
    button({ on: { click: () => setCount(count() + 1) } }, "Increment"),
  ]);
}

mount(Counter, document.getElementById("app"));
```

## What's included

- **Reactivity:** `signal`, `derived`, `asyncDerived`, `effect`, `watch`, `batch`,
  `store`, `deepSignal`, reactive `array`, `writable`, `ref`, `untracked`,
  `retrack`, `nextTick`.
- **Rendering & control flow:** HTML/SVG tag factories, `mount`, `html`, `each`
  (LIS-keyed lists), `when`, `show`, `match`, `Fragment`, `Portal`,
  `DynamicComponent`, `lazy`/`Suspense`, `slot`, `KeepAlive`, directives, `action`.
- **Components & lifecycle:** functional components, `onMount`, `onUnmount`,
  `onCleanup`, `context`, `ErrorBoundary`, `ErrorDisplay`, `Loading`.
- **Islands & enhancement:** `enhance`, `island`, `hydrateIslands`.

## Single-instance guarantee

`@sibujs/core` is designed to resolve to a single copy per page. Duplicate copies
(usually a bundler misconfig) are detected in development and reported with a
one-time warning; de-duplicate with your bundler (e.g. Vite
`resolve.dedupe: ['@sibujs/core']`).

## License

MIT © [hexplus](https://github.com/hexplus)
