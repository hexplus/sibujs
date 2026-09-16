import { signal } from "../core/signals/signal";

// ============================================================================
// FORM ACTION
// ============================================================================
//
// Connective tissue for async form submission. Sibujs already has `form()`
// for field-level state and `optimistic()` for rollback — `formAction()`
// wraps the async side so a single helper produces reactive pending /
// error / result signals plus a ready-to-attach submit handler.
//
// `formAction(fn)` takes an async function and returns a handle with
//   - `run(...args)` — invokes the async function
//   - `pending`      — reactive boolean
//   - `error`        — reactive last error
//   - `result`       — reactive last resolved value
//   - `reset()`      — clear error + result, keep pending if still running
//   - `onSubmit`     — a ready-to-attach submit handler for a <form>
//
// Stale responses are dropped: if `run()` is called while the previous
// call is still in flight, the older result is ignored on resolution.
// This matches `asyncDerived()`'s behavior and prevents form-flicker
// when users double-click submit.

/** The parts of a form-action handle available for every action signature. */
export interface FormActionState<TArgs extends unknown[], TResult> {
  /** Invoke the action. Rejections become `error()`, resolutions `result()`. */
  run: (...args: TArgs) => Promise<void>;
  /** True while the underlying promise is unresolved. */
  pending: () => boolean;
  /** Last caught error, or `null`. */
  error: () => unknown;
  /** Last resolved value, or `null`. */
  result: () => TResult | null;
  /** Clear result and error without affecting an in-flight call. */
  reset: () => void;
}

/** The submit-handler part of a form-action handle. */
export interface FormActionSubmit {
  /**
   * A ready-to-attach submit handler for `<form>` elements. Calls
   * `e.preventDefault()`, builds a `FormData`, and passes it to the
   * underlying action as its only argument.
   */
  onSubmit: (e: Event) => void;
}

/**
 * Handle returned by {@link formAction}.
 *
 * `onSubmit` calls the action with exactly one `FormData`, so it is part of the
 * type only when that call is valid for the action — `(data: FormData) => …`
 * or `(data?: FormData) => …`. For any other signature (numeric, zero- or
 * multi-argument) it is omitted rather than silently handing the action a
 * `FormData` it does not expect.
 */
export type FormActionHandle<TArgs extends unknown[], TResult> = FormActionState<TArgs, TResult> &
  ([FormData] extends TArgs ? FormActionSubmit : Record<never, never>);

/**
 * Wrap an async function into a reactive form-action handle.
 *
 * @example
 * ```ts
 * const save = formAction(async (data: FormData) => {
 *   const res = await fetch("/api/save", { method: "POST", body: data });
 *   if (!res.ok) throw new Error("Save failed");
 *   return res.json();
 * });
 *
 * form({ on: { submit: save.onSubmit } }, [
 *   input({ name: "title" }),
 *   button({ disabled: save.pending }, () => (save.pending() ? "Saving..." : "Save")),
 *   when(() => save.error() != null, () => div("error", () => String(save.error()))),
 * ]);
 * ```
 */
export function formAction<TArgs extends unknown[], TResult>(
  fn: (...args: TArgs) => Promise<TResult>,
): FormActionHandle<TArgs, TResult> {
  const [pending, setPending] = signal(false);
  const [error, setError] = signal<unknown>(null);
  const [result, setResult] = signal<TResult | null>(null);

  let runId = 0;

  async function run(...args: TArgs): Promise<void> {
    const currentId = ++runId;
    setPending(true);
    setError(null);
    try {
      const value = await fn(...args);
      if (currentId !== runId) return; // stale — a newer run started
      setResult(value);
    } catch (err) {
      if (currentId !== runId) return;
      setError(err);
    } finally {
      if (currentId === runId) setPending(false);
    }
  }

  function reset(): void {
    setError(null);
    setResult(null);
  }

  function onSubmit(e: Event): void {
    e.preventDefault();
    const formEl = e.currentTarget as HTMLFormElement | null;
    if (!formEl || typeof FormData === "undefined") return;
    const data = new FormData(formEl);
    // `FormActionHandle` only exposes `onSubmit` when a single-FormData call is
    // valid for the action, so the forwarding cast is sound for every caller
    // that can reach this handler through the public type.
    (run as unknown as (d: FormData) => Promise<void>)(data);
  }

  // The runtime object always carries `onSubmit`; the conditional return type
  // is what removes it from signatures it would not suit.
  return { run, pending, error, result, reset, onSubmit } as FormActionHandle<TArgs, TResult>;
}
