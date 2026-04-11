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

  return div({ class: "counter" }, [
    h1(() => `Count: ${count()}`),
    button({ on: { click: () => setCount(c => c + 1) } }, "Increment"),
  ]);
}

mount(Counter, document.getElementById("app"));
```

### Three Ways to Author Components

SibuJS gives you maximum flexibility with three interoperable styles:

#### 1. Tag Factory
The canonical form: a props object followed by children as a second
positional argument. No `nodes:` key required at any level of the tree —
children can be a string, a number, a single node, an array, or a
reactive getter.

```javascript
import { div, h1, label, input, button } from "sibujs";

return div({ class: "counter" }, [
  h1({ class: "title" }, () => `Count: ${count()}`),
  label({ for: "amount" }, "Step"),
  input({ id: "amount", type: "number", value: 1 }),
  button(
    { class: "primary", on: { click: () => setCount(c => c + 1) } },
    "Increment",
  ),
]);
```

All legacy forms — `tag({ class, nodes })`, `tag("className", children)`,
`tag("text")`, `tag([children])`, `tag(node)`, `tag(() => reactive)` —
continue to work unchanged. When both `props.nodes` and the positional
second argument are present, the positional wins.

#### 2. Positional Shorthand
The tersest form. Class and children as positional arguments, for
layouts with no event handlers or custom props.

```javascript
import { div, h1, button } from "sibujs";

return div("counter", [
  h1(() => `Count: ${count()}`),
  button({ on: { click: () => setCount(c => c + 1) } }, "Increment"),
]);
```

#### 3. HTML Tagged Template
Familiar HTML-like syntax using tagged template literals. No compiler needed!

```javascript
import { html } from "sibujs";

return html`
  <div class="counter">
    <h1>Count: ${() => count()}</h1>
    <button on:click=${() => setCount(c => c + 1)}>Increment</button>
  </div>
`;
```

## Learn More

For full documentation, guides, and advanced examples, visit our official website:

### 🌐 [sibujs.dev](https://sibujs.dev/)

---

## Features at a Glance

- **Reactivity:** `signal`, `effect`, `derived`, `watch`, `batch`.
- **Components:** Functional, reusable, and lifecycle-aware (`onMount`, `onUnmount`).
- **Control Flow:** `when` (conditional swaps), `each` (efficient keyed lists), `match` $(pattern matching)$, `show` (toggle visibility).
- **DOM Utilities:** `Portal` (render out-of-tree), `Fragment` (group children), `Suspense` & `lazy` (async components), `ErrorBoundary`.
- **State Management:** `store` (simple state containers), `deepSignal` (object proxies), `ref`.
- **Performance:** Zero VDOM overhead, LIS-based list diffing, and optional template compilation.
- **Plugins:** Official Router (nested routes, guards), i18n (reactive translations), logic patterns (Finite State Machines).

---

## Ecosystem

- [SibuJS UI](https://github.com/hexplus/sibujs-ui) - Component library.

## License

MIT © [hexplus](https://github.com/hexplus)
