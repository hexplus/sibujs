import { context as createContext } from "../core/rendering/context";
import { type Resource, type ResourceOptions, resource } from "./resource";

export type RouteLoaderFn<T = unknown> = (
  context: { params: Record<string, string>; path: string },
  info: { signal: AbortSignal },
) => Promise<T>;

export interface LoaderRoute {
  loader?: RouteLoaderFn;
  path: string;
}

const LoaderContext = createContext<Resource<unknown> | null>(null);

/**
 * Execute a route loader and wrap its result in a reactive Resource.
 */
export function executeLoader<T>(
  loader: RouteLoaderFn<T>,
  context: { params: Record<string, string>; path: string },
  options?: ResourceOptions<T>,
): Resource<T> {
  const res = resource<T>(({ signal }) => loader(context, { signal }), options);

  LoaderContext.provide(res as Resource<unknown>);
  return res;
}

/**
 * Access loader data from within a route component.
 * Must be called inside a component rendered by a route with a loader.
 */
export function loaderData<T = unknown>(): {
  data: () => T | undefined;
  loading: () => boolean;
  error: () => Error | undefined;
} {
  const resource = LoaderContext.get();
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
  if (callerSignal) {
    if (callerSignal.aborted) {
      controller.abort();
    } else {
      callerSignal.addEventListener("abort", () => controller.abort(), { once: true });
    }
  }
  return route.loader(context, { signal: controller.signal });
}
