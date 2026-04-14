import { derived } from "../core/signals/derived";
import { signal } from "../core/signals/signal";

// ============================================================================
// TYPES
// ============================================================================

export type ValidatorFn<T = unknown> = (value: T) => string | null;

export interface FieldConfig<T = unknown> {
  initial: T;
  validators?: ValidatorFn<T>[];
}

export type FormConfig<T extends Record<string, unknown>> = {
  [K in keyof T]: FieldConfig<T[K]>;
};

export interface FormField<T = unknown> {
  value: () => T;
  set: (v: T) => void;
  error: () => string | null;
  touched: () => boolean;
  touch: () => void;
  reset: () => void;
}

export interface FormReturn<T extends Record<string, unknown>> {
  fields: { [K in keyof T]: FormField<T[K]> };
  errors: () => Partial<Record<keyof T, string | null>>;
  isValid: () => boolean;
  isDirty: () => boolean;
  /** True while an async handleSubmit callback is in flight. Prevents double-submit. */
  submitting: () => boolean;
  touched: () => Partial<Record<keyof T, boolean>>;
  values: () => T;
  handleSubmit: (onSubmit: (values: T) => void | Promise<void>) => (e?: Event) => void;
  reset: () => void;
  setError: (field: keyof T, message: string) => void;
}

// ============================================================================
// BUILT-IN VALIDATORS
// ============================================================================

export function required(message = "This field is required"): ValidatorFn<unknown> {
  return (value: unknown) => {
    if (value == null || value === "" || (Array.isArray(value) && value.length === 0)) {
      return message;
    }
    return null;
  };
}

export function minLength(min: number, message?: string): ValidatorFn<string> {
  return (value: string) => {
    if (value && value.length < min) {
      return message || `Must be at least ${min} characters`;
    }
    return null;
  };
}

export function maxLength(max: number, message?: string): ValidatorFn<string> {
  return (value: string) => {
    if (value && value.length > max) {
      return message || `Must be at most ${max} characters`;
    }
    return null;
  };
}

export function matchesPattern(regex: RegExp, message = "Invalid format"): ValidatorFn<string> {
  return (value: string) => {
    if (value && !regex.test(value)) {
      return message;
    }
    return null;
  };
}

export function email(message = "Invalid email address"): ValidatorFn<string> {
  return matchesPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, message);
}

export function min(minVal: number, message?: string): ValidatorFn<number> {
  return (value: number) => {
    if (value != null && value < minVal) {
      return message || `Must be at least ${minVal}`;
    }
    return null;
  };
}

export function max(maxVal: number, message?: string): ValidatorFn<number> {
  return (value: number) => {
    if (value != null && value > maxVal) {
      return message || `Must be at most ${maxVal}`;
    }
    return null;
  };
}

export function custom<T>(fn: (value: T) => boolean, message: string): ValidatorFn<T> {
  return (value: T) => (fn(value) ? null : message);
}

// ============================================================================
// form HOOK
// ============================================================================

// ============================================================================
// bindField HELPER
// ============================================================================

/**
 * Props returned by bindField, ready to spread into an input tag factory.
 */
export interface BoundFieldProps {
  value: () => unknown;
  on: { input: (e: Event) => void; change: (e: Event) => void; blur: () => void };
  [attr: string]: unknown;
}

/**
 * Bind a FormField to an input element, eliminating the value/input/blur boilerplate.
 *
 * Works with text inputs (`input` event) and selects/checkboxes (`change` event).
 *
 * @param field A FormField from form().fields
 * @param extras Additional props to merge (placeholder, class, disabled, etc.)
 * @returns Props object ready to pass directly to a tag factory
 *
 * @example
 * ```ts
 * const f = form({ email: { initial: "", validators: [required(), email()] } });
 *
 * // Before — verbose
 * input({ value: f.fields.email.value(), on: { input: e => f.fields.email.set(e.target.value), blur: () => f.fields.email.touch() } })
 *
 * // After — one-liner
 * input(bindField(f.fields.email, { type: "email", placeholder: "Email" }))
 * ```
 */
