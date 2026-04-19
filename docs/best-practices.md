# SibuJS Best Practices Guide

Patterns and anti-patterns for building SibuJS applications.

---

## Component Design

### Keep components as pure functions

Every component is a function that returns an `HTMLElement`. Keep them small and focused.

```ts
// Good: simple, focused component
function UserCard(user: User): HTMLElement {
  return div({
    class: "user-card",
    nodes: [
      h2({ nodes: user.name }),
      p({ nodes: user.email }),
    ],
  }) as HTMLElement;
}
```

### Use composition over inheritance

Build complex UIs by composing smaller components.

```ts
function Dashboard(): HTMLElement {
  return div({
    nodes: [
      Header(),
      Sidebar(),
      MainContent(),
      Footer(),
    ],
  }) as HTMLElement;
}
```

### Prefer props objects for configurable components

```ts
interface AlertProps {
  message: string;
  type?: "info" | "warning" | "error";
}

function Alert({ message, type = "info" }: AlertProps): HTMLElement {
  return div({
    class: `alert alert-${type}`,
    nodes: message,
  }) as HTMLElement;
}
```

---

## Reactivity

### Call getters inside reactive contexts

Getters register dependencies only when called inside a tracked context (`effect`, `derived`, reactive prop functions, or `nodes: () => ...`).

```ts
const [count, setCount] = signal(0);

// Good: getter called inside reactive nodes function
div({ nodes: () => `Count: ${count()}` });

// Good: getter called inside effect
effect(() => {
  console.log("Count changed:", count());
});

// Anti-pattern: getter called outside tracked context — no updates
const text = `Count: ${count()}`; // captured once, never updates
div({ nodes: text }); // static, won't react to changes
```

### Use `batch()` for multiple updates

When updating several signals at once, wrap them in `batch()` to coalesce into a single notification pass.

```ts
import { batch } from "sibujs";

// Good: single notification
batch(() => {
  setFirstName("Alice");
  setLastName("Smith");
  setAge(30);
});

// Anti-pattern: three separate notification passes
setFirstName("Alice");
setLastName("Smith");
setAge(30);
```

### Don't create signals in loops or conditionals

Signals should be created at the top level of components or modules.

```ts
// Good: signals at component top level
function Counter() {
  const [count, setCount] = signal(0);
  return div({ nodes: () => `${count()}` });
}

// Anti-pattern: signal inside a conditional
function Bad(show: boolean) {
  if (show) {
    const [count, setCount] = signal(0); // inconsistent
  }
}
```

### Use `derived` for derived values

Don't recalculate derived state in every effect or render.

```ts
const [items, setItems] = signal<Item[]>([]);
const [filter, setFilter] = signal("");

// Good: computed caches and only recalculates when deps change
const filtered = derived(() =>
  items().filter((item) => item.name.includes(filter()))
);

// Anti-pattern: recalculating in every place it's used
div({ nodes: () => {
  const result = items().filter(i => i.name.includes(filter())); // repeated work
  return `${result.length} items`;
}});
```

---

## State Management

### Choose the right level of state

| Scope | Tool | When to use |
|-------|------|-------------|
| Local | `signal` | Single value, one component |
| Component | `store` | Object with multiple keys, one component |
| Global | `globalStore` | Shared across components, with actions |

```ts
// Local: simple toggle
const [open, setOpen] = signal(false);

// Component: form with multiple fields
const [form, { setState }] = store({
  name: "",
  email: "",
  role: "user",
});

// Global: app-wide auth state
const authStore = globalStore({
  state: { user: null, token: null },
  actions: {
    login: (state, payload) => ({ user: payload.user, token: payload.token }),
    logout: () => ({ user: null, token: null }),
  },
});
```

### Don't put everything in global state

Only share state that genuinely needs to be accessed across unrelated components. Local state is simpler and avoids unnecessary coupling.

---

## Performance

### Use `show()` for frequently toggled elements

`show()` hides with CSS (`display: none`) — the element stays in the DOM. `when()` creates and destroys DOM nodes. For frequently toggled UI, `show()` is faster.

