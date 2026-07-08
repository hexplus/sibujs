# SibuJS Performance Cookbook

Optimization techniques for building fast SibuJS applications.

---

## 1. Signal Optimization

### Batch multiple updates

When updating several signals simultaneously, wrap them in `batch()` to defer subscriber notifications until all updates are complete.

```ts
import { batch } from "sibujs";

// Single notification pass — subscribers run once
batch(() => {
  setName("Alice");
  setAge(30);
  setRole("admin");
});
```

### Memoize derived values with `derived`

`derived` caches results and only recalculates when dependencies change. Use it for expensive computations or frequently accessed derived state.

```ts
const [items, setItems] = signal<Item[]>([]);
const [search, setSearch] = signal("");

// Only recalculates when items() or search() actually change
const filtered = derived(() =>
  items().filter((item) =>
    item.name.toLowerCase().includes(search().toLowerCase())
  )
);
```

---

## 2. Rendering Performance

### Compile `html` templates at build time

The SibuJS Vite plugin includes an **optional template compiler** that transforms `html\`...\`` tagged templates into direct tag factory function calls at build time. This eliminates the runtime parser entirely — the result is identical performance to hand-written Props Object code. Compiling HTML templates is optional; the runtime parser works out of the box without any build step.

```ts
// vite.config.ts
import { sibuVitePlugin } from "sibujs/build";

export default {
  plugins: [
    sibuVitePlugin() // compileTemplates enabled by default in production
  ]
};
```

**Before (your source code):**

```ts
const el = html`<div class=${cls}>
  <span>${() => count()}</span>
  <button on:click=${handler}>Click</button>
</div>`;
```

**After compilation (production build output):**

```ts
const el = ((v) => div({
  class: v[0]
}, [
  span(v[1]),
  button({ on: { click: v[2] } }, "Click")
]))([cls, () => count(), handler]);
```

The compiler handles: static/dynamic attributes, event handlers, expression children, nested elements, self-closing/void elements, SVG, and mixed static+dynamic attribute values.

Without the build step, the runtime parser caches results per call site via `WeakMap` — the ~1.5x parsing cost only applies on the first render of each component. Subsequent renders are equally fast regardless of authoring style.

### Compiled templates for static content

Use `staticTemplate()` for elements that never change. It parses HTML once and uses `cloneNode(true)` — 5-10x faster than `createElement` chains.

```ts
import { staticTemplate, precompile } from "sibujs/performance";

// Static: parsed once, cloned for each use
const icon = staticTemplate('<svg class="icon"><path d="M10 20..."/></svg>');

// Pre-compiled with hydration points
const cardTemplate = precompile(
  '<div class="card"><h3 id="title"></h3><p id="body"></p></div>',
  (el, props: { title: string; body: string }) => {
    el.querySelector("#title")!.textContent = props.title;
    el.querySelector("#body")!.textContent = props.body;
  }
);

// Usage — clones template and hydrates
const card = cardTemplate({ title: "Hello", body: "World" });
```

### DOM recycling for high-churn UIs

Reuse DOM elements instead of creating new ones. Reduces garbage collection pressure.

```ts
import { DOMPool } from "sibujs/performance";

const pool = new DOMPool(100);

// Acquire from pool (or create if empty)
const el = pool.acquire("div");
el.textContent = "Reused element";

// Return to pool when done
pool.release(el);
```

### Virtual scrolling for large lists

Render only visible items. Essential for lists with 100+ items.

```ts
import { VirtualList } from "sibujs/ui";

VirtualList({
  items: () => thousandsOfItems(),
  itemHeight: 48,
  containerHeight: 600,
  overscan: 5, // extra items to render above/below viewport
  renderItem: (item) => Row(item),
});
```

---

## 3. List Rendering

### Always use keyed `each()`

Keys enable the LIS (Longest Increasing Subsequence) reconciliation algorithm, which minimizes DOM moves.

