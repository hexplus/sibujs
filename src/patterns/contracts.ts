/**
 * Runtime prop validation and strict typing contracts for SibuJS.
 * Provides runtime type checking for component props in development mode.
 *
 * Both diagnostics here gate on `DEV`, the same foldable flag the rest of the
 * framework uses, so a `__SIBU_DEV__: false` define removes them and their
 * message text entirely. They used to test `process.env.NODE_ENV` directly,
 * which is not a `define` target and does not exist in a browser at all — so
 * every browser build treated itself as development: `validateProps` ran and
 * warned, `assertType` threw, and the strings shipped. That went unnoticed
 * while these functions were reachable only through a bundler; putting
 * `patterns` on the CDN made them a production artifact.
 */

import { DEV, devWarn } from "../core/dev";

declare const __SIBU_DEV__: boolean | undefined;

// The gate is written INLINE at both call sites below, not hoisted into a
// const, and it leads with the BARE `__SIBU_DEV__`.
//
// Only a bare identifier is a `define` target, and a define is substituted
// early — before dead-code elimination runs. The imported `DEV` const is
// inlined LATE: esbuild folded it to `!1` and then left `if (!1) { … }`
// standing, so the whole assertion body and its message shipped in the
// production CDN bundle behind a condition that could never be true. `devWarn`
// has used this shape for the same reason; `tests/dist-artifacts.test.ts` now
// asserts the result on the published bytes.

// ─── Type Validators ────────────────────────────────────────────────────────

/** Validator function: returns true if valid, or an error message string. */
export type Validator<T = unknown> = (value: T, propName: string) => true | string;

/** Built-in validators */
export const validators = {
  string: ((value: unknown, name: string): true | string =>
    typeof value === "string" || `${name} must be a string, got ${typeof value}`) as Validator,
  number: ((value: unknown, name: string): true | string =>
    typeof value === "number" || `${name} must be a number, got ${typeof value}`) as Validator,
  boolean: ((value: unknown, name: string): true | string =>
    typeof value === "boolean" || `${name} must be a boolean, got ${typeof value}`) as Validator,
  function: ((value: unknown, name: string): true | string =>
    typeof value === "function" || `${name} must be a function, got ${typeof value}`) as Validator,
  object: ((value: unknown, name: string): true | string =>
    (typeof value === "object" && value !== null) || `${name} must be an object`) as Validator,
  array: ((value: unknown, name: string): true | string =>
    Array.isArray(value) || `${name} must be an array`) as Validator,
  required: ((value: unknown, name: string): true | string => value != null || `${name} is required`) as Validator,
  oneOf:
    <T>(...values: T[]): Validator<T> =>
    (value, name) =>
      values.includes(value) || `${name} must be one of: ${values.join(", ")}`,
  instanceOf:
    <T>(ctor: new (...args: unknown[]) => T): Validator<T> =>
    (value, name) =>
      value instanceof (ctor as unknown as abstract new (...args: unknown[]) => T) ||
      `${name} must be an instance of ${(ctor as unknown as { name: string }).name}`,
  arrayOf:
    (itemValidator: Validator): Validator<unknown[]> =>
    (value, name) => {
      if (!Array.isArray(value)) return `${name} must be an array`;
      for (let i = 0; i < value.length; i++) {
        const result = itemValidator(value[i], `${name}[${i}]`);
        if (result !== true) return result;
      }
      return true;
    },
  shape:
    (schema: Record<string, Validator>): Validator<Record<string, unknown>> =>
    (value, name) => {
      if (typeof value !== "object" || value === null) return `${name} must be an object`;
      for (const [key, validator] of Object.entries(schema)) {
        const result = validator((value as Record<string, unknown>)[key], `${name}.${key}`);
        if (result !== true) return result;
      }
      return true;
    },
  optional:
    (validator: Validator): Validator =>
    (value, name) => {
      if (value == null) return true;
      return validator(value, name);
    },
  range:
    (min: number, max: number): Validator<number> =>
    (value, name) => {
      if (typeof value !== "number") return `${name} must be a number`;
      return (value >= min && value <= max) || `${name} must be between ${min} and ${max}`;
    },
  pattern:
    (regex: RegExp): Validator<string> =>
    (value, name) => {
      if (typeof value !== "string") return `${name} must be a string`;
      return regex.test(value) || `${name} must match pattern ${regex}`;
    },
};

// ─── PropSchema ─────────────────────────────────────────────────────────────

export interface PropDef<T = unknown> {
  type?: Validator<T>;
  required?: boolean;
  default?: T | (() => T);
  validator?: Validator<T>;
}