export function bindField<T>(field: FormField<T>, extras?: Record<string, unknown>): BoundFieldProps {
  const fieldOn: BoundFieldProps["on"] = {
    input: (e: Event) => {
      const target = e.target as HTMLInputElement;
      if (target.type === "checkbox") {
        field.set(target.checked as unknown as T);
      } else {
        field.set(target.value as unknown as T);
      }
    },
    change: (e: Event) => {
      const target = e.target as HTMLInputElement | HTMLSelectElement;
      if ("checked" in target && target.type === "checkbox") {
        field.set(target.checked as unknown as T);
      } else {
        field.set(target.value as unknown as T);
      }
    },
    blur: () => field.touch(),
  };

  // Merge extras.on with field handlers — field handlers always win so extras
  // can't accidentally clobber the value/change/blur wiring.
  const { on: extraOn, value: _ignoreValue, ...restExtras } = (extras ?? {}) as Record<string, unknown>;
  const mergedOn =
    extraOn && typeof extraOn === "object"
      ? { ...(extraOn as Record<string, (e: Event) => void>), ...fieldOn }
      : fieldOn;

  return {
    value: field.value as () => unknown,
    on: mergedOn as BoundFieldProps["on"],
    ...restExtras,
  };
}

// ============================================================================
// form HOOK
// ============================================================================

export function form<T extends Record<string, unknown>>(config: FormConfig<T>): FormReturn<T> {
  const fieldEntries = Object.entries(config) as [keyof T, FieldConfig][];
  const fieldMap = {} as { [K in keyof T]: FormField<T[K]> };
  const [manualErrors, setManualErrors] = signal<Record<string, string | null>>({});

  for (const [name, cfg] of fieldEntries) {
    const [value, setValue] = signal<T[keyof T]>(cfg.initial as T[keyof T]);
    const [isTouched, setTouched] = signal(false);

    const error = derived<string | null>(() => {
      const manual = manualErrors();
      if (manual[name as string]) return manual[name as string];
      const val = value();
      if (!cfg.validators) return null;
      for (const validator of cfg.validators) {
        const msg = validator(val);
        if (msg) return msg;
      }
      return null;
    });

    // Wrap the setter so editing the field clears any prior manual error
    // (e.g. server-side "email already taken" must not stick after edit).
    const wrappedSet = (next: T[keyof T]) => {
      setValue(next);
      setManualErrors((prev) => {
        if (!((name as string) in prev) || prev[name as string] == null) return prev;
        const copy = { ...prev };
        copy[name as string] = null;
        return copy;
      });
    };

    fieldMap[name] = {
      value,
      set: wrappedSet,
      error,
      touched: isTouched,
      touch: () => setTouched(true),
      reset: () => {
        setValue(cfg.initial as T[keyof T]);
        setTouched(false);
        setManualErrors((prev) => ({ ...prev, [name as string]: null }));
      },
    };
  }

  const errors = derived(() => {
    const result: Partial<Record<keyof T, string | null>> = {};
    for (const [name, field] of Object.entries(fieldMap) as [keyof T, FormField][]) {
      result[name] = field.error();
    }
    return result;
  });

  const isValid = derived(() => {
    for (const field of Object.values(fieldMap) as FormField[]) {
      if (field.error() != null) return false;
    }
    return true;
  });

  const isDirty = derived(() => {
    for (const [name, cfg] of fieldEntries) {
      if (!Object.is(fieldMap[name].value(), cfg.initial)) return true;
    }
    return false;
  });

  const touchedState = derived(() => {
    const result: Partial<Record<keyof T, boolean>> = {};
    for (const [name, field] of Object.entries(fieldMap) as [keyof T, FormField][]) {
      result[name] = field.touched();
    }
    return result;
  });

  const values = derived(() => {
    const result = {} as T;
    for (const [name, field] of Object.entries(fieldMap) as [keyof T, FormField][]) {
      (result as Record<string, unknown>)[name as string] = field.value();
    }
    return result;
  });

  const [submitting, setSubmitting] = signal(false);

  function handleSubmit(onSubmit: (values: T) => void | Promise<void>) {
    return (e?: Event) => {
      if (e) e.preventDefault();
      if (submitting()) return;
      for (const field of Object.values(fieldMap) as FormField[]) {
        field.touch();
      }
      if (isValid()) {
        const result = onSubmit(values());
        if (result && typeof (result as Promise<void>).then === "function") {
          setSubmitting(true);
          (result as Promise<void>).then(
            () => setSubmitting(false),
            () => setSubmitting(false),
          );
        }
      }
    };
  }

  function reset() {
    for (const field of Object.values(fieldMap) as FormField[]) {
      field.reset();
    }
  }

  function setError(field: keyof T, message: string) {
    setManualErrors((prev) => ({ ...prev, [field as string]: message }));
  }

  return {
    fields: fieldMap,
    errors,
    isValid,
    isDirty,
    submitting,
    touched: touchedState,
    values,
    handleSubmit,
    reset,
    setError,
  };
}
