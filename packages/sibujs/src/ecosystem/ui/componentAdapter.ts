import type { TagProps } from "@sibujs/core";
import { tagFactory } from "@sibujs/core";
import { signal } from "@sibujs/core";

// ---------------------------------------------------------------------------
// Theme System
// ---------------------------------------------------------------------------

export interface ThemeConfig {
  /** CSS class prefix for the design system (e.g., "mdc", "ant", "chakra") */
  prefix: string;
  /** CSS variables to inject as custom properties */
  variables?: Record<string, string>;
  /** Overrides for default class mappings */
  classOverrides?: Record<string, string>;
}

export interface ThemeAPI {
  /** Get the current theme config reactively */
  config: () => ThemeConfig;
  /** Update the theme */
  setTheme: (config: Partial<ThemeConfig>) => void;
  /** Resolve a component class name using prefix and overrides */
  resolveClass: (component: string, variant?: string) => string;
}

/**
 * Creates a reactive theme for a UI component library adapter.
 */
export function createTheme(initial: ThemeConfig): ThemeAPI {
  const [getConfig, setConfig] = signal<ThemeConfig>(initial);

  function resolveClass(component: string, variant?: string): string {
    const config = getConfig();
    const overrideKey = variant ? `${component}-${variant}` : component;

    if (config.classOverrides?.[overrideKey]) {
      return config.classOverrides[overrideKey];
    }

    const base = `${config.prefix}-${component}`;
    return variant ? `${base} ${config.prefix}-${component}--${variant}` : base;
  }

  function setTheme(partial: Partial<ThemeConfig>): void {
    setConfig((prev) => ({ ...prev, ...partial }));
  }

  return { config: getConfig, setTheme, resolveClass };
}

// ---------------------------------------------------------------------------
// Component Adapter
// ---------------------------------------------------------------------------

export interface ComponentMapping {
  /** HTML tag to use (default: "div") */
  tag?: string;
  /** Base CSS class for this component */
  baseClass: string;
  /** Variant-to-class mapping */
  variants?: Record<string, string>;
  /** Size-to-class mapping */
  sizes?: Record<string, string>;
  /** Additional default props */
  defaultProps?: Partial<TagProps>;
}

export interface AdapterConfig {
  /** Name of the CSS framework */
  name: string;
  /** CSS class prefix */
  prefix: string;
  /** Component mappings */
  components: Record<string, ComponentMapping>;
}

export interface AdaptedComponentProps extends TagProps {
  /** Component variant (e.g., "primary", "outlined") */
  variant?: string;
  /** Component size (e.g., "sm", "md", "lg") */
  size?: string;
}

export type AdaptedComponent = (props?: AdaptedComponentProps) => Element;

/**
 * Creates a set of SibuJS components from a CSS framework's class mappings.
 *
 * @example
 * ```ts
 * const adapter = componentAdapter({
 *   name: "material",
 *   prefix: "mdc",
 *   components: {
 *     Button: {
 *       tag: "button",
 *       baseClass: "mdc-button",
 *       variants: { raised: "mdc-button--raised" },
 *       sizes: { sm: "mdc-button--dense" },
 *     },
 *   },
 * });
 *
 * const { Button } = adapter.components;
 * Button({ variant: "raised" }, "Click me");
 * ```
 */
export function componentAdapter(config: AdapterConfig): {
  name: string;
  components: Record<string, AdaptedComponent>;
  theme: ThemeAPI;
} {
  const theme = createTheme({ prefix: config.prefix });

  const components: Record<string, AdaptedComponent> = {};

  for (const [name, mapping] of Object.entries(config.components)) {
    const factory = tagFactory(mapping.tag || "div");

    components[name] = (props: AdaptedComponentProps = {}): Element => {
      const { variant, size, class: userClass, ...rest } = props;

      const classes: string[] = [mapping.baseClass];

      if (variant && mapping.variants?.[variant]) {
        classes.push(mapping.variants[variant]);
      }

      if (size && mapping.sizes?.[size]) {
        classes.push(mapping.sizes[size]);
      }

      let finalClass: string | (() => string);
      if (typeof userClass === "function") {
        finalClass = () => {
          const extra = (userClass as () => string)();
          return extra ? `${classes.join(" ")} ${extra}` : classes.join(" ");
        };
      } else if (typeof userClass === "string" && userClass) {
        finalClass = `${classes.join(" ")} ${userClass}`;
      } else {
        finalClass = classes.join(" ");
      }

      const mergedProps: TagProps = {
        ...mapping.defaultProps,
        ...rest,
        class: finalClass,
      };

      return factory(mergedProps);
    };
  }

  return { name: config.name, components, theme };
}
