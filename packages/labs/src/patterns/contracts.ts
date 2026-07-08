/**
 * Runtime prop validation and strict typing contracts for SibuJS.
 * Provides runtime type checking for component props in development mode.
 */

declare var process: { env?: { NODE_ENV?: string } } | undefined;

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
 * In production mode (process.env.NODE_ENV === 'production'), validation is skipped
 * and only defaults are applied for performance.
 */
export function validateProps<Props extends Record<string, unknown>>(
  props: Partial<Props>,
  schema: PropSchema<Props>,
): Props {
  const result = { ...props } as Record<string, unknown>;
  const errors: string[] = [];
  const isDev = typeof process === "undefined" || process?.env?.NODE_ENV !== "production";

  for (const [key, def] of Object.entries(schema)) {
    const propDef: PropDef = typeof def === "function" ? { type: def as Validator } : (def as PropDef);

    // Apply defaults
    if (result[key] == null && propDef.default !== undefined) {
      result[key] = typeof propDef.default === "function" ? (propDef.default as () => unknown)() : propDef.default;
    }

    if (!isDev) continue; // Skip validation in production

    // Check required
    if (propDef.required && result[key] == null) {
      errors.push(`Prop '${key}' is required`);
      continue;
    }

    if (result[key] == null) continue;

    // Type validation
    if (propDef.type) {
      const typeResult = propDef.type(result[key], key);
      if (typeResult !== true) errors.push(typeResult);
    }

    // Custom validator
    if (propDef.validator) {
      const validResult = propDef.validator(result[key], key);
      if (validResult !== true) errors.push(validResult);
    }
  }

  if (errors.length > 0 && isDev) {
    console.warn(`[SibuJS] Prop validation errors:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
  }

  return result as Props;
}

// ─── defineStrictComponent ──────────────────────────────────────────────────

/**
 * Define a component with runtime prop validation.
 * Validates props in development mode, applies defaults, then calls setup.
 */
export function defineStrictComponent<Props extends Record<string, unknown>>(config: {
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
 * No-op in production builds.
 */
export function assertType<T>(value: unknown, validator: Validator<T>, label?: string): asserts value is T {
  if (typeof process !== "undefined" && process?.env?.NODE_ENV === "production") return;
  const result = validator(value as T, label || "value");
  if (result !== true) {
    throw new TypeError(`[SibuJS Contract] ${result}`);
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
