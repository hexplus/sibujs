# SibuJS Best Practices Guide

Patterns and anti-patterns for building SibuJS applications, current as of the
latest release.

---

## Authoring Elements

Every element factory (`div`, `span`, `button`, …) accepts a small set of
positional calling conventions. **Children are passed positionally** — there is
no `nodes` key. (`nodes:` was an early prop and is deprecated; see the
anti-patterns table.)

| Call | Meaning |
|------|---------|
| `div()` | empty element |
| `div("Hello")` | a single **text** child |
| `div(42)` | numeric text child |
| `div([a, b])` | an array of children |
| `div(existingNode)` | wraps an existing DOM node |
| `div(() => value)` | a **reactive** child |
| `div("card", children)` | first string is the `class`, second is the children |
| `div({ ...props })` | a props object |
| `div({ ...props }, children)` | props **and** positional children |

```ts
import { div, h1, p, span } from "sibujs";

// Props + positional children — the idiomatic "deeply nested" form
div({ class: "card" }, [
  h1({ class: "title" }, "Hello"),
  p({ class: "body" }, "World"),
  div({ class: "row" }, [span({ id: "x" }, "child")]),
]);

// Shorthand: a class string plus children, no props object needed
div("card", [h1("title-text"), p("body-text")]);
```

### A lone string is always a text child

A single string argument renders as text — never as a class. A value that looks
like a utility-class list (e.g. `"h-6 w-48"`) is rendered as visible text and
triggers a dev warning, because it is almost always a misplaced `class`.

```ts
// Good: text content
p("Welcome back");

// Good: class on an otherwise empty/styled wrapper
div({ class: "space-y-6" });

// Good: class + children
div("space-y-6", [Header(), Body()]);

// Anti-pattern: class list rendered as text (dev warns)
div("space-y-6"); // renders the literal string "space-y-6"
```

### Reactive children are functions

Pass a getter (`() => value`) to make a child reactive. It re-renders when the
signals it reads change.

```ts
const [count, setCount] = signal(0);

// Reactive text child
div(() => `Count: ${count()}`);

// Reactive child inside the props form (children is the second argument)
span({ class: "count" }, () => count());
```

### Events go through the `on` prop

```ts
button({ class: "primary", on: { click: () => setCount((c) => c + 1) } }, "Increment");
```

### Optional: the `html` tagged template

For markup-heavy components you can author with the `html` tagged template.
Interpolated values are escaped and URL attributes are sanitized automatically.

```ts
import { html } from "sibujs";

const view = html`<a class="link" href=${url} on:click=${handler}>${label}</a>`;
```

---

## Component Design

### Keep components as pure functions

Every component is a function that returns an element. Keep them small and
focused.

```ts
function UserCard(user: User): HTMLElement {
  return div("user-card", [h2(user.name), p(user.email)]) as HTMLElement;
}
```

### Use composition over inheritance

Build complex UIs by composing smaller components.

```ts
function Dashboard(): HTMLElement {
  return div([Header(), Sidebar(), MainContent(), Footer()]) as HTMLElement;
}
```

### Prefer props objects for configurable components

```ts
interface AlertProps {
  message: string;
  type?: "info" | "warning" | "error";
}

function Alert({ message, type = "info" }: AlertProps): HTMLElement {
  return div({ class: `alert alert-${type}` }, message) as HTMLElement;
}
```

---

## Reactivity

### Call getters inside reactive contexts

Getters register dependencies only when called inside a tracked context
(`effect`, `derived`, reactive prop functions, or a reactive child `() => …`).

```ts
const [count, setCount] = signal(0);

// Good: getter called inside a reactive child
div(() => `Count: ${count()}`);

// Good: getter called inside an effect
effect(() => {
  console.log("Count changed:", count());
});

// Anti-pattern: getter read outside a tracked context — captured once
const text = `Count: ${count()}`; // never updates
div(text);
```

### Reactive reads use per-run dependency tracking

A reactive getter — a reactive child `() => value`, a `class`/`style` getter,
`derived`, `effect`, `watch` — is reactive to exactly the signals it reads on
its **most recent** run, not the union of every signal it has ever read. The
engine recomputes the dependency set on every evaluation: signals read on the
latest run are subscribed (even if a conditional branch reads them for the first
time), and signals no longer read are unsubscribed.