```ts
// Good for frequent toggles (dropdown, tooltip)
show(() => isOpen(), dropdown());

// Better for rarely shown content (error states, modals)
when(() => hasError(), () => ErrorMessage(error()));
```

### Always use key functions with `each()`

Keys enable the LIS-based reconciliation algorithm. Without keys, list updates are O(n) DOM replacements.

```ts
// Good: keyed by unique identifier
each(() => users(), (user) => UserCard(user), { key: (u) => u.id });

// Anti-pattern: using array index (breaks on reorder/insert/delete)
each(() => users(), (user, i) => UserCard(user), { key: (_, i) => i });
```

### Use `VirtualList` for large datasets

Render only visible items instead of the entire list.

```ts
import { VirtualList } from "sibujs/ui";

VirtualList({
  items: () => largeArray(),
  itemHeight: 40,
  containerHeight: 400,
  overscan: 5,
  renderItem: (item) => Row(item),
});
```

---

## Memory Management

### Store and call cleanup functions

`effect` returns a cleanup function. Always call it when the component is no longer needed.

```ts
function Timer(el: HTMLElement): HTMLElement {
  const [seconds, setSeconds] = signal(0);
  const cleanup = effect(() => {
    const id = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(id); // inner cleanup
  });

  onUnmount(() => cleanup(), el); // outer cleanup on unmount

  return div({ nodes: () => `${seconds()}s` }) as HTMLElement;
}
```

### Use `onUnmount` for external resources

Clean up event listeners, WebSocket connections, timers, and other external resources.

```ts
function LiveFeed(): HTMLElement {
  const el = div({ class: "feed" }) as HTMLElement;
  const ws = new WebSocket("wss://api.example.com/feed");

  ws.onmessage = (e) => { /* update UI */ };

  onUnmount(() => {
    ws.close();
  }, el);

  return el;
}
```

---

## Error Handling

### Wrap components with ErrorBoundary

```ts
import { ErrorBoundary, div, p, button } from "sibujs";

function App(): HTMLElement {
  return ErrorBoundary(
    {
      fallback: (err, retry) =>
        div([
          p(`Error: ${err.message}`),
          button({ on: { click: retry } }, "Retry"),
        ]) as HTMLElement,
    },
    () => MainContent(),
  );
}
```

---

## Code Organization

### Use the right import path

```ts
import { div, signal, mount } from "sibujs";           // Core
import { VirtualList, form } from "sibujs/ui";         // UI
import { createRouter, t } from "sibujs/plugins";         // Plugins
import { sibuVitePlugin } from "sibujs/build";         // Build tools
```

### Group related state into stores

```ts
// Good: related state grouped
const [settings, { setState }] = store({
  theme: "light",
  language: "en",
  fontSize: 14,
});

// Anti-pattern: many loose signals for related data
const [theme, setTheme] = signal("light");
const [language, setLanguage] = signal("en");
const [fontSize, setFontSize] = signal(14);
```

---

## Testing

### Use `createTestHarness()` for DOM tests

```ts
import { createTestHarness } from "sibujs/plugins";

describe("Counter", () => {
  const harness = createTestHarness();

  afterEach(() => harness.teardown());

  it("should increment", () => {
    harness.render(Counter);
    const btn = harness.query("button")!;
    btn.click();
    expect(harness.query(".count")!.textContent).toBe("1");
  });
});
```

### Test behavior, not implementation

```ts
// Good: test what the user sees
expect(el.textContent).toBe("Hello, World");

// Anti-pattern: test internal signal values
expect(internalSignal()).toBe(42);
```

---

## Anti-Patterns Summary

| Anti-pattern | Problem | Fix |
|-------------|---------|-----|
| Reading getter outside tracked context | Value captured once, no updates | Wrap in `() => getter()` |
| Creating signals in loops | Unpredictable behavior | Create at top level |
| Missing key in `each()` | O(n) DOM replacements | Provide unique key function |
| Not cleaning up effects | Memory leaks | Call cleanup, use `onUnmount` |
| Everything in global state | Tight coupling, complexity | Use local state where possible |
| Using `when()` for frequent toggles | Unnecessary DOM churn | Use `show()` instead |
| Multiple uncoordinated updates | Multiple re-notifications | Wrap in `batch()` |
