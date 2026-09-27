/**
 * Higher-order component utilities for SibuJS.
 * These functions wrap or compose components to add behavior.
 *
 * Each helper is generic over the wrapped component's root type `R`, so a
 * component returning `div()` keeps its `HTMLDivElement` root and an SVG
 * component works as well. `R` defaults to `HTMLElement`, the type these
 * helpers used before, for callers that pass the type arguments explicitly.
 */

import type { Component } from "../core/rendering/types";

/**
 * Wraps a component with additional behavior that runs before/after rendering.
 *
 * @param WrappedComponent The component to wrap
 * @param wrapper Function that receives the component and its props, returns enhanced element
 * @returns A new component function
 *
 * @example
 * ```ts
 * const WithLogging = withWrapper(MyComponent, (Comp, props) => {
 *   console.log("Rendering with props:", props);
 *   return Comp(props);
 * });
 * ```
 */
export function withWrapper<P, R extends Node = HTMLElement, W extends Node = R>(
  WrappedComponent: Component<P, R>,
  wrapper: (component: Component<P, R>, props: P) => W,
): Component<P, W> {
  return (props: P) => wrapper(WrappedComponent, props);
}

/**
 * Adds default props to a component. Missing props are filled from defaults.
 *
 * @param component The component to wrap
 * @param defaults Default prop values
 * @returns A new component with defaults applied
 *
 * @example
 * ```ts
 * const Button = withDefaults(RawButton, { type: "button", disabled: false });
 * Button("Click"); // type="button", disabled=false automatically
 * ```
 */
/**
 * Props accepted by a {@link withDefaults} component: every key that has a
 * default becomes optional; every other key keeps its original required or
 * optional status.
 */
export type WithDefaultsProps<P, D> = Omit<P, keyof D> & Partial<Pick<P, Extract<keyof P, keyof D>>>;

export function withDefaults<P extends object, const D extends Partial<P> = Partial<P>, R extends Node = HTMLElement>(
  component: Component<P, R>,
  // Reject default keys the component does not accept.
  defaults: D & { [K in Exclude<keyof D, keyof P>]: never },
): Component<WithDefaultsProps<P, D>, R> {
  // Returning `Component<Partial<P>>` made EVERY prop optional, so a required
  // prop without a default could be omitted and arrive as `undefined`.
  return (props: WithDefaultsProps<P, D>) => component({ ...defaults, ...props } as unknown as P);
}

/**
 * Composes multiple HOC wrappers into a single wrapper.
 * Applied from right to left (like function composition).
 *
 * @param wrappers Array of HOC functions
 * @returns A function that applies all wrappers to a component
 *
 * @example
 * ```ts
 * const enhance = compose(withAuth, withLogging, withTheme);
 * const EnhancedPage = enhance(Page);
 * ```
 */
export function compose<C extends Component<never, Node> = Component<unknown, HTMLElement>>(
  ...wrappers: Array<(component: C) => C>
): (component: C) => C {
  return (component: C) => wrappers.reduceRight((comp, wrapper) => wrapper(comp), component);
}
