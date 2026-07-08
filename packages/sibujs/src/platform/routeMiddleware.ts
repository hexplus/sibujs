export type MiddlewareFn = (
  context: { path: string; params: Record<string, string> },
  next: () => void | Promise<void>,
) => void | Promise<void>;

/**
 * Composes multiple middleware functions into a single middleware.
 * Each middleware must call next() to proceed to the next one.
 */
export function composeMiddleware(...fns: MiddlewareFn[]): MiddlewareFn {
  return async (context, next) => {
    let index = -1;

    const dispatch = async (i: number): Promise<void> => {
      if (i <= index) {
        throw new Error("next() called multiple times");
      }
      index = i;

      if (i < fns.length) {
        await fns[i](context, () => dispatch(i + 1));
      } else {
        await next();
      }
    };

    await dispatch(0);
  };
}

/**
 * Creates a middleware chain with a builder API.
 * Use `use()` to add middleware, and `run()` to execute the chain.
 */
export function createMiddlewareChain(): {
  use: (fn: MiddlewareFn) => void;
  run: (context: { path: string; params: Record<string, string> }) => Promise<void>;
} {
  const middlewares: MiddlewareFn[] = [];

  const use = (fn: MiddlewareFn): void => {
    middlewares.push(fn);
  };

  const run = async (context: { path: string; params: Record<string, string> }): Promise<void> => {
    const composed = composeMiddleware(...middlewares);
    await composed(context, () => {});
  };

  return { use, run };
}
