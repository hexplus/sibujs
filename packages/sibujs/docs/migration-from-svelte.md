# Migrating from Svelte to SibuJS

A comprehensive guide for Svelte developers moving to SibuJS. Both frameworks share the philosophy of fine-grained DOM updates without a virtual DOM, but they achieve it through fundamentally different means: Svelte uses a compiler that transforms `.svelte` files into optimized JavaScript, while SibuJS uses runtime signals and tag factory functions in plain TypeScript -- no compiler, no custom file format, no magic.

This guide walks through every major Svelte concept and shows its SibuJS equivalent with side-by-side code examples.

---

## Table of Contents

1. [Introduction: Mental Model Shift](#1-introduction-mental-model-shift)
2. [Components](#2-components)
3. [Reactivity](#3-reactivity)
4. [Templates to Functions](#4-templates-to-functions)
5. [Events](#5-events)
6. [Stores](#6-stores)
7. [Lifecycle](#7-lifecycle)
8. [Slots](#8-slots)
9. [Transitions and Animations](#9-transitions-and-animations)
10. [Migration Checklist](#10-migration-checklist)

---

## 1. Introduction: Mental Model Shift

### What stays the same

- **Fine-grained updates.** Neither framework uses a virtual DOM. When state changes, only the affected DOM nodes update -- not an entire component subtree.
- **Components are the unit of composition.** You build UIs by composing smaller pieces into larger ones.
- **Reactive state drives the UI.** You declare state, bind it to the DOM, and the framework keeps them in sync.

### What changes

| Concept | Svelte | SibuJS |
|---|---|---|
| File format | `.svelte` (custom) | `.ts` / `.js` (standard) |
| Build requirement | Svelte compiler required | None -- runs as-is |
| Template syntax | HTML with directives (`{#if}`, `{#each}`, `on:`) | Function calls (`when()`, `each()`, `on: {}`) |
| Reactivity model | Compiler-analyzed (`let`, `$:`, runes) | Runtime signals (`signal`, `derived`) |
| State declaration | `let count = 0` (compiler magic) | `const [count, setCount] = signal(0)` |
| State mutation | `count += 1` (assignment triggers update) | `setCount(c => c + 1)` (explicit setter) |
| Editor support | Requires Svelte language plugin | Standard TypeScript -- works everywhere |

The core shift: in Svelte, the compiler understands your code and generates update logic. In SibuJS, you write the update logic explicitly using getter/setter pairs and reactive functions. This trades some syntactic brevity for complete transparency -- the code you write is the code that runs.

---

## 2. Components

### Basic Component

**Svelte:**
```svelte
<!-- Greeting.svelte -->
<script>
  export let name = "World";
</script>

<h1>Hello, {name}!</h1>
```

**SibuJS:**
```ts
// Greeting.ts
import { h1 } from "sibujs";

function Greeting({ name = "World" }: { name?: string }) {
  return h1(`Hello, ${name}!`);
}
```

### Component with State

**Svelte:**
```svelte
<!-- Counter.svelte -->
<script>
  let count = 0;

  function increment() {
    count += 1;
  }
</script>

<div>
  <h1>{count}</h1>
  <button on:click={increment}>Increment</button>
</div>
```

**SibuJS:**
```ts
// Counter.ts
import { div, h1, button, signal } from "sibujs";

function Counter() {
  const [count, setCount] = signal(0);

  return div([
    h1(() => `${count()}`),
    button({
      on: { click: () => setCount(c => c + 1) },
    }, "Increment"),
  ]);
}
```

Key differences:
- State is declared with `signal`, which returns a `[getter, setter]` tuple.
- Reading state requires calling the getter: `count()` instead of `count`.
- Updating state requires calling the setter: `setCount(c => c + 1)` instead of `count += 1`.
- Reactive text content is wrapped in `() =>` so SibuJS knows to re-evaluate it when dependencies change.

### Component with Props

**Svelte:**
```svelte
<!-- UserCard.svelte -->
<script>
  export let name;
  export let age = 25;
  export let active = false;
</script>

<div class="card" class:active>
  <h2>{name}</h2>
  <p>Age: {age}</p>
</div>
```

**SibuJS:**
```ts
// UserCard.ts
import { div, h2, p } from "sibujs";

interface UserCardProps {
  name: string;
  age?: number;
  active?: boolean;
}

function UserCard({ name, age = 25, active = false }: UserCardProps) {
  return div({
    class: { card: true, active },
  }, [
    h2(name),
    p(`Age: ${age}`),
  ]);
}
```

Key differences:
- Props are standard TypeScript function parameters with an interface -- not `export let` declarations.
- Conditional classes use an object syntax `{ card: true, active }` instead of `class:active`.
- Full TypeScript type checking on props works out of the box, with no Svelte-specific language server needed.

### Mounting the App

**Svelte:**
```js
// main.js
import App from "./App.svelte";

const app = new App({
  target: document.getElementById("app"),
});

export default app;
```

**SibuJS:**
```ts
// main.ts
import { mount } from "sibujs";
import { App } from "./App";

const { unmount } = mount(App, document.getElementById("app"));

// Later, to tear down:
// unmount();
```

---

## 3. Reactivity

### Reactive Variables

**Svelte:**
```svelte
<script>
  let count = 0;
  let name = "Alice";

  // Assignment triggers reactivity
  function update() {
    count += 1;
    name = "Bob";
  }
</script>

<p>{count} - {name}</p>
```

**SibuJS:**
```ts
import { p, signal, batch } from "sibujs";

function MyComponent() {
  const [count, setCount] = signal(0);
  const [name, setName] = signal("Alice");

  function update() {
    batch(() => {
      setCount(c => c + 1);
      setName("Bob");
    });
  }

  return p(() => `${count()} - ${name()}`);
}
```

### Reactive Declarations (Derived Values)

**Svelte:**
```svelte
<script>
  let count = 0;
  $: doubled = count * 2;
  $: quadrupled = doubled * 2;
  $: isEven = count % 2 === 0;
</script>

<p>{count} x2 = {doubled} x4 = {quadrupled}</p>
<p>{isEven ? "Even" : "Odd"}</p>
```

**SibuJS:**
```ts
import { p, signal, derived } from "sibujs";

function MyComponent() {
  const [count, setCount] = signal(0);
  const doubled = derived(() => count() * 2);
  const quadrupled = derived(() => doubled() * 2);
  const isEven = derived(() => count() % 2 === 0);

  return div([
    p(() => `${count()} x2 = ${doubled()} x4 = ${quadrupled()}`),
    p(() => isEven() ? "Even" : "Odd"),
  ]);
}
```

Key difference: `$: derived = expr` becomes `const derived = derived(() => expr)`. The computed value is read by calling it as a function: `derived()`.

### Reactive Statements (Side Effects)

**Svelte:**
```svelte
<script>
  let count = 0;

  // Runs whenever count changes
  $: console.log("Count is now", count);

  // Multi-line reactive block
  $: {
    if (count > 10) {
      console.log("Count is getting big!");
      alert("Slow down!");
    }
  }
</script>
```

**SibuJS:**
```ts
import { signal, effect } from "sibujs";

function MyComponent() {
  const [count, setCount] = signal(0);

  // Runs whenever count changes (auto-tracked)
  effect(() => {
    console.log("Count is now", count());
  });

  // Multi-line effect
  effect(() => {
    if (count() > 10) {
      console.log("Count is getting big!");
      alert("Slow down!");
    }
  });

  // ...
}
```

`effect` automatically tracks which signals are read inside the function and re-runs whenever any of them change. No dependency array needed -- it works like Svelte's `$:` but is explicit and inspectable.

### Watching Values (Old/New)

**Svelte (Svelte 5 runes):**
```svelte
<script>
  let count = $state(0);

  $effect(() => {
    // No built-in old/new value comparison
    console.log("count changed to", count);
  });
</script>
```

**SibuJS:**
```ts
import { signal, watch } from "sibujs";

const [count, setCount] = signal(0);

// watch provides both new and old values
const stop = watch(count, (newVal, oldVal) => {
  console.log(`count: ${oldVal} -> ${newVal}`);
});

// Stop watching when no longer needed
stop();
```

### Batching Updates

**Svelte:** Svelte batches updates automatically within the same synchronous tick.

**SibuJS:**
```ts
import { signal, batch } from "sibujs";

const [name, setName] = signal("Alice");
const [age, setAge] = signal(25);

// Without batch: subscribers notified twice
setName("Bob");
setAge(30);

// With batch: subscribers notified once
batch(() => {
  setName("Bob");
  setAge(30);
});
```

---

## 4. Templates to Functions

The most visible change when migrating from Svelte is replacing HTML templates with function calls. Every HTML element has a corresponding tag factory function in SibuJS.

### Static HTML

**Svelte:**
```svelte
<div class="card">
  <h2>Title</h2>
  <p>Some description text</p>
  <a href="/details">Learn more</a>
</div>
```

**SibuJS:**
```ts
import { div, h2, p, a } from "sibujs";

div("card", [
  h2("Title"),
  p("Some description text"),
  a({ href: "/details" }, "Learn more"),
]);
```

### Reactive Text

**Svelte:**
```svelte
<h1>Hello, {name}!</h1>
<p>You have {count} items</p>
```

**SibuJS:**
```ts
h1(() => `Hello, ${name()}!`),
p(() => `You have ${count()} items`),
```

The `() =>` wrapper tells SibuJS this content is reactive. Static strings (like `"Title"`) need no wrapper.

### Conditional Rendering (`{#if}`)

**Svelte:**
```svelte
{#if loggedIn}
  <Dashboard />
{:else}
  <LoginForm />
{/if}

{#if count > 10}
  <p>Count is big!</p>
{/if}
```

**SibuJS:**
```ts
import { when } from "sibujs";

// if/else
when(
  () => loggedIn(),
  () => Dashboard(),
  () => LoginForm()
);

// if only (no else)
when(
  () => count() > 10,
  () => p("Count is big!")
);
```

### Toggle Visibility (`show`)

**Svelte:**
```svelte
<!-- Svelte doesn't have a built-in show/hide directive;
     you typically use {#if} or style:display -->
<div style:display={visible ? '' : 'none'}>
  Content
</div>
```

**SibuJS:**
```ts
import { show } from "sibujs";

// Keeps the element in the DOM, toggles display
show(
  () => visible(),
  div("Content") as HTMLElement
);
```

### Pattern Matching

**Svelte:**
```svelte
{#if status === 'loading'}
  <Spinner />
{:else if status === 'error'}
  <ErrorMessage />
{:else if status === 'success'}
  <Content />
{:else}
  <p>Unknown</p>
{/if}
```

**SibuJS:**
```ts
import { match } from "sibujs";

match(
  () => status(),
  {
    loading: () => Spinner(),
    error: () => ErrorMessage(),
    success: () => Content(),
  },
  () => p("Unknown")
);
```

### List Rendering (`{#each}`)

**Svelte:**
```svelte
<ul>
  {#each items as item (item.id)}
    <li>{item.name}</li>
  {/each}
</ul>
```

**SibuJS:**
```ts
import { ul, li, each } from "sibujs";

ul([
  each(
    () => items(),
    (item, index) => li(item().name),
    { key: item => item.id }
  ),
]);
```

Key points:
- The first argument is a reactive getter that returns the array.
- The second argument is the render function, receiving each item and its index.
- The third argument provides a key function for efficient reconciliation (equivalent to Svelte's `(item.id)` keyed each block).
- SibuJS uses LIS (Longest Increasing Subsequence) based diffing for minimal DOM moves.

### Dynamic Attributes

**Svelte:**
```svelte
<input
  type="text"
  value={name}
  placeholder="Enter name"
  disabled={!canEdit}
  class:highlight={isActive}
/>
```

**SibuJS:**
```ts
import { input } from "sibujs";

input({
  type: "text",
  value: () => name(),
  placeholder: "Enter name",
  disabled: () => !canEdit(),
  class: { highlight: () => isActive() },
});
```

### Dynamic Styles

**Svelte:**
```svelte
<div
  style:color={textColor}
  style:font-size="{fontSize}px"
  style:background-color={isActive ? 'blue' : 'gray'}
>
  Content
</div>
```

**SibuJS:**
```ts
div({
  style: {
    color: () => textColor(),
    fontSize: () => `${fontSize()}px`,
    backgroundColor: () => isActive() ? "blue" : "gray",
  },
}, "Content");
```

### Fragments

**Svelte:** Svelte components can return multiple top-level elements natively.

**SibuJS:**
```ts
import { Fragment } from "sibujs";

function MyComponent() {
  return Fragment([
    h2("Title"),
    p("Paragraph one"),
    p("Paragraph two"),
  ]);
}
```

---

## 5. Events

### Basic Event Handling

**Svelte:**
```svelte
<button on:click={handleClick}>Click me</button>
<input on:input={handleInput} />
<form on:submit|preventDefault={handleSubmit}>
  ...
</form>
```

**SibuJS:**
```ts
button({
  on: { click: handleClick },
}, "Click me");

input({
  on: { input: handleInput },
});

form({
  on: {
    submit: (e) => {
      e.preventDefault();
      handleSubmit(e);
    },
  },
}, [/* ... */]);
```

Note: Svelte event modifiers like `|preventDefault` and `|stopPropagation` do not have a declarative equivalent in SibuJS. Call the methods directly on the event object inside your handler.

### Multiple Events

**Svelte:**
```svelte
<div
  on:mouseenter={handleEnter}
  on:mouseleave={handleLeave}
  on:click={handleClick}
>
  Interactive element
</div>
```

**SibuJS:**
```ts
div({
  on: {
    mouseenter: handleEnter,
    mouseleave: handleLeave,
    click: handleClick,
  },
}, "Interactive element");
```

### Inline Handlers

**Svelte:**
```svelte
<button on:click={() => count += 1}>+1</button>
<button on:click={() => dispatch('remove', item.id)}>Remove</button>
```

**SibuJS:**
```ts
button({
  on: { click: () => setCount(c => c + 1) },
}, "+1");

button({
  on: { click: () => onRemove(item.id) },
}, "Remove");
```

### Component Events / Callbacks

**Svelte:**
```svelte
<!-- Child.svelte -->
<script>
  import { createEventDispatcher } from "svelte";
  const dispatch = createEventDispatcher();
</script>

<button on:click={() => dispatch('submit', { value: 42 })}>
  Submit
</button>

<!-- Parent.svelte -->
<Child on:submit={handleSubmit} />
```

**SibuJS:**
```ts
// Child.ts
function Child({ onSubmit }: { onSubmit: (data: { value: number }) => void }) {
  return button({
    on: { click: () => onSubmit({ value: 42 }) },
  }, "Submit");
}

// Parent.ts
function Parent() {
  return Child({
    onSubmit: (data) => console.log("Submitted:", data.value),
  });
}
```

In SibuJS, component events are simply callback props. There is no event dispatcher system -- pass functions directly.

---

## 6. Stores

### Writable Store

**Svelte:**
```ts
// stores.ts
import { writable } from "svelte/store";

export const count = writable(0);
export const user = writable({ name: "Alice", age: 25 });
```

```svelte
<!-- Component.svelte -->
<script>
  import { count, user } from "./stores";
</script>

<p>Count: {$count}</p>
<p>User: {$user.name}</p>
<button on:click={() => count.update(n => n + 1)}>+1</button>
<button on:click={() => user.set({ name: "Bob", age: 30 })}>Change user</button>
```

**SibuJS:**
```ts
// stores.ts
import { signal } from "sibujs";

export const [count, setCount] = signal(0);
export const [user, setUser] = signal({ name: "Alice", age: 25 });
```

```ts
// Component.ts
import { p, button, div } from "sibujs";
import { count, setCount, user, setUser } from "./stores";

function MyComponent() {
  return div([
    p(() => `Count: ${count()}`),
    p(() => `User: ${user().name}`),
    button({
      on: { click: () => setCount(n => n + 1) },
    }, "+1"),
    button({
      on: { click: () => setUser({ name: "Bob", age: 30 }) },
    }, "Change user"),
  ]);
}
```

The `$store` auto-subscription syntax in Svelte becomes calling the getter function `count()` in SibuJS. No special syntax needed -- signals are just functions.

### Derived Store

**Svelte:**
```ts
import { writable, derived } from "svelte/store";

const count = writable(0);
const doubled = derived(count, $count => $count * 2);
const summary = derived(
  [count, doubled],
  ([$count, $doubled]) => `${$count} x 2 = ${$doubled}`
);
```

**SibuJS:**
```ts
import { signal, derived } from "sibujs";

const [count, setCount] = signal(0);
const doubled = derived(() => count() * 2);
const summary = derived(() => `${count()} x 2 = ${doubled()}`);
```

`derived` automatically tracks which signals are read inside the getter function. No need to manually list dependencies or pass an array of stores.

### Readable Store

**Svelte:**
```ts
import { readable } from "svelte/store";

const time = readable(new Date(), (set) => {
  const interval = setInterval(() => set(new Date()), 1000);
  return () => clearInterval(interval);
});
```

**SibuJS:**
```ts
import { signal, onMount, onUnmount } from "sibujs";

const [time, setTime] = signal(new Date());

// Set up the interval (typically inside a component for lifecycle control)
function Clock() {
  const el = span(() => time().toLocaleTimeString());

  onMount(() => {
    const interval = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(interval);
  }, el as HTMLElement);

  return el;
}
```

### Object Store (`store`)

For structured state objects with multiple properties, SibuJS provides `store`:

**Svelte:**
```ts
import { writable } from "svelte/store";

const appState = writable({
  count: 0,
  name: "Alice",
  theme: "light",
});

// Update one field
appState.update(state => ({ ...state, count: state.count + 1 }));
```

**SibuJS:**
```ts
import { store } from "sibujs";

const [store, { setState, reset, subscribe, subscribeKey }] = store({
  count: 0,
  name: "Alice",
  theme: "light",
});

// Read individual properties reactively
store.count;   // reactive -- tracks dependency
store.name;    // reactive

// Update specific fields
setState({ count: store.count + 1 });

// Subscribe to specific key changes
subscribeKey("theme", (newTheme, oldTheme) => {
  console.log(`Theme changed: ${oldTheme} -> ${newTheme}`);
});

// Reset to initial state
reset();
```

### Persistent Store

**Svelte:** Requires a custom store or library.

**SibuJS:**
```ts
import { persisted } from "sibujs/patterns";

// Automatically saves to and restores from localStorage
const [theme, setTheme] = persisted("app-theme", "light");
setTheme("dark"); // persisted automatically
```

---

## 7. Lifecycle

### onMount

**Svelte:**
```svelte
<script>
  import { onMount } from "svelte";

  let canvas;

  onMount(() => {
    const ctx = canvas.getContext("2d");
    ctx.fillRect(0, 0, 100, 100);

    return () => {
      // Cleanup runs when component is destroyed
      console.log("cleaned up");
    };
  });
</script>

<canvas bind:this={canvas}></canvas>
```

**SibuJS:**
```ts
import { onMount, ref } from "sibujs";
import { canvas as canvasTag } from "sibujs";

function MyCanvas() {
  const canvasRef = ref<HTMLCanvasElement>();

  const el = canvasTag({ ref: canvasRef }) as HTMLElement;

  onMount(() => {
    const ctx = canvasRef.current!.getContext("2d");
    ctx!.fillRect(0, 0, 100, 100);
  }, el);

  return el;
}
```

### onDestroy / onUnmount

**Svelte:**
```svelte
<script>
  import { onDestroy } from "svelte";

  const interval = setInterval(() => {
    console.log("tick");
  }, 1000);

  onDestroy(() => {
    clearInterval(interval);
  });
</script>
```

**SibuJS:**
```ts
import { onMount, onUnmount } from "sibujs";

function Ticker() {
  const el = div("Ticking...") as HTMLElement;
  let interval: number;

  onMount(() => {
    interval = setInterval(() => {
      console.log("tick");
    }, 1000) as unknown as number;
  }, el);

  onUnmount(() => {
    clearInterval(interval);
  }, el);

  return el;
}
```

Key difference: `onUnmount` requires a reference to the element it watches. It uses a `MutationObserver` to detect when the element is removed from the DOM. In Svelte, `onDestroy` is implicitly scoped to the component.

### Lifecycle Comparison Table

| Svelte | SibuJS | Notes |
|---|---|---|
| `onMount(fn)` | `onMount(fn, element)` | SibuJS optionally accepts an element to observe |
| `onDestroy(fn)` | `onUnmount(fn, element)` | Requires element reference |
| `beforeUpdate` | `effect(fn)` | Effects run on dependency change |
| `afterUpdate` | `effect(fn)` | Effects run after reactive updates |
| `tick()` | `queueMicrotask(fn)` | Standard platform API |

---

## 8. Slots

### Default Slot

**Svelte:**
```svelte
<!-- Card.svelte -->
<div class="card">
  <slot>Default content</slot>
</div>

<!-- Usage -->
<Card>
  <p>Custom content here</p>
</Card>
```

**SibuJS:**
```ts
// Card.ts -- using children
function Card(children?: NodeChild) {
  return div("card", children ?? "Default content");
}

// Usage
Card(p("Custom content here"));
```

### Named Slots

**Svelte:**
```svelte
<!-- Layout.svelte -->
<div class="layout">
  <header>
    <slot name="header">Default header</slot>
  </header>
  <main>
    <slot>Default body</slot>
  </main>
  <footer>
    <slot name="footer">Default footer</slot>
  </footer>
</div>

<!-- Usage -->
<Layout>
  <h1 slot="header">My Page</h1>
  <p>Main content</p>
  <span slot="footer">Copyright 2025</span>
</Layout>
```

**SibuJS:**
```ts
import { getSlot } from "sibujs";
import type { Slots } from "sibujs";

// Layout.ts
function Layout({ slots }: { slots?: Slots }) {
  return div("layout", [
    header(getSlot(slots, "header")?.() ?? "Default header"),
    main(getSlot(slots, "default")?.() ?? "Default body"),
    footer(getSlot(slots, "footer")?.() ?? "Default footer"),
  ]);
}

// Usage
Layout({
  slots: {
    header: () => h1("My Page"),
    default: () => p("Main content"),
    footer: () => span("Copyright 2025"),
  },
});
```

### Slot Props (Render Props Pattern)

**Svelte:**
```svelte
<!-- List.svelte -->
<script>
  export let items = [];
</script>

<ul>
  {#each items as item}
    <li>
      <slot {item}>
        {item.name}
      </slot>
    </li>
  {/each}
</ul>

<!-- Usage -->
<List {items} let:item>
  <strong>{item.name}</strong> - {item.description}
</List>
```

**SibuJS:**
```ts
// List.ts -- render prop pattern
function List<T>({
  items,
  renderItem,
}: {
  items: () => T[];
  renderItem?: (item: T) => Element;
}) {
  return ul([
    each(
      items,
      (item, i) =>
        li(
          renderItem
            ? renderItem(item())
            : String((item() as any).name)
        ),
      { key: (item: any) => item.id }
    ),
  ]);
}

// Usage
List({
  items: () => items(),
  renderItem: (item) =>
    span([
      strong(item.name),
      ` - ${item.description}`,
    ]),
});
```

In SibuJS, the "slot props" pattern translates naturally to render props -- callback functions that receive data and return elements.

---

## 9. Transitions and Animations

### Basic Transition

**Svelte:**
```svelte
<script>
  import { fade, slide, fly } from "svelte/transition";
  let visible = true;
</script>

<button on:click={() => visible = !visible}>Toggle</button>

{#if visible}
  <div transition:fade={{ duration: 300 }}>
    Fading content
  </div>
{/if}
```

**SibuJS:**
```ts
import { signal, when } from "sibujs";
import { transition } from "sibujs/motion";

function FadeExample() {
  const [visible, setVisible] = signal(true);

  const content = div("Fading content") as HTMLElement;
  const { enter, leave } = transition(content, {
    property: "opacity",
    duration: 300,
    easing: "ease-in-out",
  });

  // Trigger transitions manually
  async function toggle() {
    if (visible()) {
      await leave();
      setVisible(false);
    } else {
      setVisible(true);
      await enter();
    }
  }

  return div([
    button({
      on: { click: toggle },
    }, "Toggle"),
    when(
      () => visible(),
      () => content
    ),
  ]);
}
```

### CSS Class-Based Transitions

**Svelte:**
```svelte
<div transition:fade>Fade me</div>
<div in:fly={{ y: 200 }} out:fade>Fly in, fade out</div>
```

**SibuJS:**
```ts
import { transition } from "sibujs/motion";

const box = div("Animated box") as HTMLElement;

const { enter, leave } = transition(box, {
  duration: 300,
  enterClass: "fade-in",
  leaveClass: "fade-out",
  activeClass: "visible",
});

// Play enter animation
await enter();

// Play leave animation
await leave();
```

### Spring Animations

**Svelte:**
```svelte
<script>
  import { spring } from "svelte/motion";
  const coords = spring({ x: 0, y: 0 }, {
    stiffness: 0.1,
    damping: 0.25,
  });
</script>

<div
  on:mousemove={(e) => coords.set({ x: e.clientX, y: e.clientY })}
>
  <div style="transform: translate({$coords.x}px, {$coords.y}px)">
    Follows mouse
  </div>
</div>
```

**SibuJS:**
```ts
import { spring } from "sibujs/motion";

const follower = div("Follows mouse") as HTMLElement;

// Spring animation using Web Animations API
await spring(follower, [
  { transform: "scale(0.8)", opacity: 0 },
  { transform: "scale(1.05)", opacity: 1, offset: 0.7 },
  { transform: "scale(1)", opacity: 1 },
], { duration: 400 });
```

### Transition Comparison

| Svelte | SibuJS | Notes |
|---|---|---|
| `transition:fade` | `transition(el, { property: "opacity" })` | Imperative enter/leave |
| `transition:slide` | `transition(el, { property: "height" })` | Configure CSS property |
| `transition:fly` | `transition(el, { enterClass, leaveClass })` | CSS class based |
| `animate:flip` | Manual with Web Animations API | Use `spring` |
| `spring(value)` | `spring(el, keyframes, opts)` | Web Animations API |
| `tweened(value)` | `transition(el, { duration, easing })` | CSS transitions |

---

## 10. Migration Checklist

Use this checklist when converting a Svelte project to SibuJS. Work through each item file by file.

### Project Setup

- [ ] Install SibuJS: `npm install sibujs`
- [ ] Remove Svelte dependencies: `svelte`, `@sveltejs/kit`, `svelte-preprocess`, etc.
- [ ] Update build config: remove Svelte-specific plugins. SibuJS needs no build plugin (optionally use `sibuVitePlugin` from `sibujs/build` for HMR and optimization).
- [ ] Rename `.svelte` files to `.ts` files
- [ ] Remove Svelte language server / editor plugin configuration (standard TypeScript support is sufficient)

### Components

- [ ] Convert `<script>` + HTML template + `<style>` structure into a single TypeScript function
- [ ] Replace `export let propName` with TypeScript function parameters and interfaces
- [ ] Replace HTML template markup with tag factory calls (`div()`, `p()`, `button()`, etc.)
- [ ] Add `import { div, p, button, ... } from "sibujs"` for each tag used

### Reactivity

- [ ] Replace `let x = value` (reactive) with `const [x, setX] = signal(value)`
- [ ] Replace direct assignment `x = newValue` with `setX(newValue)`
- [ ] Replace `x += 1` with `setX(prev => prev + 1)`
- [ ] Replace `$: derived = expr` with `const derived = derived(() => expr)`
- [ ] Replace `$: { sideEffect() }` with `effect(() => { sideEffect() })`
- [ ] Wrap reactive text content in `() =>` arrow functions
- [ ] Ensure all reactive reads call the getter: `x` becomes `x()`

### Template Syntax

- [ ] Replace `{expression}` interpolation with `() => expression` (for reactive) or direct value (for static)
- [ ] Replace `{#if cond}...{:else}...{/if}` with `when(() => cond, thenFn, elseFn)`
- [ ] Replace `{#each arr as item (key)}` with `each(() => arr, (item, i) => ..., { key: item => key })`
- [ ] Replace `class:name={expr}` with `class: { name: expr }` or `class: { name: () => expr() }`
- [ ] Replace `style:prop={value}` with `style: { prop: value }` or `style: { prop: () => value() }`
- [ ] Replace `bind:this={ref}` with `ref: myRef` (using `ref()`)
- [ ] Replace `<svelte:component this={Component}>` with `DynamicComponent(() => component())`

### Events

- [ ] Replace `on:event={handler}` with `on: { event: handler }`
- [ ] Replace `on:event|preventDefault` with explicit `e.preventDefault()` in the handler
- [ ] Replace `on:event|stopPropagation` with explicit `e.stopPropagation()` in the handler
- [ ] Replace `createEventDispatcher()` + `dispatch('name', data)` with callback props

### Stores

- [ ] Replace `writable(value)` with `signal(value)` (exported from a shared module)
- [ ] Replace `readable(value, setup)` with `signal(value)` + setup logic in a lifecycle callback (onMount)
- [ ] Replace `derived(store, fn)` with `derived(() => fn(getter()))`
- [ ] Replace `$storeName` auto-subscriptions with calling the getter: `storeName()`
- [ ] Replace `store.set(value)` with `setter(value)`
- [ ] Replace `store.update(fn)` with `setter(fn)` (SibuJS setters accept updater functions)
- [ ] Replace `store.subscribe(fn)` with `effect(() => { fn(getter()) })`
- [ ] For complex object stores, consider using `store` for structured state

### Lifecycle

- [ ] Replace `onMount(fn)` with `onMount(fn, element)`
- [ ] Replace `onDestroy(fn)` with `onUnmount(fn, element)`
- [ ] Replace `beforeUpdate` / `afterUpdate` with `effect`
- [ ] Replace `tick()` with `queueMicrotask(fn)`

### Slots

- [ ] Replace `<slot>` with positional children
- [ ] Replace `<slot name="x">` with `getSlot(slots, "x")` and a `slots` prop of type `Slots`
- [ ] Replace `<Component let:item>` slot props with render prop callbacks

### Transitions

- [ ] Replace `transition:fade` with `transition(element, options)`
- [ ] Replace `in:` / `out:` directives with `enter()` / `leave()` calls
- [ ] Replace `spring()` / `tweened()` motion stores with `spring()`
- [ ] Move transition CSS to external stylesheets if using class-based transitions

### Styles

- [ ] Move `<style>` blocks to external CSS files, or use `scopedStyle()` / `withScopedStyle()` from `sibujs/ui`
- [ ] Svelte's automatic style scoping is replaced by SibuJS's explicit `scopedStyle()` utility from `sibujs/ui`

### Advanced

- [ ] Replace Svelte context API (`setContext` / `getContext`) with `context` from SibuJS
- [ ] Replace `<svelte:head>` with the `Head` utility from `sibujs/ssr`
- [ ] Replace `<svelte:window>` event bindings with manual `addEventListener` in `onMount`
- [ ] Replace `<svelte:body>` event bindings with manual `addEventListener` in `onMount`
- [ ] Replace SvelteKit routing with SibuJS router from `sibujs/plugins`

---

## Quick Reference: Svelte to SibuJS Cheat Sheet

| Svelte | SibuJS | Import from |
|---|---|---|
| `let count = 0` | `const [count, setCount] = signal(0)` | `sibujs` |
| `count += 1` | `setCount(c => c + 1)` | -- |
| `$: doubled = count * 2` | `const doubled = derived(() => count() * 2)` | `sibujs` |
| `$: { console.log(count) }` | `effect(() => { console.log(count()) })` | `sibujs` |
| `{count}` in template | `() => count()` as a child | -- |
| `{#if cond}` | `when(() => cond(), thenFn, elseFn)` | `sibujs` |
| `{#each arr as item (key)}` | `each(() => arr(), renderFn, { key })` | `sibujs` |
| `on:click={handler}` | `on: { click: handler }` | -- |
| `bind:this={el}` | `ref: myRef` | `sibujs` (ref) |
| `export let prop` | Function parameter | -- |
| `<slot>` | positional children | -- |
| `<slot name="x">` | `getSlot(slots, "x")` | `sibujs` |
| `writable(val)` | `signal(val)` | `sibujs` |
| `derived(store, fn)` | `derived(() => fn(getter()))` | `sibujs` |
| `$store` | `store()` (call the getter) | -- |
| `onMount(fn)` | `onMount(fn, el)` | `sibujs` |
| `onDestroy(fn)` | `onUnmount(fn, el)` | `sibujs` |
| `transition:fade` | `transition(el, opts)` | `sibujs/motion` |
| `spring(val)` | `spring(el, keyframes, opts)` | `sibujs/motion` |
| `setContext` / `getContext` | `context(default)` | `sibujs` |
| `class:active={expr}` | `class: { active: () => expr() }` | -- |
| `style:color={val}` | `style: { color: () => val() }` | -- |
| `<svelte:component>` | `DynamicComponent(() => comp())` | `sibujs` |

---

## Full Example: Todo App Migration

### Svelte Version

```svelte
<!-- TodoApp.svelte -->
<script>
  import { writable, derived } from "svelte/store";
  import { fade } from "svelte/transition";

  let newTodo = "";
  let todos = writable([]);
  let filter = writable("all");

  $: filteredTodos = $todos.filter(todo => {
    if ($filter === "active") return !todo.done;
    if ($filter === "completed") return todo.done;
    return true;
  });

  $: remaining = $todos.filter(t => !t.done).length;

  function addTodo() {
    if (!newTodo.trim()) return;
    $todos = [...$todos, { id: Date.now(), text: newTodo, done: false }];
    newTodo = "";
  }

  function toggle(id) {
    $todos = $todos.map(t =>
      t.id === id ? { ...t, done: !t.done } : t
    );
  }

  function remove(id) {
    $todos = $todos.filter(t => t.id !== id);
  }
</script>

<div class="app">
  <h1>Todos ({remaining} remaining)</h1>

  <form on:submit|preventDefault={addTodo}>
    <input bind:value={newTodo} placeholder="What needs to be done?" />
    <button type="submit">Add</button>
  </form>

  <div class="filters">
    <button class:active={$filter === 'all'} on:click={() => $filter = 'all'}>All</button>
    <button class:active={$filter === 'active'} on:click={() => $filter = 'active'}>Active</button>
    <button class:active={$filter === 'completed'} on:click={() => $filter = 'completed'}>Done</button>
  </div>

  <ul>
    {#each filteredTodos as todo (todo.id)}
      <li transition:fade class:done={todo.done}>
        <input type="checkbox" checked={todo.done} on:change={() => toggle(todo.id)} />
        <span>{todo.text}</span>
        <button on:click={() => remove(todo.id)}>x</button>
      </li>
    {/each}
  </ul>
</div>
```

### SibuJS Version

```ts
// TodoApp.ts
import {
  div, h1, form, input, button, ul, li, span,
  signal, derived, each, mount,
} from "sibujs";

interface Todo {
  id: number;
  text: string;
  done: boolean;
}

function TodoApp() {
  const [newTodo, setNewTodo] = signal("");
  const [todos, setTodos] = signal<Todo[]>([]);
  const [filter, setFilter] = signal<"all" | "active" | "completed">("all");

  const filteredTodos = derived(() =>
    todos().filter(todo => {
      if (filter() === "active") return !todo.done;
      if (filter() === "completed") return todo.done;
      return true;
    })
  );

  const remaining = derived(() =>
    todos().filter(t => !t.done).length
  );

  function addTodo(e: Event) {
    e.preventDefault();
    const text = newTodo().trim();
    if (!text) return;
    setTodos(prev => [...prev, { id: Date.now(), text, done: false }]);
    setNewTodo("");
  }

  function toggle(id: number) {
    setTodos(prev =>
      prev.map(t => (t.id === id ? { ...t, done: !t.done } : t))
    );
  }

  function remove(id: number) {
    setTodos(prev => prev.filter(t => t.id !== id));
  }

  return div("app", [
    h1(() => `Todos (${remaining()} remaining)`),

    form({
      on: { submit: addTodo },
    }, [
      input({
        placeholder: "What needs to be done?",
        value: () => newTodo(),
        on: {
          input: (e) => setNewTodo((e.target as HTMLInputElement).value),
        },
      }),
      button({ type: "submit" }, "Add"),
    ]),

    div("filters", [
      button({
        class: { active: () => filter() === "all" },
        on: { click: () => setFilter("all") },
      }, "All"),
      button({
        class: { active: () => filter() === "active" },
        on: { click: () => setFilter("active") },
      }, "Active"),
      button({
        class: { active: () => filter() === "completed" },
        on: { click: () => setFilter("completed") },
      }, "Done"),
    ]),

    ul([
      each(
        filteredTodos,
        (todo) =>
          li({
            class: { done: () => todo().done },
          }, [
            input({
              type: "checkbox",
              checked: () => todo().done,
              on: { change: () => toggle(todo().id) },
            }),
            span(() => todo().text),
            button({
              on: { click: () => remove(todo().id) },
            }, "x"),
          ]),
        { key: (todo) => todo.id }
      ),
    ]),
  ]);
}

// Mount the app
mount(TodoApp, document.getElementById("app"));
```

---

## Final Notes

### What you gain

- **No compiler dependency.** Your build toolchain is simpler. Hot module replacement, linting, formatting, and code navigation work with standard TypeScript tooling.
- **Full TypeScript safety.** Props, state, computed values, events -- everything is statically typed with no plugin-specific type augmentation.
- **Transparent execution model.** The code you write is the code that runs. No compiler transformations between your source and the output.
- **Explicit reactivity.** You always know what is reactive (wrapped in `() =>`) and what is static (plain values). There is no hidden compiler magic.

### What you trade

- **More verbose templates.** `div([ ... ])` is more characters than `<div>...</div>`. This is the cost of avoiding a compiler.
- **No automatic style scoping.** Use `scopedStyle()` from `sibujs/ui` or external CSS solutions.
- **Manual event modifiers.** No `|preventDefault` shorthand -- call methods directly on the event object.
- **Explicit element references for lifecycle.** `onUnmount` requires you to pass the element, whereas Svelte scopes lifecycle to the component automatically.

Both frameworks share the belief that fine-grained reactivity and direct DOM manipulation produce faster, more predictable UIs than virtual DOM diffing. The difference is in how that belief is expressed: Svelte through a compiler, SibuJS through runtime primitives. Choose the approach that fits your team and project.
