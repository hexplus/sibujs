import { getRequestScopedCache } from "../core/ssr-context";
import { globalSingleton } from "../utils/globalSingleton";
import { type Resource, type ResourceOptions, resource } from "./resource";

export type RouteLoaderFn<T = unknown> = (
  context: { params: Record<string, string>; path: string },
  info: { signal: AbortSignal },
) => Promise<T>;

export interface LoaderRoute {
  loader?: RouteLoaderFn;
  path: string;
}

// ─── Loader scope ───────────────────────────────────────────────────────────
//
// Loader data used to live in one application-global slot: every
// executeLoader() replaced it, so a component of route A read route B's data
// whenever B's loader happened to run later. There is no ambient loader any
// more. `loaderData()` resolves ONLY against the scope opened by
// renderWithLoader() (or withLoader()) for exactly the synchronous duration of a
// route component's construction, so unrelated loaders — overlapping
// navigations, nested routes, several routers — can never bleed together.
//
// The stack is scoped per SSR request (and shared by duplicate module copies on
// the client).

interface LoaderScope {
  stack: Resource<unknown>[];
}

const _clientScope = globalSingleton(Symbol.for("sibujs.routeLoader.v2"), (): LoaderScope => ({ stack: [] }));

// Resources whose dispose() has run. A disposed loader cannot open a scope, and
// one disposed while its scope is open stops being readable.
const _disposed = globalSingleton(Symbol.for("sibujs.routeLoader.disposed.v1"), () => new WeakSet<object>());

function currentScope(): LoaderScope {
  const cache = getRequestScopedCache<LoaderScope>("routeLoader");
  if (!cache) return _clientScope;
  let scope = cache.get("scope");
  if (!scope) {
    scope = { stack: [] };
    cache.set("scope", scope);
  }
  return scope;
}

/**
 * Execute a route loader and wrap its result in a reactive Resource.
 *
 * Executing a loader does not make its data visible to `loaderData()`; render
 * the route's component inside {@link renderWithLoader} (or use
 * {@link withLoader}) so the component reads its own route's data.
 */
export function executeLoader<T>(
  loader: RouteLoaderFn<T>,
  context: { params: Record<string, string>; path: string },
  options?: ResourceOptions<T>,
): Resource<T> {
  const res = resource<T>(({ signal }) => loader(context, { signal }), options);
  const disposeResource = res.dispose;
  res.dispose = () => {
    _disposed.add(res);
    disposeResource();
  };
  return res;
}

/**
 * Run `render` with `loader` as the loader data seen by `loaderData()`, then
 * restore the previous scope — even if `render` throws. Scopes nest: an inner
 * call shadows the outer one only for its own duration.
 *
 * `loaderData()` must be called synchronously while `render` runs (typically at
 * the top of the component); the accessors it returns stay bound to `loader`
 * afterwards.
 *
 * @example
 * ```ts
 * const data = executeLoader(route.loader, ctx);
 * const view = renderWithLoader(data, () => route.component());
 * ```
 */
export function renderWithLoader<T, R>(loader: Resource<T>, render: () => R): R {
  if (_disposed.has(loader)) {
    throw new Error("renderWithLoader: the loader resource has been disposed");
  }
  const scope = currentScope();
  const entry = loader as unknown as Resource<unknown>;
  scope.stack.push(entry);
  try {
    return render();
  } finally {
    const index = scope.stack.lastIndexOf(entry);
    if (index !== -1) scope.stack.splice(index, 1);
  }
}

/**
 * Execute `loader` and render with its data in scope, in one step. Returns the
 * rendered result together with the resource, which the caller disposes when
 * the route unmounts.
 */
export function withLoader<T, R>(
  loader: RouteLoaderFn<T>,
  context: { params: Record<string, string>; path: string },
  render: () => R,
  options?: ResourceOptions<T>,
): { view: R; resource: Resource<T> } {
  const res = executeLoader(loader, context, options);
  try {
    return { view: renderWithLoader(res, render), resource: res };
  } catch (err) {
    res.dispose();
    throw err;
  }
}

/**
 * Access loader data from within a route component: the innermost
 * {@link renderWithLoader} scope (per SSR request on the server). Throws when
 * called outside such a scope, or when that scope's loader has been disposed.
 */
export function loaderData<T = unknown>(): {
  data: () => T | undefined;
  loading: () => boolean;
  error: () => Error | undefined;
} {
  const scope = currentScope();
  const resource = scope.stack[scope.stack.length - 1];
  if (!resource || _disposed.has(resource)) {
    throw new Error("loaderData must be used inside a route with a loader");
  }
  return {
    data: resource.data as () => T | undefined,
    loading: resource.loading,
    error: resource.error,
  };
}

/**
 * Preload a route's data before navigation.
 * Returns a promise that resolves when the loader completes.
 */
export async function preloadRoute(
  route: LoaderRoute,
  context: { params: Record<string, string>; path: string },
  callerSignal?: AbortSignal,
): Promise<unknown> {
  if (!route.loader) return undefined;

  const controller = new AbortController();
  let onAbort: (() => void) | null = null;
  if (callerSignal) {
    if (callerSignal.aborted) {
      controller.abort();
    } else {
      onAbort = () => controller.abort();
      callerSignal.addEventListener("abort", onAbort, { once: true });
    }
  }
  try {
    return await route.loader(context, { signal: controller.signal });
  } finally {
    // Remove the listener once the loader settles — otherwise a long-lived /
    // shared callerSignal accumulates one dangling listener per preload.
    if (onAbort) callerSignal?.removeEventListener("abort", onAbort);
  }
}