```ts
import { each } from "sibujs";

each(
  () => users(),
  (user) => UserCard(user),
  { key: (user) => user.id } // unique, stable key
);
```

**Why keys matter:** Without keys, inserting one item at the start of a 100-item list causes 100 DOM replacements. With keys, only 1 insertion is performed.

### Use `show()` vs `when()` strategically

| Directive | DOM behavior | Best for |
|-----------|-------------|----------|
| `show(condition, el)` | Hides with `display: none` | Frequently toggled (dropdowns, tabs) |
| `when(condition, fn)` | Creates/destroys DOM | Rarely shown (error states, modals) |

---

## 4. Concurrent Rendering

### Use `startTransition()` for non-urgent updates

Keep the UI responsive while expensive work happens in the background.

```ts
import { startTransition, deferredValue } from "sibujs/performance";

// Search input stays responsive; results update at lower priority
function SearchPage() {
  const [query, setQuery] = signal("");
  const [results, setResults] = signal<Item[]>([]);

  const handleInput = (e: Event) => {
    const value = (e.target as HTMLInputElement).value;
    setQuery(value); // Immediate: update input

    startTransition(() => {
      setResults(expensiveSearch(value)); // Deferred: update results
    });
  };

  return div([
    input({ on: { input: handleInput }, value: () => query() }),
    each(() => results(), (item) => ResultItem(item), { key: (i) => i.id }),
  ]) as HTMLElement;
}
```

### Use `deferredValue()` for derived state

```ts
const [rawData, setRawData] = signal<number[]>([]);

// Syncs at low priority — won't block user input
const deferredData = deferredValue(() => rawData());
```

### Scheduler priority levels

```ts
import { scheduleUpdate, Priority } from "sibujs/performance";

// User input — execute immediately
scheduleUpdate(Priority.USER_BLOCKING, () => updateInput());

// Animation — next frame
scheduleUpdate(Priority.NORMAL, () => animateChart());

// Analytics — when idle
scheduleUpdate(Priority.IDLE, () => sendAnalytics());
```

### Process large datasets in chunks

```ts
import { processInChunks } from "sibujs/performance";

// Process 50 items per frame, yielding between chunks
await processInChunks(
  largeArray,
  (item) => processItem(item),
  50 // chunk size
);
```

---

## 5. Code Splitting

### Route-based splitting with `lazy()` + `Suspense()`

```ts
import { lazy, Suspense } from "sibujs";

const Dashboard = lazy(() => import("./pages/Dashboard"));
const Settings = lazy(() => import("./pages/Settings"));

function App() {
  return Suspense({
    nodes: () => router.outlet(),
    fallback: () => Loading(),
  });
}
```

### Fine-grained chunk loading

```ts
import { createChunkRegistry, lazyChunk } from "sibujs/performance";

const registry = createChunkRegistry({
  maxCacheSize: 50,
  retries: 2,
  onLoadStart: (id) => showSpinner(id),
  onLoadEnd: (id) => hideSpinner(id),
});

// Preload likely-needed chunks
registry.preload("settings", () => import("./Settings"));

// Load on demand with fallback
const SettingsPanel = lazyChunk(
  "settings",
  () => import("./Settings"),
  registry,
  () => Loading()
);
```

### Preload resources for faster navigation

```ts
import { preloadModule, prefetch } from "sibujs/performance";

// Preload JS modules the user will likely need
preloadModule("/chunks/dashboard.js");

// Prefetch next page resources
prefetch("/api/dashboard-data");
```

---

## 6. Memory Optimization

### Normalized stores for relational data

Avoid deeply nested objects. Normalized stores enable O(1) updates and lookups.

```ts
import { normalizedStore, normalize } from "sibujs/performance";

const users = normalizedStore<User>({ name: "user" });
const posts = normalizedStore<Post>({ name: "post" });

// Add entities
users.addMany(apiResponse.users);
posts.addMany(apiResponse.posts);

// O(1) lookup
const user = users.get("user-123");

// Efficient update — only one entity touched
users.update("user-123", { name: "Updated Name" });
```

