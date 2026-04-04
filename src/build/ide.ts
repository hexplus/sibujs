/**
 * IDE extension support for SibuJS.
 * Provides metadata and utilities for VS Code and other IDE integrations.
 */

/**
 * Component metadata for IDE IntelliSense.
 */
export interface ComponentMeta {
  name: string;
  description: string;
  props: Array<{
    name: string;
    type: string;
    required: boolean;
    default?: string;
    description: string;
  }>;
  events?: Array<{
    name: string;
    description: string;
  }>;
}

/**
 * SibuJS component registry for IDE auto-completion.
 * Returns metadata about all built-in SibuJS exports.
 */
export function getComponentMetadata(): ComponentMeta[] {
  return [
    // ── Reactive Primitives ──────────────────────────────────────────
    {
      name: "signal",
      description:
        "Creates a reactive signal that holds a value. Returns a [getter, setter] tuple. The getter registers reactive dependencies when called.",
      props: [
        {
          name: "initial",
          type: "T",
          required: true,
          description: "The initial value of the state",
        },
      ],
    },
    {
      name: "effect",
      description:
        "Runs a side effect function immediately and re-runs it whenever any reactive dependency changes. Returns a cleanup function.",
      props: [
        {
          name: "effectFn",
          type: "() => void",
          required: true,
          description: "The effect function to run. It is tracked for reactive dependencies.",
        },
      ],
    },
    {
      name: "derived",
      description:
        "Creates a derived reactive signal whose value updates automatically when dependencies change. Returns a getter function.",
      props: [
        {
          name: "getter",
          type: "() => T",
          required: true,
          description: "Function returning the computed value based on reactive signals",
        },
      ],
    },
    {
      name: "memo",
      description:
        "Returns a memoized value that only recomputes when its reactive dependencies change. Alias for derived.",
      props: [
        {
          name: "factory",
          type: "() => T",
          required: true,
          description: "Function that computes the memoized value",
        },
      ],
    },
    {
      name: "memoFn",
      description: "Returns a memoized callback that only updates when its reactive dependencies change.",
      props: [
        {
          name: "callback",
          type: "() => T",
          required: true,
          description: "The callback factory function to memoize",
        },
      ],
    },
    {
      name: "ref",
      description:
        "Creates a mutable reference object that persists across renders. Updating a ref does NOT trigger re-renders.",
      props: [
        {
          name: "initial",
          type: "T",
          required: false,
          default: "undefined",
          description: "Optional initial value for the ref",
        },
      ],
    },
    {
      name: "watch",
      description:
        "Watches a reactive getter and calls a callback with (newValue, oldValue) when the watched value changes. Returns a teardown function.",
      props: [
        {
          name: "getter",
          type: "() => T",
          required: true,
          description: "Function that returns the value to watch",
        },
        {
          name: "callback",
          type: "(value: T, prev: T | undefined) => void",
          required: true,
          description: "Function called when the watched value changes",
        },
      ],
    },
    {
      name: "store",
      description:
        "Creates a global store with reactive properties and subscription support. Returns a [store, actions] tuple.",
      props: [
        {
          name: "initialState",
          type: "T extends object",
          required: true,
          description: "Initial state object for the store",
        },
      ],
    },

    // ── SolidJS-style Primitives ─────────────────────────────────────
    {
      name: "createSignal",
      description: "Creates a reactive signal. SolidJS-style alias for signal. Returns [getter, setter].",
      props: [
        {
          name: "value",
          type: "T",
          required: true,
          description: "Initial value",
        },
      ],
    },
    {
      name: "createMemo",
      description: "Creates a derived/computed reactive value. SolidJS-style alias for derived.",
      props: [
        {
          name: "fn",
          type: "() => T",
          required: true,
          description: "Computation function that reads other signals",
        },
      ],
    },
    {
      name: "createEffect",
      description: "Creates a reactive side effect. SolidJS-style alias for effect.",
      props: [
        {
          name: "fn",
          type: "() => void",
          required: true,
          description: "Effect function that reads reactive signals",
        },
      ],
    },

    // ── Lifecycle ────────────────────────────────────────────────────
    {
      name: "onMount",
      description:
        "Runs a callback once the component element has been inserted into the DOM. Uses queueMicrotask for deferred execution.",
      props: [
        {
          name: "callback",
          type: "() => void | CleanupFn",
          required: true,
          description: "Function to run after mount. May return a cleanup function.",
        },
        {
          name: "element",
          type: "HTMLElement",
          required: false,
          description: "Optional element to observe; if provided, waits until it is connected.",
        },
      ],
    },
    {
      name: "onUnmount",
      description:
        "Runs a callback when the given element is removed from the DOM. Uses MutationObserver to watch for disconnection.",
      props: [
        {
          name: "callback",
          type: "() => void",
          required: true,
          description: "Function to run on unmount",
        },
        {
          name: "element",
          type: "HTMLElement",
          required: true,
          description: "The element to watch for removal",
        },
      ],
    },

    // ── Rendering ────────────────────────────────────────────────────
    {
      name: "mount",
      description:
        "Mounts a root component into a DOM element. Returns an object with the mounted node and an unmount function.",
      props: [
        {
          name: "component",
          type: "(() => HTMLElement) | HTMLElement | Node",
          required: true,
          description: "Function returning HTMLElement, or an HTMLElement directly",
        },
        {
          name: "container",
          type: "HTMLElement",
          required: true,
          description: "Target DOM element to append the result",
        },
      ],
    },
    {
      name: "each",
      description: "Renders a list of nodes efficiently with key-based diffing and LIS-based move minimization.",
      props: [
        {
          name: "getArray",
          type: "() => T[]",
          required: true,
          description: "A reactive getter returning an array",
        },
        {
          name: "render",
          type: "(item: T, index: number) => NodeChild",
          required: true,
          description: "A function that returns a NodeChild for each item",
        },
        {
          name: "options",
          type: "{ key: (item: T) => string | number }",
          required: true,
          description: "A key function for unique identity of items",
        },
      ],
    },
    {
      name: "lazy",
      description: "Enables code-splitting by deferring the import of a component until it is first rendered.",
      props: [
        {
          name: "importFn",
          type: "() => Promise<{ default: Component }>",
          required: true,
          description: "Dynamic import function returning { default: Component }",
        },
      ],
    },
    {
      name: "Suspense",
      description: "Provides a fallback UI while lazy or async nodes are loading.",
      props: [
        {
          name: "nodes",
          type: "() => HTMLElement",
          required: true,
          description: "Function that returns the async/lazy component",
        },
        {
          name: "fallback",
          type: "() => HTMLElement",
          required: true,
          description: "Function that returns the loading UI",
        },
      ],
    },

    // ── Context ──────────────────────────────────────────────────────
    {
      name: "context",
      description:
        "Creates a context for dependency injection across component trees without prop drilling. Returns a Context object with provide, use, get, and set methods.",
      props: [
        {
          name: "defaultValue",
          type: "T",
          required: true,
          description: "The fallback value when no provider is found",
        },
      ],
    },

    // ── Dynamic Components ───────────────────────────────────────────
    {
      name: "DynamicComponent",
      description:
        "Reactively switches between components based on a reactive getter returning a component name or function.",
      props: [
        {
          name: "is",
          type: "() => string | Component",
          required: true,
          description: "Reactive getter returning component name (string) or component function",
        },
      ],
    },
    {
      name: "registerComponent",
      description: "Registers a component by name for dynamic resolution via DynamicComponent or resolveComponent.",
      props: [
        {
          name: "name",
          type: "string",
          required: true,
          description: "Unique component identifier",
        },
        {
          name: "component",
          type: "() => HTMLElement",
          required: true,
          description: "The component function",
        },
      ],
    },

    // ── HTML Tag Factories ───────────────────────────────────────────
    {
      name: "div",
      description:
        "Creates a reactive <div> element. Accepts TagProps including class, style, on, nodes, and arbitrary attributes.",
      props: [
        {
          name: "props",
          type: "TagProps",
          required: false,
          default: "{}",
          description: "Props object with id, class, style, ref, nodes, on, and other attributes",
        },
      ],
      events: [
        {
          name: "click",
          description: "Fires when the element is clicked",
        },
        {
          name: "input",
          description: "Fires when user input is received",
        },
      ],
    },
  ];
}

