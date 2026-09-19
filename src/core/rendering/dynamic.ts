import { track } from "../../reactivity/track";
import { globalSingleton } from "../../utils/globalSingleton";
import { registerDisposer, replaceChildrenSafely, withDisposerRollback } from "./dispose";
import { div } from "./html";

type Component = () => HTMLElement;

/**
 * Registry for dynamically loaded components.
 * Components can be registered at runtime and resolved by name.
 *
 * Shared across duplicate copies of this module through a globalThis registry
 * (first copy wins, like the action and reactive registries): a module-local map
 * made a component registered through one copy unresolvable through another. A
 * future incompatible layout must use a new symbol version.
 */
const componentRegistry = globalSingleton(
  Symbol.for("sibujs.components.registry.v1"),
  () => new Map<string, Component>(),
);

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
  // A render transaction: a component that throws part-way leaves none of the
  // bindings or effects it created subscribed.
  if (component) return withDisposerRollback(component);
  return div(`[Component "${name}" not found]`) as HTMLElement;
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
      el = withDisposerRollback(target);
    } else {
      el = resolveComponent(target);
    }

    // Dispose old content before replacing to prevent reactive binding leaks.
    // Via the shared primitive rather than a hand-rolled dispose-then-replace:
    // it detaches the INCOMING node first, so a re-render that legitimately
    // returns the same element does not dispose the very node being reinstalled.
    replaceChildrenSafely(container, el);
  }

  // Track reactive dependencies so render re-runs when `is()` changes.
  // Capture the teardown so disposing the container unsubscribes the effect.
  const untrack = track(render);
  registerDisposer(container, untrack);

  return container;
}
