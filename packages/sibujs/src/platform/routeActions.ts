import { signal } from "@sibujs/core";
import { batch } from "@sibujs/core";

export type ActionFn<T = unknown> = (data: FormData | Record<string, unknown>) => Promise<T>;

export interface ActionResult<T> {
  data: () => T | undefined;
  error: () => Error | undefined;
  loading: () => boolean;
  submit: (data: FormData | Record<string, unknown>) => Promise<T>;
}

/**
 * Creates a managed action for handling POST/PUT/DELETE-style mutations.
 * Provides reactive loading, error, and data state via signal.
 * State updates are batched to avoid redundant notifications.
 */
export function createAction<T>(actionFn: ActionFn<T>): ActionResult<T> {
  const [data, setData] = signal<T | undefined>(undefined);
  const [error, setError] = signal<Error | undefined>(undefined);
  const [loading, setLoading] = signal<boolean>(false);

  // Sequence concurrent submits so a slower earlier call can't clobber the
  // reactive state of a faster later one. Each caller still gets its own
  // result/throw — only the shared signals are gated to the latest run.
  let activeRun = 0;

  const submit = async (input: FormData | Record<string, unknown>): Promise<T> => {
    const runId = ++activeRun;
    batch(() => {
      setLoading(true);
      setError(undefined);
    });

    try {
      const result = await actionFn(input);
      if (runId === activeRun) {
        batch(() => {
          setData(result);
          setLoading(false);
        });
      }
      return result;
    } catch (err) {
      const actionError = err instanceof Error ? err : new Error(String(err));
      if (runId === activeRun) {
        batch(() => {
          setError(actionError);
          setLoading(false);
        });
      }
      throw actionError;
    }
  };

  return { data, error, loading, submit };
}