/**
 * Generate VS Code snippets for SibuJS.
 */
export function generateVSCodeSnippets(): Record<
  string,
  {
    prefix: string;
    body: string[];
    description: string;
  }
> {
  return {
    "SibuJS Component": {
      prefix: "sibu-component",
      body: [
        "import { div } from 'sibujs';",
        "",
        "export function ${1:ComponentName}(): HTMLElement {",
        "\treturn div({",
        "\t\tclass: '${2:component-class}',",
        "\t\tnodes: [",
        "\t\t\t${3:// nodes here}",
        "\t\t],",
        "\t});",
        "}",
      ],
      description: "Create a basic SibuJS component",
    },
    "SibuJS Component with State": {
      prefix: "sibu-component-state",
      body: [
        "import { div, span } from 'sibujs';",
        "import { signal } from 'sibujs';",
        "",
        "export function ${1:ComponentName}(): HTMLElement {",
        "\tconst [${2:value}, ${3:setValue}] = signal(${4:initialValue});",
        "",
        "\treturn div({",
        "\t\tclass: '${5:component-class}',",
        "\t\tnodes: [",
        "\t\t\t() => span({ nodes: String(${2:value}()) }),",
        "\t\t],",
        "\t});",
        "}",
      ],
      description: "Create a SibuJS component with reactive state",
    },
    "SibuJS signal": {
      prefix: "sibu-state",
      body: ["const [${1:value}, ${2:setValue}] = signal(${3:initialValue});"],
      description: "Create a reactive state with signal",
    },
    "SibuJS effect": {
      prefix: "sibu-effect",
      body: ["const cleanup = effect(() => {", "\t${1:// effect logic}", "});"],
      description: "Create a reactive side effect with effect",
    },
    "SibuJS derived": {
      prefix: "sibu-computed",
      body: ["const ${1:computed} = derived(() => {", "\treturn ${2:// derived value};", "});"],
      description: "Create a derived reactive value with derived",
    },
    "SibuJS watch": {
      prefix: "sibu-watch",
      body: [
        "const teardown = watch(",
        "\t() => ${1:watchedValue}(),",
        "\t(newVal, oldVal) => {",
        "\t\t${2:// handle change}",
        "\t}",
        ");",
      ],
      description: "Watch a reactive value for changes",
    },
    "SibuJS each": {
      prefix: "sibu-each",
      body: [
        "each(",
        "\t() => ${1:items}(),",
        "\t(item) => {",
        "\t\treturn ${2:div({ nodes: () => String(item()) })};",
        "\t},",
        "\t{ key: (item) => ${3:item.id} }",
        ")",
      ],
      description: "Create a reactive list with each()",
    },
    "SibuJS Context": {
      prefix: "sibu-context",
      body: [
        "const ${1:MyContext} = context(${2:defaultValue});",
        "",
        "// In provider component:",
        "// ${1:MyContext}.provide(value);",
        "",
        "// In consumer component:",
        "// const ${3:value} = ${1:MyContext}.use();",
      ],
      description: "Create a context for dependency injection",
    },
    "SibuJS store": {
      prefix: "sibu-store",
      body: [
        "const [${1:store}, { setState: ${2:setStore}, reset, subscribe }] = store({",
        "\t${3:key}: ${4:value},",
        "});",
      ],
      description: "Create a reactive global store",
    },
    "SibuJS Lazy Component": {
      prefix: "sibu-lazy",
      body: ["const ${1:LazyComponent} = lazy(() => import('./${2:ComponentPath}'));"],
      description: "Create a lazy-loaded component",
    },
    "SibuJS Suspense": {
      prefix: "sibu-suspense",
      body: [
        "Suspense({",
        "\tnodes: () => ${1:LazyComponent}(),",
        "\tfallback: () => div({ nodes: '${2:Loading...}' }),",
        "})",
      ],
      description: "Wrap a lazy component with a loading fallback",
    },
    "SibuJS onMount": {
      prefix: "sibu-mount",
      body: ["onMount(() => {", "\t${1:// runs after component enters the DOM}", "});"],
      description: "Schedule a callback to run after mount",
    },
    "SibuJS onUnmount": {
      prefix: "sibu-unmount",
      body: ["onUnmount(() => {", "\t${1:// cleanup when removed from DOM}", "}, ${2:element});"],
      description: "Schedule a callback to run on unmount",
    },
    "SibuJS Event Handler": {
      prefix: "sibu-event",
      body: [
        "div({",
        "\ton: {",
        "\t\t${1:click}: (e) => {",
        "\t\t\t${2:// handle event}",
        "\t\t},",
        "\t},",
        "\tnodes: '${3:Click me}',",
        "})",
      ],
      description: "Create an element with event handlers",
    },
    "SibuJS Form": {
      prefix: "sibu-form",
      body: [
        "const form = form({",
        "\t${1:fieldName}: {",
        "\t\tinitial: '${2:}',",
        "\t\tvalidators: [",
        "\t\t\t(value) => !value ? '${3:Required}' : null,",
        "\t\t],",
        "\t},",
        "});",
      ],
      description: "Create a reactive form with validation",
    },
    "SibuJS createSignal": {
      prefix: "sibu-signal",
      body: ["const [${1:value}, ${2:setValue}] = createSignal(${3:initialValue});"],
      description: "Create a reactive signal (SolidJS-style alias for signal)",
    },
  };
}