### Proper disposal patterns

```ts
function Widget(): HTMLElement {
  const el = div({ class: "widget" }) as HTMLElement;

  const cleanupEffect = effect(() => {
    // reactive work
  });

  const interval = setInterval(() => { /* polling */ }, 5000);

  onUnmount(() => {
    cleanupEffect();
    clearInterval(interval);
  }, el);

  return el;
}
```

---

## 7. SSR Performance

### Streaming SSR for faster TTFB

```ts
import { renderToStream, renderToReadableStream } from "sibujs/ssr";

// AsyncGenerator-based streaming
for await (const chunk of renderToStream(App())) {
  response.write(chunk);
}

// Web Streams API (Node 18+, Deno, edge runtimes)
const stream = renderToReadableStream(App());
return new Response(stream);
```

### Progressive hydration with islands

Only hydrate components when they become visible.

```ts
import { hydrateProgressively } from "sibujs/ssr";

const cleanup = hydrateProgressively(
  document.getElementById("app")!,
  [
    { selector: "[data-island='header']", hydrate: () => Header() },
    { selector: "[data-island='sidebar']", hydrate: () => Sidebar() },
    { selector: "[data-island='content']", hydrate: () => Content() },
  ],
  { rootMargin: "200px" } // start hydrating 200px before visible
);
```

---

## 8. Bundle Size

### Import only what you use

SibuJS is tree-shakeable. Import from the most specific path.

```ts
// Good: only bundles what you import
import { div, signal, mount } from "sibujs";
import { VirtualList } from "sibujs/ui";

// Avoid: importing everything
import * as SibuJS from "sibujs";
import * as Extras from "sibujs/performance";
```

### Use build-time optimizations

```ts
// vite.config.ts
import { sibuVitePlugin } from "sibujs/build";

export default {
  plugins: [
    sibuVitePlugin({
      compileTemplates: true, // compile html`` to direct calls (default in prod)
      pureAnnotations: true,  // tree-shaking hints (default: true)
      staticOptimize: true,   // convert static calls to template cloning (default in prod)
    }),
  ],
};
```

### Analyze your bundle

```ts
import { analyzeBundle, estimateImportSize } from "sibujs/build";

// Check what you're shipping
const analysis = analyzeBundle(code);
console.log(analysis.totalSize);
console.log(analysis.unusedExports);

// Estimate cost of an import
const size = estimateImportSize("VirtualList");
```

### Use `devOnly()` for development code

```ts
import { devOnly, conditional } from "sibujs/performance";

// Stripped in production builds
devOnly(() => {
  enableDebugLogging();
  attachDevtools();
});

// Conditional feature loading
conditional(process.env.FEATURE_ANALYTICS, () => {
  import("./analytics").then((m) => m.init());
});
```

---

## Optimization Decision Guide

| Scenario | Technique | Import |
|----------|-----------|--------|
| Large list (100+ items) | `VirtualList` | `sibujs/ui` |
| Frequent DOM create/destroy | `DOMPool` | `sibujs/performance` |
| Repeated identical markup | `staticTemplate` | `sibujs/performance` |
| Expensive computation blocking UI | `startTransition` | `sibujs/performance` |
| Large data processing | `processInChunks` | `sibujs/performance` |
| Route-level code splitting | `lazy` + `Suspense` | `sibujs` |
| Complex relational data | `normalizedStore` | `sibujs/performance` |
| Multiple signal updates | `batch` | `sibujs` |
| Frequently toggled element | `show()` | `sibujs` |
| SSR with fast TTFB | `renderToStream` | `sibujs/ssr` |
| html`` perf in production | `sibuVitePlugin({ compileTemplates: true })` | `sibujs/build` |
| Production bundle size | `sibuVitePlugin` | `sibujs/build` |
