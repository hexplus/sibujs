import { batch } from "../../reactivity/batch";
import { derived } from "./derived";
import type { Accessor } from "./signal";

/**
 * Creates a writable computed value — a derived getter paired with
 * a user-provided setter. The getter works like `derived()` (lazy,
 * dependency-tracked). The setter typically updates upstream signals,
 * and the derived value recomputes on the next read.
 *
 * Returns a `[getter, setter]` tuple, matching the `signal()` API.
 *
 * @param get Computed getter — reads reactive dependencies
 * @param set Setter — called with the new value, typically updates upstream signals
 * @param options Optional: `{ name }` for devtools labeling
 *
 * @example
 * ```ts
 * const [firstName, setFirstName] = signal("John");
 * const [lastName, setLastName] = signal("Doe");
 *
 * const [fullName, setFullName] = writable(
 *   () => `${firstName()} ${lastName()}`,
 *   (name) => {
 *     const [first, ...rest] = name.split(" ");
 *     setFirstName(first);
 *     setLastName(rest.join(" "));
 *   }
 * );
 *
 * fullName();              // "John Doe"
 * setFullName("Jane Smith");
 * firstName();             // "Jane"
 * lastName();              // "Smith"
 * fullName();              // "Jane Smith"
 * ```
 */
export function writable<T>(
  get: () => T,
  set: (value: T) => void,
  options?: { name?: string },
): [Accessor<T>, (value: T) => void] {
  const getter = derived(get, options);

  const setter = (value: T): void => {
    batch(() => set(value));
  };

  return [getter, setter];
}