/**
 * Generate a language configuration for SibuJS files.
 * Provides bracket matching, comment toggling, and auto-close pairs.
 */
export function generateLanguageConfig(): {
  comments: { lineComment: string; blockComment: [string, string] };
  brackets: [string, string][];
  autoClosingPairs: Array<{ open: string; close: string }>;
} {
  return {
    comments: {
      lineComment: "//",
      blockComment: ["/*", "*/"] as [string, string],
    },
    brackets: [
      ["{", "}"],
      ["[", "]"],
      ["(", ")"],
      ["<", ">"],
    ],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: "<", close: ">" },
      { open: "'", close: "'" },
      { open: '"', close: '"' },
      { open: "`", close: "`" },
    ],
  };
}

/**
 * Generate type stubs for common SibuJS patterns.
 * Useful for IDE auto-import suggestions.
 */
export function generateTypeStubs(): Record<string, string> {
  return {
    signal: ["declare function signal<T>(initial: T): [() => T, (next: T | ((prev: T) => T)) => void];"].join("\n"),

    effect: ["declare function effect(effectFn: () => void): () => void;"].join("\n"),

    derived: ["declare function derived<T>(getter: () => T): () => T;"].join("\n"),

    memo: ["declare function memo<T>(factory: () => T): () => T;"].join("\n"),

    memoFn: ["declare function memoFn<T extends (...args: unknown[]) => unknown>(callback: () => T): () => T;"].join(
      "\n",
    ),

    ref: [
      "interface Ref<T> { current: T; }",
      "declare function ref<T>(initial: T): Ref<T>;",
      "declare function ref<T = undefined>(): Ref<T | undefined>;",
    ].join("\n"),

    watch: [
      "declare function watch<T>(getter: () => T, callback: (value: T, prev: T | undefined) => void): () => void;",
    ].join("\n"),

    store: [
      "interface StoreActions<T> {",
      "  setState: (patch: Partial<T> | ((state: T) => T)) => void;",
      "  reset: () => void;",
      "  subscribe: (callback: (state: T) => void) => () => void;",
      "  subscribeKey: <K extends keyof T>(key: K, callback: (value: T[K], prev: T[K]) => void) => () => void;",
      "  getSnapshot: () => T;",
      "}",
      "declare function store<T extends object>(initialState: T): [{ readonly [K in keyof T]: T[K] }, StoreActions<T>];",
    ].join("\n"),

    createSignal: ["declare function createSignal<T>(value: T): [() => T, (next: T | ((prev: T) => T)) => void];"].join(
      "\n",
    ),

    createMemo: ["declare function createMemo<T>(fn: () => T): () => T;"].join("\n"),

    createEffect: ["declare function createEffect(fn: () => void): () => void;"].join("\n"),

    mount: [
      "declare function mount(component: (() => HTMLElement) | HTMLElement | Node, container: HTMLElement | null): { node: Node; unmount: () => void };",
    ].join("\n"),

    each: [
      "declare function each<T>(getArray: () => T[], render: (item: T, index: number) => NodeChild, options: { key: (item: T) => string | number }): Comment;",
    ].join("\n"),

    onMount: ["declare function onMount(callback: () => void | (() => void), element?: HTMLElement): void;"].join("\n"),

    onUnmount: ["declare function onUnmount(callback: () => void, element: HTMLElement): void;"].join("\n"),

    context: [
      "interface Context<T> {",
      "  provide(value: T): void;",
      "  use(): () => T;",
      "  get(): T;",
      "  set(value: T): void;",
      "}",
      "declare function context<T>(defaultValue: T): Context<T>;",
    ].join("\n"),

    lazy: ["declare function lazy(importFn: () => Promise<{ default: () => HTMLElement }>): () => HTMLElement;"].join(
      "\n",
    ),

    Suspense: [
      "interface SuspenseProps { nodes: () => HTMLElement; fallback: () => HTMLElement; }",
      "declare function Suspense(props: SuspenseProps): HTMLElement;",
    ].join("\n"),

    tagFactory: [
      "interface TagProps {",
      "  id?: string;",
      "  class?: string | (() => string) | Record<string, boolean | (() => boolean)>;",
      "  style?: Record<string, string | number | (() => string | number)> | string | (() => string);",
      "  ref?: { current: unknown };",
      "  nodes?: NodeChildren;",
      "  on?: Record<string, (ev: Event) => void>;",
      "  [attr: string]: unknown;",
      "}",
      "declare function tagFactory(tag: string, ns?: string): (first?: TagProps | NodeChildren, second?: NodeChildren) => Element;",
    ].join("\n"),

    DynamicComponent: ["declare function DynamicComponent(is: () => string | (() => HTMLElement)): HTMLElement;"].join(
      "\n",
    ),

    registerComponent: ["declare function registerComponent(name: string, component: () => HTMLElement): void;"].join(
      "\n",
    ),
  };
}
