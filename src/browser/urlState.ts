import { signal } from "../core/signals/signal";

/**
 * urlState returns reactive getters for the current URL's search params and
 * hash, plus setters that call `history.pushState` / `replaceState`.
 *
 * Works independently of `createRouter()` — useful for apps that only need
 * to sync a handful of UI state bits with the URL (filters, tabs, modals)
 * without a full router setup.
 *
 * Listens to `popstate` so browser back/forward updates the signals.
 *
 * @example
 * ```ts
 * const url = urlState();
 * const search = derived(() => url.params().get("q") ?? "");
 * input({
 *   value: search,
 *   on: { input: (e) => {
 *     const p = new URLSearchParams(url.params());
 *     p.set("q", (e.target as HTMLInputElement).value);
 *     url.setParams(p, { replace: true });
 *   }},
 * });
 * ```
 */
export interface UrlStateOptions {
  /** Use `replaceState` instead of `pushState`. Default: false */
  replace?: boolean;
}

export function urlState(): {
  params: () => URLSearchParams;
  hash: () => string;
  setParams: (next: URLSearchParams | Record<string, string>, opts?: UrlStateOptions) => void;
  setHash: (next: string, opts?: UrlStateOptions) => void;
  dispose: () => void;
} {
  if (typeof window === "undefined") {
    const [params] = signal(new URLSearchParams());
    const [hash] = signal("");
    return {
      params,
      hash,
      setParams: () => {},
      setHash: () => {},
      dispose: () => {},
    };
  }

  const [params, setParamsSignal] = signal(new URLSearchParams(window.location.search));
  const [hash, setHashSignal] = signal(window.location.hash);

  const syncFromLocation = () => {
    setParamsSignal(new URLSearchParams(window.location.search));
    setHashSignal(window.location.hash);
  };

  const onPopState = () => syncFromLocation();
  window.addEventListener("popstate", onPopState);

  function setParams(next: URLSearchParams | Record<string, string>, opts: UrlStateOptions = {}) {
    const p = next instanceof URLSearchParams ? next : new URLSearchParams(next);
    const query = p.toString();
    const newUrl = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
    if (opts.replace) window.history.replaceState(null, "", newUrl);
    else window.history.pushState(null, "", newUrl);
    setParamsSignal(new URLSearchParams(p));
  }

  function setHash(next: string, opts: UrlStateOptions = {}) {
    const normalized = next.startsWith("#") ? next : next ? `#${next}` : "";
    const newUrl = `${window.location.pathname}${window.location.search}${normalized}`;
    if (opts.replace) window.history.replaceState(null, "", newUrl);
    else window.history.pushState(null, "", newUrl);
    setHashSignal(normalized);
  }

  function dispose() {
    window.removeEventListener("popstate", onPopState);
  }

  return { params, hash, setParams, setHash, dispose };
}