```ts
const [total, setTotal] = signal(0);
const [bytes, setBytes] = signal(0);

const el = div(() => {
  // First run: total() === 0 -> else branch -> bytes() is never read.
  return total() ? `${bytes()} / ${total()}` : "waiting";
});
mount(() => el, root);

setTotal(100); // re-runs the getter; NOW bytes() is read for the first time
setBytes(42); // text becomes "42 / 100" — bytes is now a tracked dependency
```

This means two things in practice:

- **You can rely on it.** A branch that becomes live later subscribes its
  signals automatically; you do not need to "pre-read" every signal. A branch
  you stop taking is pruned, so abandoned signals no longer trigger re-renders.
- **If you want a *stable* subscription regardless of branch**, read the
  conditionally-needed signal up front:

```ts
div(() => {
  const b = bytes(); // always read -> always subscribed
  return total() ? `${b} / ${total()}` : "waiting";
});
```

### Use `batch()` for multiple updates

When updating several signals at once, wrap them in `batch()` to coalesce into a
single notification pass.

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

Create signals at the top level of a component or module.

```ts
// Good
function Counter(): HTMLElement {
  const [count] = signal(0);
  return div(() => `${count()}`) as HTMLElement;
}

// Anti-pattern: signal inside a conditional
function Bad(show: boolean) {
  if (show) {
    const [count] = signal(0); // inconsistent lifecycle
  }
}
```

### Use `derived` for computed values

`derived` caches its result and only recomputes when its dependencies change.

```ts
const [items, setItems] = signal<Item[]>([]);
const [filter, setFilter] = signal("");

// Good: computed once per dependency change
const filtered = derived(() => items().filter((item) => item.name.includes(filter())));

// Anti-pattern: repeating the work everywhere it is used
div(() => `${items().filter((i) => i.name.includes(filter())).length} items`);
```

---

## State Management

### Choose the right level of state

| Scope | Tool | Import | When to use |
|-------|------|--------|-------------|
| Local | `signal` | `sibujs` | Single value, one component |
| Component | `store` | `sibujs` | Object with multiple keys, one component |
| Global | `globalStore` | `sibujs/patterns` | Shared across components, with actions |

```ts
import { signal, store } from "sibujs";
import { globalStore } from "sibujs/patterns";

// Local: a simple toggle
const [open, setOpen] = signal(false);

// Component: a form with multiple fields
const [form, { setState }] = store({ name: "", email: "", role: "user" });

// Global: app-wide auth state with actions
const auth = globalStore({
  state: { user: null, token: null },
  actions: {
    login: (state, payload) => ({ user: payload.user, token: payload.token }),
    logout: () => ({ user: null, token: null }),
  },
});
```

`store` exposes the reactive object plus `setState`; reading `form.name` inside a
reactive context subscribes to that key. Never mutate the store object directly —
go through `setState`.

### Don't put everything in global state

Only share state that genuinely needs to be reached across unrelated components.
Local state is simpler and avoids unnecessary coupling.

---

## Control Flow & Performance

### `show()` vs `when()` vs `match()`

- `show(() => cond, element)` toggles `display` — the element stays in the DOM.
  Best for frequently toggled UI (dropdowns, tooltips).
- `when(() => cond, thenFn, elseFn?)` creates and destroys DOM nodes. Best for
  content shown rarely (modals, error states).
- `match(() => value, cases, fallback?)` is a reactive switch.

```ts
import { show, when, match } from "sibujs";

show(() => isOpen(), dropdown());

when(
  () => hasError(),
  () => ErrorMessage(error()),
);

match(() => status(), {
  loading: () => Spinner(),
  error: () => ErrorMessage(error()),
  success: () => Content(),
});
```

### Always use a key function with `each()`

Keys enable LIS-based reconciliation. Without a stable key, list updates degrade
to O(n) DOM replacements, and reordering corrupts state. Keys must be unique —
duplicate keys drop or mis-order rows (and warn in dev).

```ts
import { each } from "sibujs";

// Good: keyed by a unique, stable identifier
each(() => users(), (user) => UserCard(user()), { key: (u) => u.id });

// Anti-pattern: a non-unique key (duplicate names collapse rows)
each(() => users(), (user) => UserCard(user()), { key: (u) => u.name });
```

The `key` function receives the raw item and must return a unique, stable id.
The render callback receives reactive getters — call `user()` / `index()` to read
the current item and index:

```ts
each(() => users(), (user, index) => Row({ user: user(), n: index() }), { key: (u) => u.id });
```

### Use `VirtualList` for large datasets

Render only the visible window instead of the whole list.

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

### Tie subscriptions to the DOM, and clean up external resources

