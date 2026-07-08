import { signal } from "@sibujs/core";

/**
 * urlState returns reactive getters for the current URL's search params and
 * hash, plus setters that call `history.pushState` / `replaceState`.
 *
 * Works independently of `createRouter()` — useful for apps that only need
 * to sync a handful of UI state bits with the URL (filters, tabs, modals)
 * without a full router setup.
 *
 * Listens to both `popstate` (back/forward) and `hashchange` (anchor clicks,
 * direct `location.hash` assignments) so the signals stay in sync regardless
 * of how the URL was changed.
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

  let lastSearch = window.location.search;
  let lastHash = window.location.hash;

  const [params, setParamsSignal] = signal(new URLSearchParams(lastSearch));
  const [hash, setHashSignal] = signal(lastHash);

  function syncFromLocation() {
    const currentSearch = window.location.search;
    const currentHash = window.location.hash;
    if (currentSearch !== lastSearch) {
      lastSearch = currentSearch;
      setParamsSignal(new URLSearchParams(currentSearch));
    }
    if (currentHash !== lastHash) {
      lastHash = currentHash;
      setHashSignal(currentHash);
    }
  }

  window.addEventListener("popstate", syncFromLocation);
  window.addEventListener("hashchange", syncFromLocation);

  function setParams(next: URLSearchParams | Record<string, string>, opts: UrlStateOptions = {}) {
    const p = next instanceof URLSearchParams ? next : new URLSearchParams(next);
    const query = p.toString();
    const newUrl = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
    if (opts.replace) window.history.replaceState(null, "", newUrl);
    else window.history.pushState(null, "", newUrl);
    lastSearch = window.location.search;
    setParamsSignal(new URLSearchParams(p));
  }

  function setHash(next: string, opts: UrlStateOptions = {}) {
    const normalized = next && next !== "#" ? (next.startsWith("#") ? next : `#${next}`) : "";
    const newUrl = `${window.location.pathname}${window.location.search}${normalized}`;
    if (opts.replace) window.history.replaceState(null, "", newUrl);
    else window.history.pushState(null, "", newUrl);
    lastHash = normalized;
    setHashSignal(normalized);
  }

  function dispose() {
    window.removeEventListener("popstate", syncFromLocation);
    window.removeEventListener("hashchange", syncFromLocation);
  }

  return { params, hash, setParams, setHash, dispose };
}