export type PropSchema<Props> = {
  [K in keyof Props]: PropDef<Props[K]> | Validator<Props[K]>;
};

// ─── validateProps ──────────────────────────────────────────────────────────

/**
 * Validate props against a schema. Returns validated props with defaults applied.
 * In production builds validation is skipped and only defaults are applied, so the
 * returned value is the same either way — only the checking disappears.
 */
/**
 * Normalize one schema entry and apply its default, returning the normalized
 * definition.
 *
 * A module-level function rather than a closure inside `validateProps`: a
 * closure would be allocated on every call, which is the cost this whole
 * arrangement exists to avoid.
 *
 * @param result - The props object being built, mutated in place.
 * @param key - The property being settled.
 * @param def - Its schema entry, in either the shorthand or object form.
 * @returns The normalized definition, for the caller to validate against.
 */
function applyDefault(result: Record<string, unknown>, key: string, def: unknown): PropDef {
  const propDef: PropDef = typeof def === "function" ? { type: def as Validator } : (def as PropDef);
  if (result[key] == null && propDef.default !== undefined) {
    result[key] = typeof propDef.default === "function" ? (propDef.default as () => unknown)() : propDef.default;
  }
  return propDef;
}

export function validateProps<Props extends object>(props: Partial<Props>, schema: PropSchema<Props>): Props {
  const result = { ...props } as Record<string, unknown>;

  // TWO LOOPS, one per mode — not one loop with a guard inside it, and not two
  // passes over the same schema.
  //
  // Ordering is observable. Defaults and validators are user callbacks that may
  // read or write outside state, so each property must be finished — normalize,
  // default, validate — before the next one starts. Running every default and
  // then every validator reorders those calls: a later property's factory would
  // observe state an earlier property's validator had not yet written.
  //
  // The `errors` array must be declared INSIDE the guarded branch. Hoisted
  // above a shared loop it outlived the fold as a dead `[]`, allocated on every
  // production call and never read.
  if (typeof __SIBU_DEV__ !== "undefined" ? __SIBU_DEV__ : DEV) {
    const errors: string[] = [];

    for (const [key, def] of Object.entries(schema)) {
      const propDef = applyDefault(result, key, def);

      if (propDef.required && result[key] == null) {
        errors.push(`Prop '${key}' is required`);
        continue;
      }

      if (result[key] == null) continue;

      if (propDef.type) {
        const typeResult = propDef.type(result[key], key);
        if (typeResult !== true) errors.push(typeResult);
      }

      if (propDef.validator) {
        const validResult = propDef.validator(result[key], key);
        if (validResult !== true) errors.push(validResult);
      }
    }

    if (errors.length > 0) {
      devWarn(`Prop validation errors:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
    }

    return result as Props;
  }

  // Production: defaults only, in the same order, allocating nothing extra.
  for (const [key, def] of Object.entries(schema)) applyDefault(result, key, def);
  return result as Props;
}

// ─── defineStrictComponent ──────────────────────────────────────────────────

/**
 * Define a component with runtime prop validation.
 * Validates props in development mode, applies defaults, then calls setup.
 */
export function defineStrictComponent<Props extends object>(config: {
  name: string;
  props: PropSchema<Props>;
  setup: (props: Props) => HTMLElement;
}): (props: Partial<Props>) => HTMLElement {
  return (props: Partial<Props>) => {
    const validated = validateProps(props, config.props);
    return config.setup(validated);
  };
}

// ─── Contract / Interface assertions ────────────────────────────────────────

/**
 * Assert that a value satisfies a contract at runtime.
 *
 * No-op in production builds — genuinely, now. The previous guard returned early
 * only when `process` existed, so in a browser it fell through and threw.
 */
export function assertType<T>(value: unknown, validator: Validator<T>, label?: string): asserts value is T {
  // Wrapped rather than an early `return` for the same reason as the loop
  // above: code after an unconditional return is unreachable, not deleted, so
  // the assertion body and its message shipped in production.
  if (typeof __SIBU_DEV__ !== "undefined" ? __SIBU_DEV__ : DEV) {
    const result = validator(value as T, label || "value");
    if (result !== true) {
      throw new TypeError(`[SibuJS Contract] ${result}`);
    }
  }
}

/**
 * Create a type guard function from a validator.
 */
export function createGuard<T>(validator: Validator<T>): (value: unknown) => value is T {
  return (value: unknown): value is T => {
    return validator(value as T, "value") === true;
  };
}
