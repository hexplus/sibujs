/**
 * Higher-order component utilities for SibuJS.
 * These functions wrap or compose components to add behavior.
 */

type Component<P = unknown> = (props: P) => HTMLElement;

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
export function withWrapper<P>(
  WrappedComponent: Component<P>,
  wrapper: (component: Component<P>, props: P) => HTMLElement,
): Component<P> {
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
export function withDefaults<P extends Record<string, unknown>>(
  component: Component<P>,
  defaults: Partial<P>,
): Component<Partial<P>> {
  return (props: Partial<P>) => component({ ...defaults, ...props } as P);
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
export function compose(...wrappers: Array<(component: Component) => Component>): (component: Component) => Component {
  return (component: Component) => wrappers.reduceRight((comp, wrapper) => wrapper(comp), component);
}
