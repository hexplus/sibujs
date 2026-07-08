# Example: Todo Application

A complete Todo app demonstrating core SibuJS patterns.

## Features

- Add, toggle, and remove todos
- Filter by status (all / active / completed)
- Persistent count display
- Form handling with validation

## Full Source

```ts
import {
  div, h1, input, button, span, ul, li, footer, label,
  signal, store, derived, mount, each, when, show,
} from "sibujs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Todo {
  id: number;
  text: string;
  completed: boolean;
}

type Filter = "all" | "active" | "completed";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let nextId = 1;

const [todos, setTodos] = signal<Todo[]>([]);
const [filter, setFilter] = signal<Filter>("all");
const [inputValue, setInputValue] = signal("");

const filteredTodos = derived(() => {
  const f = filter();
  const list = todos();
  if (f === "active") return list.filter((t) => !t.completed);
  if (f === "completed") return list.filter((t) => t.completed);
  return list;
});

const activeCount = derived(
  () => todos().filter((t) => !t.completed).length
);

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function addTodo() {
  const text = inputValue().trim();
  if (!text) return;
  setTodos((prev) => [...prev, { id: nextId++, text, completed: false }]);
  setInputValue("");
}

function toggleTodo(id: number) {
  setTodos((prev) =>
    prev.map((t) => (t.id === id ? { ...t, completed: !t.completed } : t))
  );
}

function removeTodo(id: number) {
  setTodos((prev) => prev.filter((t) => t.id !== id));
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function TodoInput(): HTMLElement {
  return div("todo-input", [
    input({
      type: "text",
      placeholder: "What needs to be done?",
      value: () => inputValue(),
      on: {
        input: (e) => setInputValue((e.target as HTMLInputElement).value),
        keydown: (e) => {
          if ((e as KeyboardEvent).key === "Enter") addTodo();
        },
      },
    }),
    button({ on: { click: addTodo } }, "Add"),
  ]) as HTMLElement;
}

function TodoItem(todo: Todo): HTMLElement {
  return li({
    class: () => `todo-item ${todo.completed ? "completed" : ""}`,
  }, [
    label([
      input({
        type: "checkbox",
        checked: todo.completed ? "checked" : undefined,
        on: { change: () => toggleTodo(todo.id) },
      }),
      span(todo.text),
    ]),
    button({
      class: "remove-btn",
      on: { click: () => removeTodo(todo.id) },
    }, "\u00d7"),
  ]) as HTMLElement;
}

function FilterButtons(): HTMLElement {
  const filters: Filter[] = ["all", "active", "completed"];

  return div("filters", filters.map((f) =>
    button({
      class: () => `filter-btn ${filter() === f ? "active" : ""}`,
      on: { click: () => setFilter(f) },
    }, f.charAt(0).toUpperCase() + f.slice(1))
  )) as HTMLElement;
}

function TodoFooter(): HTMLElement {
  return footer("todo-footer", [
    span(() => `${activeCount()} item${activeCount() === 1 ? "" : "s"} left`),
    FilterButtons(),
  ]) as HTMLElement;
}

function App(): HTMLElement {
  return div("todo-app", [
    h1("Todos"),
    TodoInput(),
    ul("todo-list", [
      each(
        () => filteredTodos(),
        (todo) => TodoItem(todo()),
        { key: (t) => t.id }
      ),
    ]),
    when(
      () => todos().length > 0,
      () => TodoFooter()
    ),
  ]) as HTMLElement;
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

mount(App, document.getElementById("app"));
```

## Key Patterns Demonstrated

| Pattern | Usage |
|---------|-------|
| `signal` | Todos array, filter selection, input value |
| `derived` | Filtered todos, active count |
| `each()` with key | Rendering todo list with efficient reconciliation |
| `when()` | Conditionally showing footer |
| Reactive `class` | Toggle "completed" and "active" classes |
| Reactive child | Dynamic count text |
| Event handling | Input, keydown, click, change |
