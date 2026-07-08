# Migrating from Vue 3 to SibuJS

This guide helps Vue 3 developers transition to SibuJS. It covers every major concept
with side-by-side comparisons so you can map familiar Vue patterns to their SibuJS
equivalents.

**Key differences at a glance:**

| Concern | Vue 3 | SibuJS |
|---|---|---|
| Rendering | Templates / SFC with compiler | Plain functions returning DOM nodes |
| Reactivity | `ref()`, `reactive()`, `.value` | `signal()` returning `[getter, setter]` |
| VDOM | Yes — diffs & patches | None — direct DOM, surgical updates |
| Re-renders | Entire component re-runs | Only the reactive binding site updates |
| Build step | Required (SFC compiler) | Optional (plain TS/JS works as-is) |

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [Templates to Functions](#2-templates-to-functions)
3. [Reactivity](#3-reactivity)
4. [Directives](#4-directives)
5. [Lifecycle Callbacks](#5-lifecycle-hooks)
6. [Provide / Inject](#6-provide--inject)
7. [Composables](#7-composables)
8. [Routing](#8-routing)
9. [Global State (Pinia to globalStore)](#9-global-state-pinia-to-createglobalstore)
10. [Migration Checklist](#10-migration-checklist)

---

## 1. Introduction

### Why migrate?

SibuJS takes a fundamentally different approach from Vue:

- **No virtual DOM.** Reactive bindings update only the exact DOM nodes that changed.
  There is no diffing pass and no component re-render cycle.
- **No compiler.** Components are plain TypeScript/JavaScript functions. There are no
  `.vue` files, no `<template>` blocks, and no build-time compilation step.
- **No `.value`.** Reactive state is accessed by calling a getter function rather than
  reading a `.value` property. This eliminates the ref-unwrapping confusion that
  plagues Vue's Composition API.
- **Smaller surface area.** The core API is a handful of functions (`signal`,
  `effect`, `derived`, `watch`) plus tag factories for creating elements.

### Install

```bash
npm install sibujs
```

### Import paths

```ts
import { div, signal, effect, mount } from "sibujs";
import { composable, globalStore } from "sibujs/patterns";
import { createRouter, Route, RouterLink } from "sibujs/plugins";
```

---

## 2. Templates to Functions

Vue uses HTML templates (or JSX with a plugin). SibuJS replaces templates with
**tag factory functions** that create real DOM elements directly.

### Basic element

<table>
<tr><th>Vue 3</th><th>SibuJS</th></tr>
<tr>
<td>

```html
<template>
  <div class="card">
    <h2>Title</h2>
    <p>Body text</p>
  </div>
</template>
```

</td>
<td>

```ts
import { div, h2, p } from "sibujs";

function Card() {
  return div("card", [
    h2("Title"),
    p("Body text"),
  ]);
}
```

</td>
</tr>
</table>

Every HTML and SVG tag is available as a pre-built factory (`div`, `span`, `h1`,
`button`, `input`, `svg`, `circle`, etc.). For custom elements, use
`defineElement("my-tag", ...)`.

### Component composition

<table>
<tr><th>Vue 3</th><th>SibuJS</th></tr>
<tr>
<td>

```html
<template>
  <Header />
  <MainContent :title="pageTitle" />
  <Footer />
</template>
```

</td>
<td>

```ts
function App() {
  return div([
    Header(),
    MainContent({ title: "Hello" }),
    Footer(),
  ]);
}
```

</td>
</tr>
</table>

Components in SibuJS are plain functions that return `Element`. Props are a regular
object argument. There is no special component registration step.

### Mounting the application

<table>
<tr><th>Vue 3</th><th>SibuJS</th></tr>
<tr>
<td>

```ts
import { createApp } from "vue";
import App from "./App.vue";

createApp(App).mount("#app");
```

</td>
<td>

```ts
import { mount } from "sibujs";

const { unmount } = mount(
  App,
  document.getElementById("app")
);
```

</td>
</tr>
</table>

`mount` returns an object with an `unmount()` method that removes the element and
cleans up all reactive bindings.

### Dynamic text content

<table>
<tr><th>Vue 3</th><th>SibuJS</th></tr>
<tr>
<td>

```html
<template>
  <span>Hello, {{ name }}</span>
</template>
```

</td>
<td>

```ts
const [name, setName] = signal("World");

span(() => `Hello, ${name()}`);
```

</td>
</tr>
</table>

When a child is a **function**, SibuJS treats it as a reactive binding. The text
node updates automatically whenever `name` changes. When a child is a plain string,
it is static.

### Dynamic attributes

<table>
<tr><th>Vue 3</th><th>SibuJS</th></tr>
<tr>
<td>

```html
<img :src="imageUrl" :alt="altText" />
```

</td>
<td>

```ts
img({
  src: () => imageUrl(),
  alt: () => altText(),
});
```

</td>
</tr>
</table>

Any attribute whose value is a function is treated as a reactive binding and updates
the DOM attribute when its dependencies change.

---

## 3. Reactivity

### ref / signal

<table>
<tr><th>Vue 3</th><th>SibuJS</th></tr>
<tr>
<td>

```ts
import { ref } from "vue";

const count = ref(0);

// Read
console.log(count.value);

// Write
count.value++;
count.value = 10;
```

</td>
<td>

```ts
import { signal } from "sibujs";

const [count, setCount] = signal(0);

// Read (call the getter)
console.log(count());

// Write
setCount(count() + 1);
setCount(10);

// Updater function form
setCount(prev => prev + 1);
```

</td>
</tr>
</table>

`signal<T>(initial)` returns a tuple of `[getter, setter]`. The getter is a
function you **call** to read the value. The setter accepts either a new value or an
updater function `(prev) => next`. Updates are batched with `Object.is` equality
checks to avoid unnecessary notifications.

### reactive / No direct equivalent

Vue's `reactive()` creates a deeply reactive proxy. SibuJS does not have a direct
equivalent. For objects, use `signal` with the whole object, or use `store` for
multi-key reactive state with a proxy interface:

<table>
<tr><th>Vue 3</th><th>SibuJS</th></tr>
<tr>
<td>

```ts
import { reactive } from "vue";

const state = reactive({
  name: "Alice",
  age: 30,
});

state.name = "Bob"; // reactive
```

</td>
<td>

```ts
import { store } from "sibujs";

const [state, { setState }] = store({
  name: "Alice",
  age: 30,
});

// Read (reactive — triggers effects)
console.log(state.name);

// Write via actions
setState({ name: "Bob" });
setState(s => ({ ...s, age: 31 }));
```

</td>
</tr>
</table>

### computed / derived

<table>
<tr><th>Vue 3</th><th>SibuJS</th></tr>
<tr>
<td>

```ts
import { ref, computed } from "vue";

const price = ref(100);
const tax = ref(0.2);

const total = computed(
  () => price.value * (1 + tax.value)
);

console.log(total.value); // 120
```

</td>
<td>

```ts
import { signal, derived } from "sibujs";

const [price, setPrice] = signal(100);
const [tax, setTax] = signal(0.2);

const total = derived(
  () => price() * (1 + tax())
);

console.log(total()); // 120
```

</td>
</tr>
</table>

`derived` returns a **getter function**, not a ref. Call it like `total()` to
read the value. The computed value automatically re-derives when any dependency
changes and only notifies subscribers when the result is different (`Object.is`).

### watchEffect / effect

<table>
<tr><th>Vue 3</th><th>SibuJS</th></tr>
<tr>
<td>

```ts
import { ref, watchEffect } from "vue";

const count = ref(0);

const stop = watchEffect(() => {
  console.log("Count is:", count.value);
});

// Later: stop watching
stop();
```

</td>
<td>

```ts
import { signal, effect } from "sibujs";

const [count, setCount] = signal(0);

const stop = effect(() => {
  console.log("Count is:", count());
});

// Later: stop watching
stop();
```

</td>
</tr>
</table>

`effect` runs the function immediately and automatically tracks all reactive
dependencies read during execution. When any dependency changes, the effect re-runs.
It returns a cleanup function to stop the effect.

### watch / watch

<table>
<tr><th>Vue 3</th><th>SibuJS</th></tr>
<tr>
<td>

```ts
import { ref, watch } from "vue";

const query = ref("");

watch(query, (newVal, oldVal) => {
  console.log(`${oldVal} -> ${newVal}`);
  fetchResults(newVal);
});
```

</td>
<td>

```ts
import { signal, watch } from "sibujs";

const [query, setQuery] = signal("");

const stop = watch(
  () => query(),
  (newVal, oldVal) => {
    console.log(`${oldVal} -> ${newVal}`);
    fetchResults(newVal);
  }
);
```

</td>
</tr>
</table>

`watch` takes an explicit getter function as the first argument (rather than a ref
directly). The callback receives `(newValue, previousValue)`. It returns a teardown
function to cancel the watcher.

### Batching updates

<table>
<tr><th>Vue 3</th><th>SibuJS</th></tr>
<tr>
<td>

```ts
// Vue batches updates automatically
// within the same tick via nextTick
count.value = 1;
name.value = "Bob";
// One render pass
```

</td>
<td>

```ts
import { batch } from "sibujs";

batch(() => {
  setCount(1);
  setName("Bob");
});
// One notification pass
```

</td>
</tr>
</table>

`batch()` defers all subscriber notifications until the batch function completes.
Batches can be nested; only the outermost batch triggers notifications.

---

## 4. Directives

Vue uses template directives (`v-if`, `v-show`, `v-for`, `v-model`, `v-bind`).
SibuJS replaces these with plain function calls.

### v-if / when

<table>
<tr><th>Vue 3</th><th>SibuJS</th></tr>
<tr>
<td>

```html
<template>
  <div v-if="isLoggedIn">
    Welcome back!
  </div>
  <div v-else>
    Please log in.
  </div>
</template>
```

</td>
<td>

```ts
import { when } from "sibujs";

when(
  () => isLoggedIn(),
  () => div("Welcome back!"),
  () => div("Please log in.")
);
```

</td>
</tr>
</table>

`when(condition, thenFn, elseFn?)` returns a comment node anchor. When the condition
changes, the previous branch is removed and the new branch is inserted. The element
is **destroyed and recreated** on each toggle (true conditional rendering, not just
hiding).

### v-show / show

<table>
<tr><th>Vue 3</th><th>SibuJS</th></tr>
<tr>
<td>

```html
<div v-show="isVisible">
  I toggle display
</div>
```

</td>
<td>

```ts
import { show } from "sibujs";

show(
  () => isVisible(),
  div("I toggle display")
);
```

</td>
</tr>
</table>

`show(condition, element)` toggles `display: none` on the element. The element is
always in the DOM; only its visibility changes. This is more efficient than `when`
when toggling frequently.

### v-for / each

<table>
<tr><th>Vue 3</th><th>SibuJS</th></tr>
<tr>
<td>

```html
<template>
  <ul>
    <li v-for="item in items" :key="item.id">
      {{ item.name }}
    </li>
  </ul>
</template>
```

</td>
<td>

```ts
import { ul, li, each } from "sibujs";

ul([
  each(
    () => items(),
    (item, index) =>
      li(() => item().name),
    { key: item => item.id }
  ),
]);
```

</td>
</tr>
</table>

`each(getArray, renderFn, { key })` returns an anchor comment node and efficiently
reconciles the list using keyed diffing with LIS (longest increasing subsequence)
optimization. The `key` function must return a unique `string | number` for each item.

### v-model / Manual binding

<table>
<tr><th>Vue 3</th><th>SibuJS</th></tr>
<tr>
<td>

```html
<template>
  <input v-model="name" />
  <p>Hello, {{ name }}</p>
</template>

<script setup>
import { ref } from "vue";
const name = ref("");
</script>
```

</td>
<td>

```ts
import { signal, input, p } from "sibujs";

const [name, setName] = signal("");

div([
  input({
    value: () => name(),
    on: {
      input: (e) =>
        setName(
          (e.target as HTMLInputElement).value
        ),
    },
  }),
  p(() => `Hello, ${name()}`),
]);
```

</td>
</tr>
</table>

SibuJS has no `v-model` equivalent. Instead, bind the `value` attribute reactively
and listen for `input` events via the `on` prop. For comprehensive form handling with
validation, use `form` from `sibujs/ui`:

```ts
import { form, required, email } from "sibujs/ui";

const { fields, handleSubmit, isValid } = form({
  name: { initial: "", validators: [required()] },
  email: { initial: "", validators: [required(), email()] },
});

form({
  on: { submit: handleSubmit((values) => save(values)) },
}, [
  input({
    value: () => fields.name.value(),
    on: {
      input: (e) => fields.name.set((e.target as HTMLInputElement).value),
      blur: () => fields.name.touch(),
    },
  }),
  when(
    () => fields.name.touched() && fields.name.error() !== null,
    () => span("error", () => fields.name.error())
  ),
]);
```

### v-bind:class / Class binding

<table>
<tr><th>Vue 3</th><th>SibuJS</th></tr>
<tr>
<td>

```html
<!-- Dynamic string -->
<div :class="activeClass"></div>

<!-- Object syntax -->
<div :class="{ active: isActive, bold: isBold }"></div>

<!-- Array syntax -->
<div :class="[baseClass, { active: isActive }]"></div>
```

</td>
<td>

```ts
// Reactive string
div({ class: () => activeClass() });

// Object syntax (values can be boolean or () => boolean)
div({
  class: {
    active: () => isActive(),
    bold: () => isBold(),
  },
});

// Reactive string for array-like merging
div({
  class: () =>
    `${baseClass()} ${isActive() ? "active" : ""}`,
});
```

</td>
</tr>
</table>

The `class` prop accepts three forms:
1. **Static string:** `class: "card"`
2. **Reactive string:** `class: () => dynamicClass()`
3. **Conditional object:** `class: { name: boolean | (() => boolean) }`

### v-bind:style / Style binding

<table>
<tr><th>Vue 3</th><th>SibuJS</th></tr>
<tr>
<td>

```html
<div :style="{ color: textColor, fontSize: size + 'px' }"></div>
```

</td>
<td>

```ts
div({
  style: {
    color: () => textColor(),
    fontSize: () => `${size()}px`,
  },
});
```

</td>
</tr>
</table>

The `style` prop accepts an object where each value can be static or a reactive
getter function. Property names use camelCase and are converted to kebab-case
automatically.

### v-on / Event handling

<table>
<tr><th>Vue 3</th><th>SibuJS</th></tr>
<tr>
<td>

```html
<button @click="handleClick">
  Click me
</button>

<input @keyup.enter="submit" />
```

</td>
<td>

```ts
button({
  on: { click: handleClick },
}, "Click me");

input({
  on: {
    keyup: (e) => {
      if ((e as KeyboardEvent).key === "Enter") {
        submit();
      }
    },
  },
});
```

</td>
</tr>
</table>

Event handlers are passed via the `on` prop as an object of `{ eventName: handler }`.
There are no key modifiers — use standard DOM event checks in the handler.

### Pattern matching (bonus)

SibuJS includes a `match` directive that has no direct Vue equivalent:

```ts
import { match } from "sibujs";

match(
  () => status(),
  {
    loading: () => Spinner(),
    error:   () => ErrorMessage(),
    success: () => Content(),
  },
  () => div("Unknown status") // fallback
);
```

---

## 5. Lifecycle Callbacks

<table>
<tr><th>Vue 3</th><th>SibuJS</th></tr>
<tr>
<td>

```ts
import {
  onMounted,
  onUnmounted,
} from "vue";

onMounted(() => {
  console.log("Mounted");
  startTimer();
});

onUnmounted(() => {
  console.log("Unmounted");
  stopTimer();
});
```

</td>
<td>

```ts
import { onMount, onUnmount } from "sibujs";

function MyComponent() {
  const el = div("Hello");

  onMount(() => {
    console.log("Mounted");
    startTimer();
  }, el);

  onUnmount(() => {
    console.log("Unmounted");
    stopTimer();
  }, el);

  return el;
}
```

</td>
</tr>
</table>

| Vue 3 | SibuJS | Notes |
|---|---|---|
| `onMounted` | `onMount(callback, element?)` | Runs after the element is in the DOM |
| `onUnmounted` | `onUnmount(callback, element)` | Runs when the element is removed |
| `onBeforeMount` | No equivalent | Not needed (function body runs before mount) |
| `onBeforeUnmount` | No equivalent | Use `onUnmount` |
| `onUpdated` | `effect` | Effects re-run when dependencies change |
| `nextTick` | `queueMicrotask` | Standard browser API |

`onMount` can be called without an element argument, in which case it simply defers
execution via `queueMicrotask` (runs after the current synchronous rendering pass).

When an element is passed, `onMount` uses a `MutationObserver` to detect when the
element enters the DOM, and `onUnmount` watches for its removal.

### Template refs / ref

<table>
<tr><th>Vue 3</th><th>SibuJS</th></tr>
<tr>
<td>

```html
<template>
  <input ref="inputEl" />
</template>

<script setup>
import { ref, onMounted } from "vue";

const inputEl = ref<HTMLInputElement>();

onMounted(() => {
  inputEl.value?.focus();
});
</script>
```

</td>
<td>

```ts
import { ref, input, onMount } from "sibujs";

function MyComponent() {
  const inputRef = ref<HTMLInputElement>();

  const el = input({ ref: inputRef });

  onMount(() => {
    inputRef.current?.focus();
  });

  return el;
}
```

</td>
</tr>
</table>

`ref<T>(initial?)` returns `{ current: T }`. Pass it as the `ref` prop on a tag
factory call, and the element is assigned to `ref.current` after creation.

---

## 6. Provide / Inject

<table>
<tr><th>Vue 3</th><th>SibuJS</th></tr>
<tr>
<td>

```ts
// Parent
import { provide, ref } from "vue";

const theme = ref("light");
provide("theme", theme);

// Child
import { inject } from "vue";

const theme = inject("theme");
console.log(theme.value); // "light"
```

</td>
<td>

```ts
// Create context (typically in a shared module)
import { context } from "sibujs";

const ThemeContext = context("light");

// Parent — provide a value
function App() {
  ThemeContext.provide("dark");

  return div([Child()]);
}

// Child — consume the value
function Child() {
  const theme = ThemeContext.use(); // reactive getter

  return div(() => `Theme: ${theme()}`);
}
```

</td>
</tr>
</table>

`context<T>(defaultValue)` returns a `Context` object with four methods:

| Method | Description |
|---|---|
| `provide(value)` | Sets the context value |
| `use()` | Returns a reactive getter `() => T` |
| `get()` | Returns the current value directly (non-reactive) |
| `set(value)` | Updates the value reactively (same as `provide`) |

Unlike Vue's string-keyed `provide/inject`, SibuJS contexts are typed objects.
There is no risk of key collisions, and TypeScript infers the value type
automatically.

---

## 7. Composables

Vue 3 composables are functions that use the Composition API and return reactive
state. SibuJS composables follow the same pattern, wrapped in `composable`.

<table>
<tr><th>Vue 3</th><th>SibuJS</th></tr>
<tr>
<td>

```ts
// useCounter.ts
import { ref, computed } from "vue";

export function useCounter(initial = 0) {
  const count = ref(initial);
  const doubled = computed(
    () => count.value * 2
  );

  function increment() {
    count.value++;
  }

  function decrement() {
    count.value--;
  }

  return { count, doubled, increment, decrement };
}
```

</td>
<td>

```ts
// counterSetup.ts
import { signal, derived } from "sibujs";
import { composable } from "sibujs/patterns";

export const counterSetup = composable(() => {
  const [count, setCount] = signal(0);
  const doubled = derived(() => count() * 2);

  function increment() {
    setCount(c => c + 1);
  }

  function decrement() {
    setCount(c => c - 1);
  }

  return { count, doubled, increment, decrement };
});
```

</td>
</tr>
</table>

### Using a composable

<table>
<tr><th>Vue 3</th><th>SibuJS</th></tr>
<tr>
<td>

```html
<template>
  <p>Count: {{ count }}</p>
  <p>Doubled: {{ doubled }}</p>
  <button @click="increment">+</button>
</template>

<script setup>
import { useCounter } from "./useCounter";

const { count, doubled, increment } =
  useCounter();
</script>
```

</td>
<td>

```ts
import { counterSetup } from "./counterSetup";
import { div, p, button } from "sibujs";

function Counter() {
  const { count, doubled, increment } =
    counterSetup();

  return div([
    p(() => `Count: ${count()}`),
    p(() => `Doubled: ${doubled()}`),
    button({
      on: { click: increment },
    }, "+"),
  ]);
}
```

</td>
</tr>
</table>

`composable(setupFn)` simply returns the setup function itself. It serves as
a semantic marker that the function encapsulates reusable reactive logic.

---

## 8. Routing

### Router setup

<table>
<tr><th>Vue 3 (Vue Router)</th><th>SibuJS</th></tr>
<tr>
<td>

```ts
import { createRouter, createWebHistory } from "vue-router";
import Home from "./views/Home.vue";
import About from "./views/About.vue";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", component: Home },
    { path: "/about", component: About },
    {
      path: "/user/:id",
      component: () => import("./views/User.vue"),
    },
  ],
});

app.use(router);
```

</td>
<td>

```ts
import {
  createRouter,
  Route,
} from "sibujs/plugins";

const router = createRouter(
  [
    { path: "/", component: Home },
    { path: "/about", component: About },
    {
      path: "/user/:id",
      component: () => import("./views/User"),
    },
  ],
  { mode: "history" }
);
```

</td>
</tr>
</table>

### Router outlet

<table>
<tr><th>Vue 3</th><th>SibuJS</th></tr>
<tr>
<td>

```html
<template>
  <nav>...</nav>
  <router-view />
</template>
```

</td>
<td>

```ts
import { Route } from "sibujs/plugins";

function App() {
  return div([
    Nav(),
    route(), // renders the matched component
  ]);
}
```

</td>
</tr>
</table>

`route()` is the SibuJS equivalent of `<router-view>`. It renders the component
matched by the current URL. For nested routes, use `Outlet()` inside parent route
components.

### Navigation

<table>
<tr><th>Vue 3</th><th>SibuJS</th></tr>
<tr>
<td>

```ts
import { router } from "vue-router";

const router = router();
router.push("/about");
router.replace("/login");
router.go(-1);
```

```html
<router-link to="/about">About</router-link>
```

</td>
<td>

```ts
import {
  router,
  push,
  replace,
  back,
  RouterLink,
} from "sibujs/plugins";

// Imperative navigation
push("/about");
replace("/login");
back();

// Or via router()
const router = router();
router.push("/about");
```

```ts
// Declarative link
RouterLink({
  to: "/about",
  nodes: "About",
});
```

</td>
</tr>
</table>

### Accessing route params

<table>
<tr><th>Vue 3</th><th>SibuJS</th></tr>
<tr>
<td>

```ts
import { route } from "vue-router";

const route = route();
console.log(route.params.id);
console.log(route.query.search);
```

</td>
<td>

```ts
import { route, routerState } from "sibujs/plugins";

const route = route();
console.log(route.params.id);
console.log(route.query.search);

// Or use reactive getters
const state = routerState();
// state.currentPath() — reactive getter
// state.params() — reactive getter
```

</td>
</tr>
</table>

### Navigation guards

<table>
<tr><th>Vue 3</th><th>SibuJS</th></tr>
<tr>
<td>

```ts
router.beforeEach((to, from, next) => {
  if (to.meta.requiresAuth && !isLoggedIn) {
    next("/login");
  } else {
    next();
  }
});
```

</td>
<td>

```ts
import { beforeEach } from "sibujs/plugins";

const removeGuard = beforeEach((to, from, next) => {
  if (to.meta.requiresAuth && !isLoggedIn) {
    next("/login");
  } else {
    next();
  }
});

// Later: removeGuard() to unregister
```

</td>
</tr>
</table>

### Per-route guards

<table>
<tr><th>Vue 3</th><th>SibuJS</th></tr>
<tr>
<td>

```ts
{
  path: "/admin",
  component: Admin,
  beforeEnter: (to, from) => {
    if (!isAdmin) return "/login";
  },
}
```

</td>
<td>

```ts
{
  path: "/admin",
  component: Admin,
  beforeEnter: (to) => {
    if (!isAdmin) return "/login";
    return true;
  },
}
```

</td>
</tr>
</table>

---

## 9. Global State (Pinia to globalStore)

### Store definition

<table>
<tr><th>Vue 3 (Pinia)</th><th>SibuJS</th></tr>
<tr>
<td>

```ts
import { defineStore } from "pinia";

export const useCounterStore = defineStore(
  "counter",
  {
    state: () => ({
      count: 0,
      name: "Counter",
    }),
    getters: {
      doubleCount: (state) => state.count * 2,
    },
    actions: {
      increment() {
        this.count++;
      },
      setName(name: string) {
        this.name = name;
      },
    },
  }
);
```

</td>
<td>

```ts
import { globalStore } from "sibujs/patterns";

export const counterStore = globalStore({
  state: {
    count: 0,
    name: "Counter",
  },
  actions: {
    increment: (state) => ({
      count: state.count + 1,
    }),
    setName: (state, name: string) => ({
      name,
    }),
  },
});
```

</td>
</tr>
</table>

### Using the store

<table>
<tr><th>Vue 3 (Pinia)</th><th>SibuJS</th></tr>
<tr>
<td>

```html
<template>
  <p>{{ store.count }}</p>
  <p>{{ store.doubleCount }}</p>
  <button @click="store.increment()">+</button>
</template>

<script setup>
import { useCounterStore } from "./stores/counter";

const store = useCounterStore();
</script>
```

</td>
<td>

```ts
import { counterStore } from "./stores/counter";
import { div, p, button } from "sibujs";

function Counter() {
  const count = counterStore.select(s => s.count);
  const doubled = counterStore.select(s => s.count * 2);

  return div([
    p(() => `${count()}`),
    p(() => `${doubled()}`),
    button({
      on: {
        click: () =>
          counterStore.dispatch("increment"),
      },
    }, "+"),
  ]);
}
```

</td>
</tr>
</table>

### Key differences from Pinia

| Pinia | SibuJS `globalStore` |
|---|---|
| `state()` returns initial state | `state` is a plain object |
| Getters are cached computed properties | Use `select(selector)` to create computed selectors |
| Actions mutate `this` directly | Actions receive `(state, payload?)` and return a partial state patch |
| DevTools integration built-in | Middleware support for logging, devtools, etc. |
| `store.$reset()` | `store.reset()` |
| `store.$subscribe(callback)` | `store.subscribe(callback)` |

### Middleware

SibuJS stores support middleware for cross-cutting concerns like logging:

```ts
const store = globalStore({
  state: { count: 0 },
  actions: {
    increment: (state) => ({ count: state.count + 1 }),
  },
  middleware: [
    (state, action, payload, next) => {
      console.log(`[${action}]`, payload, state);
      next(); // call next() to continue the chain
    },
  ],
});
```

---

## 10. Migration Checklist

Use this checklist to track your progress when migrating a Vue 3 application to
SibuJS.

### Setup

- [ ] Install `sibujs` and remove `vue`, `@vue/compiler-sfc`, and related packages
- [ ] Remove Vue-specific build plugins (`@vitejs/plugin-vue`, etc.)
- [ ] Update `tsconfig.json` — remove `"jsx": "preserve"` if set; no JSX config needed
- [ ] Replace `createApp(...).mount(...)` with `mount(App, document.getElementById("app"))`

### Templates to Functions

- [ ] Convert all `.vue` SFC files to `.ts` / `.js` files
- [ ] Replace `<template>` blocks with tag factory function calls (`div`, `span`, etc.)
- [ ] Replace `<script setup>` with plain function components
- [ ] Replace template interpolation `{{ expr }}` with a reactive child `() => expr`
- [ ] Replace `:attr="expr"` dynamic bindings with `attr: () => expr`
- [ ] Replace `@event="handler"` with `on: { event: handler }`

### Reactivity

- [ ] Replace `ref(x)` with `signal(x)` — change all `.value` reads to `getter()` calls
- [ ] Replace `reactive({...})` with `store({...})` or multiple `signal` calls
- [ ] Replace `computed(() => ...)` with `derived(() => ...)` — access via `fn()` not `.value`
- [ ] Replace `watchEffect(() => ...)` with `effect(() => ...)`
- [ ] Replace `watch(source, cb)` with `watch(() => source(), cb)`
- [ ] Replace `toRef` / `toRefs` — not needed; destructure from `signal` or `store`
- [ ] Replace `shallowRef` / `triggerRef` — use `signal` (already shallow by default)
- [ ] Wrap bulk updates in `batch(() => { ... })` where needed

### Directives

- [ ] Replace `v-if` / `v-else` with `when(condition, thenFn, elseFn)`
- [ ] Replace `v-show` with `show(condition, element)`
- [ ] Replace `v-for` with `each(getArray, renderFn, { key })`
- [ ] Replace `v-model` with manual `value` + `on: { input }` bindings
- [ ] Replace `v-bind:class` object/array syntax with `class: { ... }` or `class: () => ...`
- [ ] Replace `v-bind:style` with `style: { prop: () => value }` object syntax
- [ ] Remove `v-once` — not needed (static values are static by default)
- [ ] Remove `v-memo` — not needed (no VDOM re-renders to optimize)
- [ ] Replace `v-html` with manual `innerHTML` assignment via `onMount`

### Lifecycle

- [ ] Replace `onMounted` with `onMount`
- [ ] Replace `onUnmounted` with `onUnmount`
- [ ] Replace `onUpdated` with `effect` (runs on dependency change)
- [ ] Replace `nextTick` with `queueMicrotask`
- [ ] Remove `onBeforeMount` / `onBeforeUnmount` — use the function body or `onUnmount`

### Provide / Inject

- [ ] Replace `provide("key", value)` + `inject("key")` with `context(default)`
- [ ] Call `context.provide(value)` in the parent
- [ ] Call `context.use()` in children to get a reactive getter

### Composables

- [ ] Wrap composable functions in `composable(setupFn)` from `sibujs/patterns`
- [ ] Update internal logic to use SibuJS reactivity (`signal`, `effect`, etc.)
- [ ] Return getter functions instead of refs

### Routing

- [ ] Replace `vue-router` with `sibujs/plugins` router
- [ ] Replace `createRouter({ history, routes })` with `createRouter(routes, { mode })`
- [ ] Replace `<router-view />` with `route()`
- [ ] Replace `<router-link>` with `RouterLink({ to, nodes })`
- [ ] Replace `router()` / `route()` — same names, import from `sibujs/plugins`
- [ ] Migrate navigation guards (`beforeEach`, `beforeEnter`, `afterEach`)
- [ ] For nested routes, replace child `<router-view>` with `Outlet()`

### Global State

- [ ] Replace Pinia `defineStore` with `globalStore` from `sibujs/patterns`
- [ ] Convert getters to `store.select(selector)` calls
- [ ] Convert actions from `this`-mutation to `(state, payload?) => Partial<State>` pure functions
- [ ] Replace `store.$subscribe` with `store.subscribe`
- [ ] Replace `store.$reset` with `store.reset`
- [ ] Add middleware for logging / devtools if needed

### Cleanup

- [ ] Remove all `.vue` files
- [ ] Remove Vue devtools browser extension (install SibuJS devtools if available)
- [ ] Remove `pinia` package if migrated to `globalStore`
- [ ] Remove `vue-router` package if migrated to `sibujs/plugins`
- [ ] Run the full test suite and fix any remaining issues
- [ ] Verify that HMR works correctly with your build tool
