import type { TagProps } from "../../core/rendering/tagFactory";
import { tagFactory } from "../../core/rendering/tagFactory";
import type { NodeChildren } from "../../core/rendering/types";
import { effect } from "../../core/signals/effect";
import { signal } from "../../core/signals/signal";
import { globalSingleton } from "../../utils/globalSingleton";

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

// ─── Theme variable layers ──────────────────────────────────────────────────
//
// Several applyTo() handles may set the same variable on the same root, and are
// released in any order. Each (root, property) keeps the value and priority it
// had before the first layer, plus one layer per handle in application order.
// The most recently applied live layer wins; releasing any layer recomputes the
// property, and releasing the last one restores the original.

interface PropertyLayers {
  original: { value: string; priority: string };
  layers: Array<{ handle: object; value: string }>;
}

const _themeLayers = globalSingleton(
  Symbol.for("sibujs.themeLayers.v1"),
  () => new WeakMap<HTMLElement, Map<string, PropertyLayers>>(),
);

function commitThemeProperty(root: HTMLElement, name: string, record: PropertyLayers): void {
  const top = record.layers[record.layers.length - 1];
  if (top) {
    root.style.setProperty(name, top.value);
    return;
  }
  _themeLayers.get(root)?.delete(name);
  if (record.original.value === "") root.style.removeProperty(name);
  else root.style.setProperty(name, record.original.value, record.original.priority);
}

function setThemeLayer(root: HTMLElement, name: string, handle: object, value: string): void {
  let properties = _themeLayers.get(root);
  if (!properties) _themeLayers.set(root, (properties = new Map()));
  let record = properties.get(name);
  if (!record) {
    record = {
      original: { value: root.style.getPropertyValue(name), priority: root.style.getPropertyPriority(name) },
      layers: [],
    };
    properties.set(name, record);
  }
  const layer = record.layers.find((l) => l.handle === handle);
  if (layer) layer.value = value;
  else record.layers.push({ handle, value });
  commitThemeProperty(root, name, record);
}

function removeThemeLayer(root: HTMLElement, name: string, handle: object): void {
  const record = _themeLayers.get(root)?.get(name);
  if (!record) return;
  const index = record.layers.findIndex((l) => l.handle === handle);
  if (index === -1) return;
  record.layers.splice(index, 1);
  commitThemeProperty(root, name, record);
}

export interface ThemeAPI {
  /** Get the current theme config reactively */
  config: () => ThemeConfig;
  /** Update the theme */
  setTheme: (config: Partial<ThemeConfig>) => void;
  /** Resolve a component class name using prefix and overrides */
  resolveClass: (component: string, variant?: string) => string;
  /**
   * Install the theme's CSS variables on `root` (the theme root — typically the
   * app container) and keep them in sync: variables added, changed or removed by
   * `setTheme()` are reflected, and custom properties the theme never set are left
   * alone. Handles may overlap on one root and be released in any order: the
   * most recently applied live handle's value wins, and when no handle sets a
   * property any more, the value and priority it had before are restored.
   * Returns a function that stops syncing and releases this handle.
   */
  applyTo: (root: HTMLElement) => () => void;
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

  function applyTo(root: HTMLElement): () => void {
    const handle = {};
    let applied = new Set<string>();
    const stop = effect(() => {
      const variables = getConfig().variables ?? {};
      const next = new Set(Object.keys(variables));
      for (const name of applied) {
        if (!next.has(name)) removeThemeLayer(root, name, handle);
      }
      for (const [name, value] of Object.entries(variables)) setThemeLayer(root, name, handle, value);
      applied = next;
    });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      stop();
      for (const name of applied) removeThemeLayer(root, name, handle);
      applied.clear();
    };
  }

  return { config: getConfig, setTheme, resolveClass, applyTo };
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

/**
 * A component produced by {@link componentAdapter}. Children may be passed
 * positionally, exactly like a tag factory: `Button({ variant: "primary" }, "Save")`.
 * Positional children take precedence over a `nodes` prop.
 */
export type AdaptedComponent = (props?: AdaptedComponentProps, children?: NodeChildren) => Element;

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

  // Classes in a mapping are written with the adapter's configured prefix
  // (`tui-button`). When the theme prefix changes, that leading prefix is
  // swapped for the current one, so `setTheme({ prefix })` restyles output.
  const reprefix = (cls: string, prefix: string): string =>
    prefix !== config.prefix && cls.startsWith(`${config.prefix}-`)
      ? `${prefix}-${cls.slice(config.prefix.length + 1)}`
      : cls;

  const components: Record<string, AdaptedComponent> = {};

  for (const [name, mapping] of Object.entries(config.components)) {
    const factory = tagFactory(mapping.tag || "div");

    components[name] = (props: AdaptedComponentProps = {}, children?: NodeChildren): Element => {
      const { variant, size, class: userClass, ...rest } = props;

      // Read the theme inside the class getter, so components reflect the
      // theme's overrides and prefix at creation AND whenever it changes. The
      // returned theme was previously never consulted by any component.
      // Override keys: `<Component>` replaces the base class, `<Component>-<variant>`
      // the variant class and `<Component>-<size>` the size class.
      const themeClasses = (): string => {
        const current = theme.config();
        const overrides = current.classOverrides ?? {};
        const pick = (key: string, fallback: string): string =>
          Object.hasOwn(overrides, key) ? overrides[key] : reprefix(fallback, current.prefix);

        const classes: string[] = [pick(name, mapping.baseClass)];
        if (variant && mapping.variants?.[variant]) {
          classes.push(pick(`${name}-${variant}`, mapping.variants[variant]));
        }
        if (size && mapping.sizes?.[size]) {
          classes.push(pick(`${name}-${size}`, mapping.sizes[size]));
        }
        return classes.filter(Boolean).join(" ");
      };

      const finalClass = (): string => {
        const base = themeClasses();
        const extra = typeof userClass === "function" ? (userClass as () => string)() : userClass;
        return typeof extra === "string" && extra ? `${base} ${extra}` : base;
      };

      const mergedProps: TagProps = {
        ...mapping.defaultProps,
        ...rest,
        class: finalClass,
      };

      // Forward positional children; tagFactory gives them precedence over `nodes`.
      return children === undefined ? factory(mergedProps) : factory(mergedProps, children);
    };
  }

  return { name: config.name, components, theme };
}
