# Migration Guide: React to SibuJS

This guide walks through every major concept in React and shows its SibuJS equivalent with practical, side-by-side code examples. SibuJS is a fine-grained reactive framework with **no virtual DOM** and **no re-renders** — only the specific DOM bindings that depend on changed state are updated.

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [Setup & Mounting](#2-setup--mounting)
3. [Component Model](#3-component-model)
4. [State Management](#4-state-management)
5. [Effects & Side Effects](#5-effects--side-effects)
6. [Computed / Derived Values](#6-computed--derived-values)
7. [Watchers](#7-watchers)
8. [Conditional Rendering](#8-conditional-rendering)
9. [List Rendering](#9-list-rendering)
10. [Context & Dependency Injection](#10-context--dependency-injection)
11. [Refs](#11-refs)
12. [Lifecycle Callbacks](#12-lifecycle-hooks)
13. [Forms](#13-forms)
14. [Multi-Key Stores](#14-multi-key-stores)
15. [Routing](#15-routing)
16. [Internationalization (i18n)](#16-internationalization-i18n)
17. [Code Splitting & Lazy Loading](#17-code-splitting--lazy-loading)
18. [Migration Checklist](#18-migration-checklist)

---

## 1. Introduction

### Key Differences at a Glance

| Concept | React | SibuJS |
|---|---|---|
| Rendering | Virtual DOM diffing, full component re-renders | Direct DOM, fine-grained reactive bindings |
| Templating | JSX (compiled to `createElement` calls) | Tag factory functions (`div()`, `span()`, etc.) |
| State getter | Value is accessed directly: `count` | Getter is a function you call: `count()` |
| State setter | `setCount(5)` or `setCount(prev => prev + 1)` | Same: `setCount(5)` or `setCount(prev => prev + 1)` |
| Effects | Manual dependency array: `useEffect(fn, [dep])` | Auto-tracked dependencies: `effect(fn)` |
| Memoization | `useMemo(fn, [deps])` | `derived(fn)` — auto-tracked |
| Conditionals | Ternaries / `&&` inside JSX | `when(condition, thenFn, elseFn)` or `show(condition, el)` |
| Lists | `.map()` with `key` prop | `each(getArray, render, { key })` |
| Build step | Required (JSX transform) | Optional (plain JS/TS, no compilation needed) |

### Mental Model Shift

In React, a component function re-runs on every state change and the VDOM diff determines what actually changes in the DOM. In SibuJS, a component function runs **exactly once** to set up the DOM and reactive bindings. After that, only the specific text nodes, attributes, or style properties that read a signal are updated when that signal changes. There are no re-renders.

---

## 2. Setup & Mounting

### React

```jsx
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

const root = ReactDOM.createRoot(
  document.getElementById("root")
);
root.render(<App />);
```

### SibuJS

```ts
import { mount } from "sibujs";
import { App } from "./App";

const { node, unmount } = mount(
  App,
  document.getElementById("root")
);

// Later, to tear down:
unmount();
```

**Key differences:**
- `mount()` returns an object with `node` (the mounted DOM node) and `unmount` (a cleanup function that removes the node and disposes all reactive bindings).
- No `StrictMode`, no concurrent features — SibuJS runs synchronously with fine-grained updates.

---

## 3. Component Model

In React, components are functions that return JSX and re-run on every update. In SibuJS, components are functions that return a DOM `Element` and run **once**.

### React

```jsx
function Greeting({ name }) {
  return (
    <div className="greeting">
      <h1>Hello, {name}!</h1>
      <p>Welcome to the app.</p>
    </div>
  );
}

// Usage
<Greeting name="Alice" />
```

### SibuJS

```ts
import { div, h1, p } from "sibujs";

function Greeting({ name }: { name: string }) {
  return div("greeting", [
    h1(`Hello, ${name}!`),
    p("Welcome to the app."),
  ]);
}

// Usage
Greeting({ name: "Alice" })
```

**Key differences:**
- No JSX. Use tag factory functions: `div()`, `h1()`, `span()`, `button()`, etc.
- Props are a plain object: `{ class, style, on, ref, ...attrs }`.
- Use `class` not `className`. Use `for` not `htmlFor`.
- Children are passed positionally: `tag(children)` or `tag(props, children)`. A child can be a string, number, Node, array of these, or a reactive function.
- Event handlers go under the `on` key: `on: { click: handler }`.

### Nesting and Composition

#### React

```jsx
function Card({ title, children }) {
  return (
    <div className="card">
      <h2>{title}</h2>
      <div className="card-body">{children}</div>
    </div>
  );
}

<Card title="My Card">
  <p>Card content here</p>
</Card>
```

#### SibuJS

```ts
import { div, h2 } from "sibujs";

function Card({ title }: { title: string }, children: any) {
  return div("card", [
    h2(title),
    div("card-body", children),
  ]);
}

Card({ title: "My Card" }, p("Card content here"))
```

---

## 4. State Management

### Basic State

#### React

```jsx
import { useState } from "react";

function Counter() {
  const [count, setCount] = useState(0);

  return (
    <div>
      <p>Count: {count}</p>
      <button onClick={() => setCount(count + 1)}>
        Increment
      </button>
      <button onClick={() => setCount(prev => prev - 1)}>
        Decrement
      </button>
    </div>
  );
}
```

#### SibuJS

```ts
import { signal, div, p, button } from "sibujs";

function Counter() {
  const [count, setCount] = signal(0);

  return div([
    p(() => `Count: ${count()}`),
    button({
      on: { click: () => setCount(count() + 1) },
    }, "Increment"),
    button({
      on: { click: () => setCount(prev => prev - 1) },
    }, "Decrement"),
  ]);
}
```

**Critical difference — getter is a function:**

| React | SibuJS |
|---|---|
| `count` (direct value) | `count()` (call the getter) |
| `setCount(5)` | `setCount(5)` (same) |
| `setCount(prev => prev + 1)` | `setCount(prev => prev + 1)` (same) |

**Why is the getter a function?** Because SibuJS uses fine-grained reactivity. When you write `() => count()` as a child, SibuJS tracks that this text node depends on `count`. When `count` changes, only that text node updates — not the entire component.

### Reactive Nodes vs. Static Nodes

```ts
// REACTIVE — updates when count changes
p(() => `Count: ${count()}`)

// STATIC — captures value at creation time, never updates
p(`Count: ${count()}`)
```

When you want the DOM to update in response to state changes, wrap the expression in a function: `() => ...`. This is the fundamental pattern that replaces React's re-render model.

---

## 5. Effects & Side Effects

### React

```jsx
import { useState, useEffect } from "react";

function Timer() {
  const [seconds, setSeconds] = useState(0);

  useEffect(() => {
    const id = setInterval(() => {
      setSeconds(s => s + 1);
    }, 1000);

    return () => clearInterval(id); // cleanup
  }, []); // empty deps = run once

  useEffect(() => {
    document.title = `${seconds}s elapsed`;
  }, [seconds]); // re-run when seconds changes

  return <p>{seconds}s</p>;
}
```

### SibuJS

```ts
import { signal, effect, p } from "sibujs";

function Timer() {
  const [seconds, setSeconds] = signal(0);

  // Run once — no reactive signals read, so never re-runs
  const cleanup = effect(() => {
    const id = setInterval(() => {
      setSeconds(s => s + 1);
    }, 1000);
    // Note: effect does not support return-based cleanup.
    // Use onUnmount for teardown, or call the returned cleanup.
  });

  // Auto-tracks `seconds` — re-runs whenever seconds changes
  effect(() => {
    document.title = `${seconds()}s elapsed`;
  });

  return p(() => `${seconds()}s`);
}
```

**Key differences:**

| React | SibuJS |
|---|---|
| `useEffect(fn, [])` — empty deps, run once | `effect(fn)` — if `fn` reads no signals, it runs once |
| `useEffect(fn, [a, b])` — manual deps | `effect(fn)` — deps auto-tracked from signal reads |
| Returns cleanup inside the effect | Returns a cleanup function from the call itself |
| Stale closure pitfalls | No stale closures — getters always return current value |

**No dependency arrays.** SibuJS auto-tracks which signals are read inside the effect function. When any of those signals change, the effect re-runs. This eliminates an entire class of React bugs (missing deps, stale closures, infinite loops).

---

## 6. Computed / Derived Values

### React

```jsx
import { useState, useMemo } from "react";

function ShoppingCart({ items }) {
  const [taxRate] = useState(0.08);

  const subtotal = useMemo(
    () => items.reduce((sum, i) => sum + i.price, 0),
    [items]
  );

  const total = useMemo(
    () => subtotal * (1 + taxRate),
    [subtotal, taxRate]
  );

  return (
    <div>
      <p>Subtotal: ${subtotal.toFixed(2)}</p>
      <p>Total: ${total.toFixed(2)}</p>
    </div>
  );
}
```

### SibuJS

```ts
import { signal, derived, div, p } from "sibujs";

function ShoppingCart({ getItems }: { getItems: () => Item[] }) {
  const [taxRate] = signal(0.08);

  const subtotal = derived(
    () => getItems().reduce((sum, i) => sum + i.price, 0)
  );

  const total = derived(
    () => subtotal() * (1 + taxRate())
  );

  return div([
    p(() => `Subtotal: $${subtotal().toFixed(2)}`),
    p(() => `Total: $${total().toFixed(2)}`),
  ]);
}
```

**Key differences:**
- `derived(fn)` returns a reactive getter function (not a plain value).
- No dependency array — deps are auto-tracked.
- Computed values are themselves reactive signals: other computeds and effects can depend on them.
- Like `memo`, the computed only recalculates when its dependencies actually change (using `Object.is` comparison).

---

## 7. Watchers

React has no direct equivalent of `watch`. The closest pattern is a `effect` that compares previous and current values.

### React

```jsx
import { useState, useEffect, useRef } from "react";

function PriceTracker({ price }) {
  const prevPrice = useRef(price);

  useEffect(() => {
    if (prevPrice.current !== price) {
      console.log(
        `Price changed: ${prevPrice.current} -> ${price}`
      );
      prevPrice.current = price;
    }
  }, [price]);

  return <p>Current price: ${price}</p>;
}
```

### SibuJS

```ts
import { signal, watch, p } from "sibujs";

function PriceTracker() {
  const [price, setPrice] = signal(29.99);

  // Watches price and fires callback with (newValue, oldValue)
  const stopWatching = watch(
    () => price(),
    (newPrice, oldPrice) => {
      console.log(`Price changed: ${oldPrice} -> ${newPrice}`);
    }
  );

  return p(() => `Current price: $${price()}`);
}
```

**Key differences:**
- `watch(getter, callback)` is a dedicated primitive — no boilerplate with refs.
- Callback receives `(newValue, oldValue)` automatically.
- Returns a teardown function to stop watching.
- The getter is auto-tracked, so it re-evaluates when any signal it reads changes.

---

## 8. Conditional Rendering

### React

```jsx
function AuthStatus({ isLoggedIn }) {
  return (
    <div>
      {isLoggedIn ? (
        <p>Welcome back!</p>
      ) : (
        <p>Please log in.</p>
      )}
      {isLoggedIn && <button>Logout</button>}
    </div>
  );
}
```

### SibuJS — `when()` (mount/unmount)

`when()` fully creates or destroys DOM nodes based on the condition.

```ts
import { signal, div, p, button, when } from "sibujs";

function AuthStatus() {
  const [isLoggedIn, setLoggedIn] = signal(false);

  return div([
    when(
      () => isLoggedIn(),
      () => p("Welcome back!"),
      () => p("Please log in.")
    ),
    when(
      () => isLoggedIn(),
      () => button({
        on: { click: () => setLoggedIn(false) },
      }, "Logout")
    ),
  ]);
}
```

### SibuJS — `show()` (CSS display toggle)

`show()` keeps the element in the DOM and toggles `display: none`. Use this when the element is expensive to recreate or you want to preserve its internal state.

```ts
import { signal, div, button, span, show } from "sibujs";

function Tooltip() {
  const [visible, setVisible] = signal(false);

  return div([
    button({
      on: {
        mouseenter: () => setVisible(true),
        mouseleave: () => setVisible(false),
      },
    }, "Hover me"),
    show(
      () => visible(),
      span("I am a tooltip!")
    ),
  ]);
}
```

### SibuJS — `match()` (pattern matching)

`match()` is like a reactive switch statement — ideal for status-based rendering.

```ts
import { signal, match, div } from "sibujs";

function StatusDisplay() {
  const [status, setStatus] = signal<string>("loading");

  return div([
    match(
      () => status(),
      {
        loading: () => div("Loading..."),
        error: () => div("error", "Something went wrong."),
        success: () => div("Data loaded!"),
      },
      () => div("Unknown status") // fallback
    ),
  ]);
}
```

**Summary of conditional primitives:**

| Primitive | Behavior | React Equivalent |
|---|---|---|
| `when(cond, then, else)` | Creates/destroys DOM nodes | `{cond ? <A/> : <B/>}` |
| `show(cond, element)` | Toggles `display: none` | `style={{ display: cond ? '' : 'none' }}` |
| `match(value, cases, fallback)` | Reactive switch/case | Nested ternaries or switch in render |

---

## 9. List Rendering

### React

```jsx
function TodoList({ todos }) {
  return (
    <ul>
      {todos.map(todo => (
        <li key={todo.id}>{todo.text}</li>
      ))}
    </ul>
  );
}
```

### SibuJS

```ts
import { signal, ul, li, each } from "sibujs";

function TodoList() {
  const [todos, setTodos] = signal([
    { id: 1, text: "Learn SibuJS" },
    { id: 2, text: "Build an app" },
  ]);

  return ul([
    each(
      () => todos(),
      (todo, index) => li(todo().text),
      { key: (todo) => todo.id }
    ),
  ]);
}
```

**Key differences:**
- `each(getArray, render, { key })` takes a reactive getter for the array, not a static array.
- The `key` option is a function that extracts a unique identifier from each item.
- Uses LIS (Longest Increasing Subsequence) algorithm for efficient reordering with minimal DOM moves.
- Items are created once and reused when keys match — no re-rendering of unchanged items.

### Dynamic List with Add/Remove

#### React

```jsx
import { useState } from "react";

function TaskList() {
  const [tasks, setTasks] = useState([]);
  const [input, setInput] = useState("");

  const addTask = () => {
    setTasks([...tasks, { id: Date.now(), text: input }]);
    setInput("");
  };

  const removeTask = (id) => {
    setTasks(tasks.filter(t => t.id !== id));
  };

  return (
    <div>
      <input
        value={input}
        onChange={e => setInput(e.target.value)}
      />
      <button onClick={addTask}>Add</button>
      <ul>
        {tasks.map(task => (
          <li key={task.id}>
            {task.text}
            <button onClick={() => removeTask(task.id)}>X</button>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

#### SibuJS

```ts
import { signal, div, input, button, ul, li, each } from "sibujs";

function TaskList() {
  const [tasks, setTasks] = signal<{ id: number; text: string }[]>([]);
  const [inputVal, setInputVal] = signal("");

  const addTask = () => {
    setTasks(prev => [...prev, { id: Date.now(), text: inputVal() }]);
    setInputVal("");
  };

  const removeTask = (id: number) => {
    setTasks(prev => prev.filter(t => t.id !== id));
  };

  return div([
    input({
      value: () => inputVal(),
      on: { input: (e) => setInputVal((e.target as HTMLInputElement).value) },
    }),
    button({ on: { click: addTask } }, "Add"),
    ul([
      each(
        () => tasks(),
        (task) =>
          li([
            task().text,
            button({
              on: { click: () => removeTask(task().id) },
            }, "X"),
          ]),
        { key: (task) => task.id }
      ),
    ]),
  ]);
}
```

---

## 10. Context & Dependency Injection

### React

```jsx
import { createContext, useContext, useState } from "react";

const ThemeContext = createContext("light");

function App() {
  const [theme, setTheme] = useState("dark");

  return (
    <ThemeContext.Provider value={theme}>
      <Toolbar />
      <button onClick={() => setTheme(t =>
        t === "dark" ? "light" : "dark"
      )}>
        Toggle Theme
      </button>
    </ThemeContext.Provider>
  );
}

function Toolbar() {
  const theme = useContext(ThemeContext);
  return <div className={`toolbar ${theme}`}>Toolbar</div>;
}
```

### SibuJS

```ts
import { context, div, button } from "sibujs";

const ThemeContext = context("light");

function App() {
  ThemeContext.provide("dark");

  return div([
    Toolbar(),
    button({
      on: {
        click: () => {
          const current = ThemeContext.get();
          ThemeContext.set(current === "dark" ? "light" : "dark");
        },
      },
    }, "Toggle Theme"),
  ]);
}

function Toolbar() {
  const theme = ThemeContext.use(); // returns a reactive getter

  return div({
    class: () => `toolbar ${theme()}`,
  }, "Toolbar");
}
```

**Key differences:**
- `context(default)` returns an object with `provide()`, `use()`, `get()`, and `set()`.
- No `<Provider>` wrapper component — call `provide(value)` imperatively.
- `use()` returns a reactive getter function, not a plain value.
- `get()` returns the current value directly (non-reactive).
- `set(value)` updates the provided value reactively.

---

## 11. Refs

### React

```jsx
import { useRef, useEffect } from "react";

function AutoFocusInput() {
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return <input ref={inputRef} placeholder="Auto-focused" />;
}
```

### SibuJS

```ts
import { ref, onMount, input } from "sibujs";

function AutoFocusInput() {
  const inputRef = ref<HTMLInputElement>();

  onMount(() => {
    inputRef.current?.focus();
  });

  return input({
    ref: inputRef,
    placeholder: "Auto-focused",
  });
}
```

**Key differences:**
- `ref()` works the same way — returns `{ current: T }`.
- Pass the ref via the `ref` prop in tag factories — the element is assigned to `ref.current` automatically.
- Updating `ref.current` does NOT trigger reactivity (same as React).

---

## 12. Lifecycle Callbacks

### React

```jsx
import { useEffect } from "react";

function MyComponent() {
  useEffect(() => {
    console.log("Mounted");
    return () => console.log("Unmounting");
  }, []);

  return <div>Hello</div>;
}
```

### SibuJS

```ts
import { onMount, onUnmount, ref, div } from "sibujs";

function MyComponent() {
  const el = ref<HTMLElement>();

  onMount(() => {
    console.log("Mounted");
  }, el.current);

  onUnmount(() => {
    console.log("Unmounting");
  }, el.current!);

  return div({ ref: el }, "Hello");
}
```

Alternatively, without a ref — `onMount` without an element argument defers execution to the next microtask (after the synchronous render pass):

```ts
import { onMount, div } from "sibujs";

function MyComponent() {
  onMount(() => {
    console.log("Mounted (deferred to microtask)");
  });

  return div("Hello");
}
```

**Key differences:**

| React | SibuJS |
|---|---|
| `useEffect(() => { ... return cleanup }, [])` | `onMount(cb, el?)` + `onUnmount(cb, el)` |
| Cleanup returned from effect | Explicit `onUnmount` function |
| Runs after paint (in most cases) | `onMount` runs on next microtask or when element connects |

---

## 13. Forms

### React

```jsx
import { useState } from "react";

function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState({});

  const validate = () => {
    const e = {};
    if (!email) e.email = "Required";
    if (password.length < 8) e.password = "Min 8 chars";
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (validate()) {
      console.log("Submit:", { email, password });
    }
  };

  return (
    <form onSubmit={handleSubmit}>
      <input
        value={email}
        onChange={e => setEmail(e.target.value)}
      />
      {errors.email && <span>{errors.email}</span>}

      <input
        type="password"
        value={password}
        onChange={e => setPassword(e.target.value)}
      />
      {errors.password && <span>{errors.password}</span>}

      <button type="submit">Login</button>
    </form>
  );
}
```

### SibuJS

```ts
import { form as createForm, required, minLength } from "sibujs/ui";
import { form, input, button, span, div, when } from "sibujs";

function LoginForm() {
  const { fields, handleSubmit, isValid } = createForm({
    email: {
      initial: "",
      validators: [required("Email is required")],
    },
    password: {
      initial: "",
      validators: [
        required("Password is required"),
        minLength(8, "Min 8 characters"),
      ],
    },
  });

  const onSubmit = handleSubmit((values) => {
    console.log("Submit:", values);
  });

  return form({
    on: { submit: onSubmit },
  }, [
    div([
      input({
        value: () => fields.email.value(),
        on: {
          input: (e) => fields.email.set((e.target as HTMLInputElement).value),
          blur: () => fields.email.touch(),
        },
      }),
      when(
        () => fields.email.touched() && fields.email.error() !== null,
        () => span({ class: "error" }, () => fields.email.error()!)
      ),
    ]),

    div([
      input({
        type: "password",
        value: () => fields.password.value(),
        on: {
          input: (e) => fields.password.set((e.target as HTMLInputElement).value),
          blur: () => fields.password.touch(),
        },
      }),
      when(
        () => fields.password.touched() && fields.password.error() !== null,
        () => span({ class: "error" }, () => fields.password.error()!)
      ),
    ]),

    button({ type: "submit" }, "Login"),
  ]);
}
```

**Key differences:**
- `form(config)` provides built-in field state, validation, touched tracking, and submit handling.
- Built-in validators: `required()`, `minLength()`, `maxLength()`, `email()`, `min()`, `max()`, `matchesPattern()`, `custom()`.
- Each field exposes: `value()`, `set()`, `error()`, `touched()`, `touch()`, `reset()`.
- Form-level helpers: `isValid()`, `isDirty()`, `errors()`, `values()`, `reset()`, `handleSubmit()`.

---

## 14. Multi-Key Stores

React has no built-in equivalent. The closest is `useReducer` or a state management library like Zustand.

### React (with useReducer)

```jsx
import { useReducer } from "react";

function reducer(state, action) {
  switch (action.type) {
    case "SET_NAME": return { ...state, name: action.payload };
    case "INCREMENT": return { ...state, count: state.count + 1 };
    case "RESET": return { count: 0, name: "" };
    default: return state;
  }
}

function Profile() {
  const [state, dispatch] = useReducer(reducer, {
    count: 0,
    name: "",
  });

  return (
    <div>
      <p>{state.name} — {state.count}</p>
      <button onClick={() => dispatch({ type: "INCREMENT" })}>
        +1
      </button>
    </div>
  );
}
```

### SibuJS

```ts
import { store, div, p, button } from "sibujs";

function Profile() {
  const [store, { setState, reset }] = store({
    count: 0,
    name: "",
  });

  return div([
    p(() => `${store.name} — ${store.count}`),
    button({
      on: { click: () => setState({ count: store.count + 1 }) },
    }, "+1"),
    button({
      on: { click: () => reset() },
    }, "Reset"),
  ]);
}
```

**Key differences:**
- `store(initial)` returns `[store, actions]`.
- `store` is a reactive proxy — access properties directly: `store.count`, `store.name`.
- `actions.setState(patch)` accepts a partial object or updater function.
- `actions.reset()` reverts to initial state.
- `actions.subscribe(cb)` and `actions.subscribeKey(key, cb)` for external listeners.
- Each key is independently reactive — changing `store.name` does not trigger updates that only read `store.count`.

---

## 15. Routing

### React (React Router)

```jsx
import {
  BrowserRouter,
  Routes,
  Route,
  Link,
  useParams,
} from "react-router-dom";

function App() {
  return (
    <BrowserRouter>
      <nav>
        <Link to="/">Home</Link>
        <Link to="/about">About</Link>
        <Link to="/user/42">User</Link>
      </nav>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/about" element={<About />} />
        <Route path="/user/:id" element={<UserProfile />} />
      </Routes>
    </BrowserRouter>
  );
}

function UserProfile() {
  const { id } = useParams();
  return <p>User ID: {id}</p>;
}
```

### SibuJS

```ts
import { div, nav, p } from "sibujs";
import {
  createRouter,
  Route,
  RouterLink,
  route,
} from "sibujs/plugins";

// Define routes
const router = createRouter([
  { path: "/", component: Home },
  { path: "/about", component: About },
  { path: "/user/:id", component: UserProfile },
]);

function App() {
  return div([
    nav([
      RouterLink({ to: "/", nodes: "Home" }),
      RouterLink({ to: "/about", nodes: "About" }),
      RouterLink({ to: "/user/42", nodes: "User" }),
    ]),
    Route(), // renders the matched component
  ]);
}

function UserProfile() {
  const r = route();
  return p(`User ID: ${r.params.id}`);
}
```

**Key differences:**
- `createRouter(routes, options?)` initializes the global router. Supports `'history'` and `'hash'` modes.
- `Route()` is the outlet that renders the matched component (equivalent to React Router's `<Routes>`).
- `RouterLink({ to, nodes })` renders an `<a>` tag with client-side navigation.
- `route()` returns the current `RouteContext` with `path`, `params`, `query`, `hash`, and `meta`.
- `router()` returns navigation functions: `push()`, `replace()`, `go()`, `back()`, `forward()`.
- Supports route guards (`beforeEnter`), global guards (`beforeEach`, `afterEach`), async/lazy components, redirects, and nested routes.

### Programmatic Navigation

#### React

```jsx
import { useNavigate } from "react-router-dom";

function LoginButton() {
  const navigate = useNavigate();
  return (
    <button onClick={() => navigate("/dashboard")}>
      Go to Dashboard
    </button>
  );
}
```

#### SibuJS

```ts
import { button } from "sibujs";
import { router } from "sibujs/plugins";

function LoginButton() {
  const { push } = router();
  return button({
    on: { click: () => push("/dashboard") },
  }, "Go to Dashboard");
}
```

---

## 16. Internationalization (i18n)

React has no built-in i18n. Libraries like `react-i18next` are commonly used.

### React (react-i18next)

```jsx
import { useTranslation } from "react-i18next";

function Greeting() {
  const { t, i18n } = useTranslation();

  return (
    <div>
      <p>{t("greeting", { name: "World" })}</p>
      <button onClick={() => i18n.changeLanguage("es")}>
        Espanol
      </button>
    </div>
  );
}
```

### SibuJS

```ts
import { div, p, button } from "sibujs";
import {
  t,
  setLocale,
  registerTranslations,
  Trans,
} from "sibujs/plugins";

// Register translations
registerTranslations("en", { greeting: "Hello, {name}!" });
registerTranslations("es", { greeting: "Hola, {name}!" });

function Greeting() {
  return div([
    // Option 1: Trans component (auto-updates on locale change)
    Trans("greeting", { name: "World" }),

    // Option 2: Reactive text with t()
    p(() => t("greeting", { name: "World" })),

    button({
      on: { click: () => setLocale("es") },
    }, "Espanol"),
  ]);
}
```

**Key differences:**
- Built-in — no extra library needed.
- `registerTranslations(locale, messages)` to add translations.
- `t(key, params?)` returns a translated string (reactive when used in a getter).
- `Trans(key, params?)` returns a reactive `<span>` element that auto-updates on locale changes.
- `setLocale(locale)` switches the active language globally.

---

## 17. Code Splitting & Lazy Loading

### React

```jsx
import React, { Suspense, lazy } from "react";

const Dashboard = lazy(() => import("./Dashboard"));

function App() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <Dashboard />
    </Suspense>
  );
}
```

### SibuJS

```ts
import { lazy, Suspense, div } from "sibujs";

const Dashboard = lazy(() => import("./Dashboard"));

function App() {
  return Suspense({
    nodes: () => Dashboard(),
    fallback: () => div("Loading..."),
  });
}
```

**Key differences:**
- `lazy(importFn)` works the same way — takes a dynamic `import()` that returns `{ default: Component }`.
- `Suspense({ nodes, fallback })` is a function call, not JSX.
- Both `nodes` and `fallback` are functions that return elements.
- `lazy()` can also be used standalone without `Suspense` — it shows a default "Loading..." text.

---

## 18. Migration Checklist

Use this checklist when converting a React component to SibuJS:

### Imports

- [ ] Replace `import React from "react"` with `import { div, span, ... } from "sibujs"`
- [ ] Replace `import { useState, useEffect, ... } from "react"` with `import { signal, effect, ... } from "sibujs"`
- [ ] Replace `react-router-dom` imports with `import { ... } from "sibujs/plugins"`
- [ ] Replace form libraries with `import { form, ... } from "sibujs/ui"`
- [ ] Replace i18n libraries with `import { t, setLocale, ... } from "sibujs/plugins"`

### JSX to Tag Factories

- [ ] Replace `<div className="x">` with `div("x", ...)`
- [ ] Replace `className` with `class`
- [ ] Replace `htmlFor` with `for`
- [ ] Replace `<Component prop={val} />` with `Component({ prop: val })`
- [ ] Replace `onClick={handler}` with `on: { click: handler }`
- [ ] Replace `onChange` with `on: { input: handler }` (for text inputs) or `on: { change: handler }`
- [ ] Replace `{children}` pass-through with positional children: `tag(props, children)`
- [ ] Replace self-closing tags like `<img />` with `img({ src: "...", alt: "..." })`

### State

- [ ] Keep `signal` — but remember the getter is a function: `count()` not `count`
- [ ] Wrap displayed state in arrow functions for reactivity: `p(() => count())`
- [ ] Replace `useReducer` with `store` for multi-key state

### Effects

- [ ] Remove all dependency arrays from `effect`
- [ ] Replace return-based cleanup with the cleanup function returned by `effect()`, or use `onUnmount`
- [ ] Dependencies are now auto-tracked — just read signals inside the effect

### Derived Values

- [ ] Replace `useMemo(fn, [deps])` with `derived(fn)` — no dep array needed
- [ ] Remember `derived` returns a getter function: `total()` not `total`

### Conditionals

- [ ] Replace `{cond && <X/>}` with `when(() => cond(), () => X())`
- [ ] Replace `{cond ? <A/> : <B/>}` with `when(() => cond(), () => A(), () => B())`
- [ ] Replace `style={{ display: cond ? '' : 'none' }}` with `show(() => cond(), el)`
- [ ] Replace switch-case rendering with `match(() => val(), { case1: ..., case2: ... })`

### Lists

- [ ] Replace `items.map(i => <X key={i.id} />)` with `each(() => items(), (i) => X(i), { key: (i) => i.id })`
- [ ] The first argument to `each` must be a reactive getter: `() => items()`

### Context

- [ ] Replace `createContext` + `<Provider>` + `useContext` with `context(default)` + `.provide(val)` + `.use()`
- [ ] Remember `.use()` returns a getter function

### Refs

- [ ] `ref` works the same way — pass via `ref` prop in tag factories

### Lifecycle

- [ ] Replace `useEffect(() => { ... }, [])` (mount) with `onMount(cb)` or `onMount(cb, element)`
- [ ] Replace cleanup return in mount effect with explicit `onUnmount(cb, element)`

### Routing

- [ ] Replace `<BrowserRouter>` with `createRouter(routes, { mode: 'history' })`
- [ ] Replace `<Routes>/<Route>` with `Route()` outlet
- [ ] Replace `<Link to="...">` with `RouterLink({ to: "...", nodes: "..." })`
- [ ] Replace `useNavigate()` with `router().push()`
- [ ] Replace `useParams()` with `route().params`

### Forms

- [ ] Replace manual form state with `form(config)` from `"sibujs/ui"`
- [ ] Use built-in validators: `required()`, `minLength()`, `email()`, etc.

### Code Splitting

- [ ] `lazy(() => import("..."))` works the same way
- [ ] Replace `<Suspense fallback={...}>` with `Suspense({ nodes: () => ..., fallback: () => ... })`

### Mental Model

- [ ] **Component functions run once** — they build the DOM, not a VDOM description
- [ ] **Reactivity is opt-in per binding** — wrap expressions in `() => ...` to make them reactive
- [ ] **No stale closures** — getters always return current values
- [ ] **No dependency arrays** — effects and computed values auto-track
- [ ] **No re-renders** — only the specific DOM nodes that depend on changed signals update
