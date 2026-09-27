import { track, untracked } from "../../reactivity/track";
import { globalSingleton } from "../../utils/globalSingleton";
import { signal } from "../signals/signal";
import { registerDisposer, replaceChildrenSafely } from "./dispose";
import { div } from "./html";
import type { Component } from "./types";

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
 * Bumped on every registry write so a `DynamicComponent` showing a name picks
 * up a component registered (or replaced) after it rendered. A plain map could
 * not tell it, so a name registered late stayed "not found" for good. Shared
 * like the registry it versions.
 */
const registryVersion = globalSingleton(Symbol.for("sibujs.components.registryVersion.v1"), () => signal(0));

function bumpRegistry(): void {
  const [read, write] = registryVersion;
  write(untracked(read) + 1);
}

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
  bumpRegistry();
}

/**
 * Unregister a previously registered component.
 */
export function unregisterComponent(name: string): void {
  if (componentRegistry.delete(name)) bumpRegistry();
}

/**
 * Resolve and render a dynamically registered component by name.
 * Returns a placeholder if the component is not found.
 *
 * The registry is keyed by name, so it cannot know which root a component
 * renders: `El` states it, like `querySelector<E>()`. It defaults to
 * `HTMLElement`; pass `Element` (or `SVGSVGElement`, …) for an SVG component.
 *
 * @param name Component name to resolve
 * @returns The rendered root element or a fallback
 *
 * @example
 * ```ts
 * registerComponent("Widget", MyWidget);
 * div([resolveComponent("Widget")]);
 * ```
 */
export function resolveComponent<El extends Element = HTMLElement>(name: string): El {
  const component = componentRegistry.get(name);
  if (component) {
    return component() as El;
  }
  return div(`[Component "${name}" not found]`) as Element as El;
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
export function DynamicComponent(is: () => string | Component): HTMLDivElement {
  const container = div({ class: "sibu-dynamic" });
  // Sentinel rather than `undefined` so the first run always renders, whatever
  // `is()` returns.
  const NONE = {};
  // What is on screen: the component function, or the name that was missing.
  let shown: unknown = NONE;

  function render() {
    const target = is();
    // A name resolves through the registry, and reading its version makes a
    // later `registerComponent()` of a missing (or replaced) name re-run this.
    let component: Component | undefined;
    if (typeof target === "function") {
      component = target;
    } else {
      registryVersion[0]();
      component = componentRegistry.get(target);
    }
    // Only a change of what `is()` resolves to swaps the view. Without this
    // guard any re-run of the effect rebuilt the component and discarded its
    // DOM state.
    const next = component ?? `missing:${target as string}`;
    if (next === shown) return;
    // The component body runs untracked: a signal it reads eagerly while
    // building belongs to the component, not to this switch. Tracked, every
    // write to such a signal re-ran the effect and remounted the component.
    const el: Element = untracked(() => (component ? component() : div(`[Component "${target as string}" not found]`)));
    // Recorded only once the build succeeded, so a component that threw is
    // built again on the next run instead of being skipped as already shown.
    shown = next;

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
