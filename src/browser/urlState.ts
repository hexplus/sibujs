import { signal } from "../core/signals/signal";
import { globalSingleton } from "../utils/globalSingleton";

// Every live urlState() instance, keyed by its sync function. History API writes
// do not fire `popstate`, so after a framework write every instance is told to
// re-read the location — otherwise independently mounted instances disagree
// about the URL until the next native navigation. Shared through
// globalSingleton so duplicate copies of this module coordinate too.
const _url = globalSingleton(Symbol.for("sibujs.urlState.v1"), () => ({
  instances: new Set<() => void>(),
}));

function notifyUrlWrite(): void {
  for (const sync of Array.from(_url.instances)) sync();
}

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
  /**
   * The history entry's state. When omitted, the current `history.state` is
   * kept — on a replaced entry and carried forward onto a pushed one — so router
   * metadata, scroll restoration data and application state are not erased. A
   * pushed entry does not inherit `scrollRestoration()`'s entry identity
   * (`__sibuScrollKey`), which belongs to the entry it was set on.
   * Pass it (including `null`) only to set new state deliberately.
   */
  state?: unknown;
}

/**
 * Default history-state slot `scrollRestoration()` uses to identify an entry.
 * Carrying it onto a NEW entry would give two entries the same identity, so
 * both would restore the same scroll position.
 */
const SCROLL_ENTRY_KEY = "__sibuScrollKey";

/** Carried-forward state for a pushed entry, minus per-entry identity. */
function withoutEntryIdentity(state: unknown): unknown {
  if (state === null || typeof state !== "object" || !Object.hasOwn(state, SCROLL_ENTRY_KEY)) return state;
  const { [SCROLL_ENTRY_KEY]: _identity, ...rest } = state as Record<string, unknown>;
  return rest;
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
  _url.instances.add(syncFromLocation);

  function writeHistory(newUrl: string, opts: UrlStateOptions) {
    // `in` rather than `!== undefined`: an explicit `state: undefined` is still
    // an explicit choice. Falsy existing states (0, false, "") are kept as-is.
    const state = "state" in opts ? opts.state : window.history.state;
    if (opts.replace) window.history.replaceState(state, "", newUrl);
    else window.history.pushState("state" in opts ? state : withoutEntryIdentity(state), "", newUrl);
  }

  function setParams(next: URLSearchParams | Record<string, string>, opts: UrlStateOptions = {}) {
    const p = next instanceof URLSearchParams ? next : new URLSearchParams(next);
    const query = p.toString();
    const newUrl = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
    writeHistory(newUrl, opts);
    lastSearch = window.location.search;
    setParamsSignal(new URLSearchParams(p));
    notifyUrlWrite();
  }

  function setHash(next: string, opts: UrlStateOptions = {}) {
    const normalized = next && next !== "#" ? (next.startsWith("#") ? next : `#${next}`) : "";
    const newUrl = `${window.location.pathname}${window.location.search}${normalized}`;
    writeHistory(newUrl, opts);
    lastHash = normalized;
    setHashSignal(normalized);
    notifyUrlWrite();
  }

  let disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    window.removeEventListener("popstate", syncFromLocation);
    window.removeEventListener("hashchange", syncFromLocation);
    _url.instances.delete(syncFromLocation);
  }

  return { params, hash, setParams, setHash, dispose };
}
