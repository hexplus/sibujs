import { track } from "../../reactivity/track";
import { dispose, registerDisposer } from "./dispose";
import { div } from "./html";

type Component = () => HTMLElement;

/**
 * Registry for dynamically loaded components.
 * Components can be registered at runtime and resolved by name.
 */
const componentRegistry = new Map<string, Component>();

/**
 * Register a component by name for dynamic resolution.
 *
 * @param name Unique component identifier
 * @param component The component function
 *
 * @example
 * ```ts
 * registerComponent("UserCard", UserCard);
 * registerComponent("AdminPanel", AdminPanel);
 * ```
 */
export function registerComponent(name: string, component: Component): void {
  componentRegistry.set(name, component);
}

/**
 * Unregister a previously registered component.
 */
export function unregisterComponent(name: string): void {
  componentRegistry.delete(name);
}

/**
 * Resolve and render a dynamically registered component by name.
 * Returns a placeholder if the component is not found.
 *
 * @param name Component name to resolve
 * @returns The rendered HTMLElement or a fallback
 *
 * @example
 * ```ts
 * registerComponent("Widget", MyWidget);
 * div([resolveComponent("Widget")]);
 * ```
 */
export function resolveComponent(name: string): HTMLElement {
  const component = componentRegistry.get(name);
  if (component) {
    return component();
  }
  return div({ nodes: `[Component "${name}" not found]` }) as HTMLElement;
}

/**
 * Dynamic component that reactively switches between components
 * based on a reactive getter returning a component name or function.
 *
 * @param is Reactive getter returning component name (string) or component function
 * @param props Optional props to pass
 * @returns Container element that swaps content reactively
 *
 * @example
 * ```ts
 * const [view, setView] = signal("list");
 * DynamicComponent(() => view()); // Renders registered "list" component
 * setView("grid"); // Swaps to registered "grid" component
 * ```
 */
export function DynamicComponent(is: () => string | Component): HTMLElement {
  const container = div({ class: "sibu-dynamic" }) as HTMLElement;

  function render() {
    const target = is();
    let el: HTMLElement;

    if (typeof target === "function") {
      el = target();
    } else {
      el = resolveComponent(target);
    }

    // Dispose old content before replacing to prevent reactive binding leaks
    for (const child of Array.from(container.childNodes)) {
      dispose(child);
    }
    container.replaceChildren(el);
  }

  // Track reactive dependencies so render re-runs when `is()` changes.
  // Capture the teardown so disposing the container unsubscribes the effect.
  const untrack = track(render);
  registerDisposer(container, untrack);

  return container;
}
