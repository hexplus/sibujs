# SibuJS

A lightweight, function-based frontend framework with fine-grained reactivity, direct DOM rendering, and zero compilation. **No Virtual DOM. No magic.**

[[NPM Version]](https://www.npmjs.com/package/sibujs)
[[License]](https://github.com/hexplus/sibujs/blob/main/LICENSE)

## Why SibuJS?

- **Zero VDOM:** Updates only what changes, directly in the DOM.
- **Function-Based:** Components are just plain functions. No classes, no complex life cycles.
- **Fine-Grained Reactivity:** Powered by lightweight signals.
- **No Build Step Required:** Works natively in the browser, but includes a Vite plugin for advanced optimizations.
- **Modular & Lean:** Core is minimal; features like Router and i18n are optional plugins.

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

## Features at a Glance

- **Reactivity:** `signal`, `effect`, `derived`, `watch`, `batch`.
- **Components:** Functional, reusable, and lifecycle-aware (`onMount`, `onUnmount`).
- **Control Flow:** `when` (conditional swaps), `each` (efficient keyed lists), `match` (pattern matching), `show` (toggle visibility).
- **DOM Utilities:** `Portal` (render out-of-tree), `Fragment` (group children), `Suspense` & `lazy` (async components), `ErrorBoundary`.
- **State Management:** `store` (simple state containers), `deepSignal` (object proxies), `ref`.
- **Performance:** Zero VDOM overhead, LIS-based list diffing, and optional template compilation.
- **Plugins:** Official Router (nested routes, guards), i18n (reactive translations), logic patterns (Finite State Machines).

---

## Ecosystem

- [SibuJS UI](https://github.com/hexplus/sibujs-ui) - Component library.

## License

MIT © [hexplus](https://github.com/hexplus)
