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
// Loader data used to live in one application-global context: every
// executeLoader() replaced it, nothing restored it, and disposal left it in
// place. A component of route A could read route B's data, a disposed resource
// stayed discoverable, and concurrent SSR requests saw each other's data.
//
// Now there are two layers, both scoped per SSR request (and shared by
// duplicate module copies on the client):
//   - a RENDER stack, pushed by renderWithLoader() for exactly the duration of
//     a route component's construction — the authoritative source;
//   - an AMBIENT slot, the most recent executeLoader() whose resource has not
//     been disposed — a fallback kept for callers that do not scope renders.

interface LoaderScope {
  stack: Resource<unknown>[];
  ambient: Resource<unknown> | null;
}

const _clientScope = globalSingleton(
  Symbol.for("sibujs.routeLoader.v1"),
  (): LoaderScope => ({
    stack: [],
    ambient: null,
  }),
);

function currentScope(): LoaderScope {
  const cache = getRequestScopedCache<LoaderScope>("routeLoader");
  if (!cache) return _clientScope;
  let scope = cache.get("scope");
  if (!scope) {
    scope = { stack: [], ambient: null };
    cache.set("scope", scope);
  }
  return scope;
}

/**
 * Execute a route loader and wrap its result in a reactive Resource.
 *
 * The resource also becomes the ambient loader data for the current scope until
 * it is disposed (or another loader executes). For data that must belong to one
 * route — nested routes, overlapping navigations, several routers — render the
 * route's component inside {@link renderWithLoader}.
 */
export function executeLoader<T>(
  loader: RouteLoaderFn<T>,
  context: { params: Record<string, string>; path: string },
  options?: ResourceOptions<T>,
): Resource<T> {
  const res = resource<T>(({ signal }) => loader(context, { signal }), options);
  const scope = currentScope();
  scope.ambient = res as Resource<unknown>;

  // A disposed resource stops being discoverable — but only if it is still the
  // ambient one, so disposing a superseded loader never clears the current one.
  const disposeResource = res.dispose;
  res.dispose = () => {
    disposeResource();
    if (scope.ambient === (res as Resource<unknown>)) scope.ambient = null;
    const index = scope.stack.lastIndexOf(res as Resource<unknown>);
    if (index !== -1) scope.stack.splice(index, 1);
  };
  return res;
}

/**
 * Run `render` with `loader` as the loader data seen by `loaderData()`, then
 * restore the previous scope — even if `render` throws. Use it around a route
 * component's construction so the component reads its own route's data.
 *
 * @example
 * ```ts
 * const data = executeLoader(route.loader, ctx);
 * const view = renderWithLoader(data, () => route.component());
 * ```
 */
export function renderWithLoader<T, R>(loader: Resource<T>, render: () => R): R {
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
 * Access loader data from within a route component.
 * Must be called inside a component rendered by a route with a loader: the
 * innermost {@link renderWithLoader} scope, or else the ambient loader of the
 * current scope (per SSR request on the server).
 */
export function loaderData<T = unknown>(): {
  data: () => T | undefined;
  loading: () => boolean;
  error: () => Error | undefined;
} {
  const scope = currentScope();
  const resource = scope.stack[scope.stack.length - 1] ?? scope.ambient;
  if (!resource) {
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