`effect`, `watch`, and the directives register their teardown automatically and
run it when the owning element is disposed — you usually do not manage that by
hand. For **external** resources (timers, sockets, listeners on `window`),
register cleanup with `onUnmount` / `onCleanup`.

```ts
import { div, signal, effect, onUnmount } from "sibujs";

function Timer(): HTMLElement {
  const [seconds, setSeconds] = signal(0);
  const el = div(() => `${seconds()}s`) as HTMLElement;

  const id = setInterval(() => setSeconds((s) => s + 1), 1000);
  onUnmount(() => clearInterval(id), el);

  return el;
}
```

```ts
function LiveFeed(): HTMLElement {
  const el = div({ class: "feed" }) as HTMLElement;
  const ws = new WebSocket("wss://api.example.com/feed");
  ws.onmessage = (e) => {
    /* update UI */
  };
  onUnmount(() => ws.close(), el);
  return el;
}
```

If you create a standalone `effect` that is *not* tied to an element, keep its
returned disposer and call it when you are done.

---

## Error Handling

### Wrap risky subtrees with `ErrorBoundary`

```ts
import { ErrorBoundary, div, p, button } from "sibujs";

function App(): HTMLElement {
  return ErrorBoundary(
    {
      fallback: (err, retry) =>
        div([p(`Error: ${err.message}`), button({ on: { click: retry } }, "Retry")]) as HTMLElement,
    },
    () => MainContent(),
  );
}
```

Error messages are rendered as text (never as HTML), so untrusted error content
cannot inject markup.

---

## Code Organization

### Use the right import path

```ts
import { div, signal, derived, effect, batch, mount, each, show, when } from "sibujs"; // core
import { globalStore } from "sibujs/patterns"; // patterns
import { VirtualList, form } from "sibujs/ui"; // UI widgets
import { createRouter, RouterLink, Route } from "sibujs/plugins"; // router & plugins
import { render, fireEvent } from "sibujs/testing"; // test utilities
import { sibuVitePlugin } from "sibujs/build"; // build tooling
```

### Group related state into a store

```ts
// Good: related fields in one store
const [settings, { setState }] = store({ theme: "light", language: "en", fontSize: 14 });

// Anti-pattern: many loose signals for one logical unit
const [theme, setTheme] = signal("light");
const [language, setLanguage] = signal("en");
const [fontSize, setFontSize] = signal(14);
```

---

## Testing

### Render with the test utilities

`render()` mounts a component into a container and returns query helpers plus an
`unmount`. Pair it with `fireEvent` and `waitFor`.

```ts
import { render, fireEvent, waitFor } from "sibujs/testing";

describe("Counter", () => {
  it("increments on click", () => {
    const { getByRole, getByTestId, unmount } = render(() => Counter());

    fireEvent(getByRole("button")!, "click");

    expect(getByTestId("count")!.textContent).toBe("1");
    unmount();
  });
});
```

`render` exposes `container`, `element`, `getByText`, `getByTestId`, `getByRole`,
`queryAll`, and `unmount`. Call `unmountAll()` in an `afterEach` to dispose any
containers a test forgot to clean up.

### Test behavior, not implementation

```ts
// Good: assert what the user sees
expect(el.textContent).toBe("Hello, World");

// Anti-pattern: assert internal signal values
expect(internalSignal()).toBe(42);
```

---

## Anti-Patterns Summary

| Anti-pattern | Problem | Fix |
|--------------|---------|-----|
| `nodes:` prop for children | Deprecated authoring API | Pass children positionally: `div(props, children)` |
| Lone string as a class (`div("space-y-6")`) | A lone string is a text child — class names render as visible text | `div({ class: "space-y-6" })`, or `div("space-y-6", children)` |
| Reading a getter outside a tracked context | Value captured once, no updates | Wrap in `() => getter()` |
| Creating signals in loops/conditionals | Inconsistent lifecycle | Create at the top level |
| Missing or non-unique key in `each()` | O(n) replacements, dropped or mis-ordered rows | Provide a unique, stable key function |
| Mutating a `store` object directly | Bypasses reactivity | Update through `setState` |
| Not cleaning up external resources | Memory leaks | Use `onUnmount` / keep the `effect` disposer |
| Everything in global state | Tight coupling, complexity | Use local state where possible |
| `when()` for frequent toggles | Unnecessary DOM churn | Use `show()` |
| Multiple uncoordinated updates | Multiple notification passes | Wrap in `batch()` |
