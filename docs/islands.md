# Reactive islands & progressive enhancement

SibuJS can render whole apps — but its sharpest use is **adding fine-grained
reactivity to HTML you already have, with no build step.** You server-render a
page (from any backend or static generator), drop in one `<script>` tag, and
wire reactivity onto specific elements. No JSX, no compiler, no bundler, no
virtual DOM.

This guide covers the three rendering modes, the `enhance()` primitive, and the
island runtime that activates them on demand.

---

## The three rendering modes

| Mode | What it does | Use when |
| --- | --- | --- |
| `mount(component, container)` | Renders a **fresh** tree into an empty container. | The client owns the UI; there's no server HTML to reuse. |
| `hydrate(component, container)` | Renders the component and **replaces** the server markup, taking ownership. | You server-rendered with the *same* component and want a full client takeover. |
| `enhance(target, setup)` | **Attaches** reactivity to the existing server markup, in place. | You have server HTML and want surgical interactivity without re-rendering it. |

`enhance` is the one to reach for in an HTML-first app. It never recreates static
DOM: it binds signals and effects to the nodes the server already sent, drives
only the dynamic parts, and ties every binding to disposal — so static content
never re-paints and there's no flash.

---

## `enhance(target, setup)`

```ts
import { signal } from "sibujs";
import { enhance } from "sibujs"; // also on window.Sibu via the CDN build

// server HTML:
//   <div data-counter>
//     <output data-ref="n">0</output>
//     <button data-ref="inc">+1</button>
//   </div>

const [n, setN] = signal(0);

enhance("[data-counter]", (ctx) => {
  ctx.text("@n", () => n());                 // drive existing <output> text
  ctx.on("@inc", "click", () => setN((v) => v + 1));
});
```

`enhance` returns a `dispose()` function; disposal is also wired to the element,
so removing its subtree cleans everything up automatically.

### Target resolution

Every helper accepts a target resolved against the enhanced root:

- `"@name"` → a descendant marked `data-ref="name"` (the ergonomic form).
- any other string → a raw CSS selector, queried within the root.
- an `Element` → used as-is.
- `null` → the root element itself.

### The `EnhanceContext`

| Helper | Purpose |
| --- | --- |
| `ctx.root` | The enhanced element. |
| `ctx.ref(target)` / `ctx.refs(target)` | Query a descendant / all descendants. |
| `ctx.on(target, event, handler, options?)` | Auto-removed event listener. |
| `ctx.text(target, () => value)` | Reactive `textContent`. |
| `ctx.attr(target, name, () => value)` | Reactive attribute (`null`/`undefined` removes; booleans serialize literally, so `aria-expanded` reads `"true"`/`"false"`). |
| `ctx.classed(target, name, () => bool)` | Reactive class toggle. |
| `ctx.show(target, () => bool)` | Reactive visibility (`display:none`). |
| `ctx.model(target, [get, set], options?)` | Two-way bind a form control (handles checkbox, number, `<select multiple>`). |
| `ctx.cleanup(fn)` | Register arbitrary teardown. |

Use `enhanceAll(selector, setup)` to enhance every match with one disposer.

### Avoiding a hydration flash

`enhance` never re-paints static content: a binding whose value already matches
the server markup writes nothing. To keep it that way, **seed signals from the
value the server rendered** so the first run is a no-op:

```ts
// server: <b data-ref="n">42</b>
const [n, setN] = signal(42); // matches the server → no first-paint flash
```

Intentionally changing server content on activation (e.g. swapping a
`Loading…` placeholder for live data) is a perfectly normal progressive-
enhancement pattern — it just works, with no warning. Seeding only matters when
you *don't* want a flash.

---

## Islands — partial hydration as a runtime primitive

Mark islands in your server HTML and declare *when* each should activate:

```html
<div data-sibu-island="counter">…server HTML…</div>
<div data-sibu-island="chart" data-sibu-load="visible">…</div>
<div data-sibu-island="filters" data-sibu-load="interaction">…</div>
```

Register each island's setup and call `mountIslands()` once:

```ts
import { registerIsland, mountIslands, lazyIsland, signal } from "sibujs";

registerIsland("counter", (ctx) => {
  const [n, setN] = signal(0);
  ctx.text("@n", () => n());
  ctx.on("@inc", "click", () => setN((v) => v + 1));
});

// Lazy code — the module is fetched only when the island activates, so the page
// ships ~0 JS for islands that never trigger.
registerIsland("chart", lazyIsland(() => import("./islands/chart.js")));

mountIslands(); // wires the whole page, honoring each island's strategy
```

`mountIslands(root?, options?)` returns a cleanup function that cancels pending
schedulers and disposes every mounted island.

### Activation strategies (`data-sibu-load`)

| Strategy | Activates… | Notes |
| --- | --- | --- |
| `load` *(default)* | immediately (next microtask) | |
| `idle` | on `requestIdleCallback` | falls back to a timeout |
| `visible` | when the element scrolls into view | `IntersectionObserver`; eager fallback where unavailable |
| `interaction` | on first pointer / focus / key / touch | cheapest until the user engages |
| `media` | when `data-sibu-media` matches | e.g. `data-sibu-media="(min-width: 768px)"` |

---

## The zero-build golden path

No npm, no transpile — one HTML file:

```html
<div data-sibu-island="counter">
  <output data-ref="n">0</output>
  <button data-ref="inc">+1</button>
</div>

<script src="https://unpkg.com/sibujs@latest/dist/cdn.global.js"></script>
<script>
  const { signal, registerIsland, mountIslands } = window.Sibu;
  registerIsland("counter", (ctx) => {
    const [n, setN] = signal(0);
    ctx.text("@n", () => n());
    ctx.on("@inc", "click", () => setN((v) => v + 1));
  });
  mountIslands();
</script>
```

A complete, runnable version (multiple islands and strategies) lives in
[`examples/islands.html`](../examples/islands.html).

---

## From your backend

The pattern is identical no matter what emits the HTML — Rails/Hotwire, Django,
Laravel, Go templates, Hugo/Eleventy, PHP, or a CMS:

1. Render your page as usual.
2. Wrap the interactive bits in `data-sibu-island="name"` and tag the dynamic
   nodes with `data-ref="…"`.
3. Add the `<script>` tag, register the islands, call `mountIslands()`.

You adopt it **one widget at a time** — there's no app-wide migration, no router
to take over, and the rest of your server-rendered page is untouched.

---

## Embedding into pages you don't control

Because there's no build step, no global framework state to pollute, and the
runtime is small with built-in URL/HTML sanitization and prototype-pollution
guards, `enhance`/islands are a good fit for **third-party widgets** dropped into
a host page — a comment box, a pricing calculator, a status widget. Scope your
ids with `createId()` and your styles with the scoped-style helpers, and the
widget stays isolated from its host.
