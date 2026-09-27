/**
 * Functional component props with TypeScript inference for SibuJS.
 *
 * Provides utilities to define typed components with prop defaults,
 * nodes slots, and prop mapping — all with full TypeScript inference.
 */

import type { Component } from "../core/rendering/types";

// ============================================================================
// TYPES
// ============================================================================

/**
 * Extract the props type from a component defined with defineComponent.
 *
 * @example
 * ```ts
 * const Button = defineComponent<{ label: string }>({
 *   setup(props) { ... }
 * });
 * type ButtonProps = ComponentProps<typeof Button>; // { label: string }
 * ```
 */
export type ComponentProps<T> = T extends (props: infer P) => Node ? P : never;

/**
 * Props that include an optional nodes slot.
 */
type WithNodes<Props> = Props & { nodes?: Node | Node[] };

// ============================================================================
// defineComponent
// ============================================================================

/**
 * Define a typed component with props inference, defaults, and a setup function.
 *
 * The `setup` function receives merged props (defaults + provided) and
 * returns the component's root. TypeScript infers the full props type from the
 * generic. `R` is the root type; it defaults to `HTMLElement` (every HTML tag
 * factory's result fits) — pass it explicitly for an SVG root
 * (`defineComponent<Props, SVGSVGElement>`).
 *
 * @param config Component configuration with optional defaults and a setup function
 * @returns A component function that accepts props and returns the root
 *
 * @example
 * ```ts
 * const Button = defineComponent<{ label: string; variant?: 'primary' | 'secondary'; disabled?: boolean }>({
 *   defaults: { variant: 'primary', disabled: false },
 *   setup(props) {
 *     return button(
 *       { class: `btn btn-${props.variant}`, disabled: props.disabled },
 *       props.label,
 *     );
 *   }
 * });
 *
 * // Usage: Button({ label: 'Click me' }) — TypeScript infers props
 * ```
 */
export function defineComponent<Props extends object, R extends Node = HTMLElement>(config: {
  defaults?: Partial<Props>;
  setup: (props: Props) => R;
}): Component<Props, R> {
  const { defaults, setup } = config;

  return (props: Props): R => {
    const merged = defaults ? ({ ...defaults, ...props } as Props) : props;

    return setup(merged);
  };
}

// ============================================================================
// defineSlottedComponent
// ============================================================================

/**
 * Create a component with nodes slot support.
 *
 * Nodes are passed as a special `nodes` prop alongside the component's
 * own props. This enables composition patterns where a parent component
 * wraps arbitrary child content.
 *
 * @param config Component configuration with optional defaults and a setup function
 * @returns A component function that accepts props (including nodes) and returns the root
 *
 * @example
 * ```ts
 * const Card = defineSlottedComponent<{ title: string }>({
 *   setup(props) {
 *     const el = div({ class: 'card' });
 *     el.appendChild(h2(props.title));
 *     if (props.nodes) {
 *       const nodes = Array.isArray(props.nodes) ? props.nodes : [props.nodes];
 *       nodes.forEach(child => el.appendChild(child));
 *     }
 *     return el;
 *   }
 * });
 *
 * // Usage: Card({ title: 'Hello', nodes: p('World') })
 * ```
 */
export function defineSlottedComponent<Props extends object, R extends Node = HTMLElement>(config: {
  defaults?: Partial<Props>;
  setup: (props: WithNodes<Props>) => R;
}): Component<WithNodes<Props>, R> {
  const { defaults, setup } = config;

  return (props: WithNodes<Props>): R => {
    const merged = defaults ? ({ ...defaults, ...props } as WithNodes<Props>) : props;

    return setup(merged);
  };
}

// ============================================================================
// withProps
// ============================================================================

/**
 * Higher-order helper to create a component that maps outer props to inner props.
 *
 * Useful for adapting a generic component to a specific use case by transforming
 * the prop interface without modifying the original component.
 *
 * @param component The inner component to forward mapped props to
 * @param mapProps A function that transforms outer props into inner props
 * @returns A new component that accepts outer props
 *
 * @example
 * ```ts
 * const IconButton = defineComponent<{ icon: string; label: string; size: number }>({
 *   setup(props) { ... }
 * });
 *
 * const SmallIconButton = withProps(IconButton, (outer: { icon: string; label: string }) => ({
 *   icon: outer.icon,
 *   label: outer.label,
 *   size: 16
 * }));
 *
 * // Usage: SmallIconButton({ icon: 'star', label: 'Favorite' })
 * ```
 */
export function withProps<OuterProps extends object, InnerProps extends object, R extends Node = HTMLElement>(
  component: Component<InnerProps, R>,
  mapProps: (outer: OuterProps) => InnerProps,
): Component<OuterProps, R> {
  return (props: OuterProps): R => component(mapProps(props));
}
