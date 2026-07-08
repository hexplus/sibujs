// ---------------------------------------------------------------------------
// Island runtime — partial hydration as a runtime primitive, no meta-framework.
//
// Server HTML declares islands and *when* to activate them:
//   <div data-sibu-island="counter" data-sibu-load="visible"> … server HTML … </div>
//
// The client registers each island's setup (inline or lazily imported) and calls
// mountIslands() once. Each island is `enhance`d in place when its strategy
// fires — so a page can ship ~0 JS for below-the-fold / idle islands, and never
// re-renders the server markup.
// ---------------------------------------------------------------------------

import { globalSingleton } from "../utils/globalSingleton";
import { type EnhanceSetup, enhance } from "./enhance";

/** When an island activates. Declared per-element via `data-sibu-load`. */
export type IslandStrategy = "load" | "idle" | "visible" | "interaction" | "media";

/** A lazy code loader: resolves to an island setup (or a module whose `default`
 *  is one). Only fetched when the island activates. Wrap with {@link lazyIsland}. */
export type IslandLoader = () => Promise<EnhanceSetup | { default: EnhanceSetup }>;

/** Either an inline setup, or a {@link lazyIsland}-branded loader. */
export type IslandRegistration = EnhanceSetup | IslandLoader;

/** Island ids appear in attribute selectors and registry lookups. */
const SAFE_NAME = /^[A-Za-z0-9_-]+$/;
/** Brand distinguishing a lazy loader from an inline setup (both are functions). */
const LAZY = Symbol.for("sibujs.islands.lazy");

// Shared across duplicate runtime copies so islands registered through one copy
// are mountable by mountIslands() called through another.
const registry = globalSingleton(Symbol.for("sibujs.islands.registry.v1"), () => new Map<string, IslandRegistration>());

/**
 * Mark a loader as lazy island code — its module is fetched only when the island
 * activates, so a page ships ~0 JS for islands that never trigger.
 *
 * @example
 * ```ts
 * registerIsland("chart", lazyIsland(() => import("./islands/chart.js")));
 * ```
 */
export function lazyIsland(loader: IslandLoader): IslandLoader {
  (loader as unknown as Record<symbol, unknown>)[LAZY] = true;
  return loader;
}

/**
 * Register an island by name. The setup is applied via `enhance()` when a
 * matching `[data-sibu-island="name"]` element activates.
 *
 * @example
 * ```ts
 * registerIsland("counter", (ctx) => {
 *   const [n, setN] = signal(0);
 *   ctx.text("@n", () => n());
 *   ctx.on("@inc", "click", () => setN((v) => v + 1));
 * });
 * ```
 */
export function registerIsland(name: string, setup: IslandRegistration): void {
  if (!SAFE_NAME.test(name)) {
    throw new Error(`[SibuJS islands] name must match [A-Za-z0-9_-]+ (got: ${JSON.stringify(name.slice(0, 32))})`);
  }
  registry.set(name, setup);
}

/** Remove a registration (mainly for tests / HMR). */
export function unregisterIsland(name: string): void {
  registry.delete(name);
}

async function resolveSetup(reg: IslandRegistration): Promise<EnhanceSetup | null> {
  if (typeof reg === "function" && (reg as unknown as Record<symbol, unknown>)[LAZY]) {
    const produced = await (reg as IslandLoader)();
    const setup = (produced as { default?: EnhanceSetup }).default ?? (produced as EnhanceSetup);
    return typeof setup === "function" ? setup : null;
  }
  // Inline setup — used directly, never pre-called.
  return reg as EnhanceSetup;
}

export interface MountIslandsOptions {
  /** IntersectionObserver options for the `visible` strategy. */
  rootMargin?: string;
  threshold?: number | number[];
}

/**
 * Scan a root for `[data-sibu-island]` elements and activate each according to
 * its `data-sibu-load` strategy (default `load`). Returns a cleanup function
 * that cancels pending schedulers and disposes every mounted island.
 *
 * Strategies (`data-sibu-load`):
 *   - `load`        — activate immediately (next microtask).
 *   - `idle`        — `requestIdleCallback` (falls back to a timeout).
 *   - `visible`     — when the element scrolls into view (IntersectionObserver).
 *   - `interaction` — on first pointer/focus/key/touch interaction.
 *   - `media`       — when `data-sibu-media` (a media query) matches.
 */
export function mountIslands(
  root: ParentNode | null = typeof document !== "undefined" ? document : null,
  options: MountIslandsOptions = {},
): () => void {
  if (!root || typeof (root as ParentNode).querySelectorAll !== "function") return () => {};

  const cancels: Array<() => void> = [];
  const disposers: Array<() => void> = [];

  for (const el of Array.from(root.querySelectorAll<HTMLElement>("[data-sibu-island]"))) {
    if (el.getAttribute("data-sibu-enhanced") === "true") continue; // already mounted
    const name = el.getAttribute("data-sibu-island") ?? "";
    if (!registry.has(name)) {
      if (typeof console !== "undefined") {
        console.warn(
          `[SibuJS islands] no island registered for "${name}" — skipping. Call registerIsland("${name}", ...).`,
        );
      }
      continue;
    }

    let activated = false;
    const activate = (): void => {
      if (activated) return;
      activated = true;
      const reg = registry.get(name);
      if (!reg) return;
      resolveSetup(reg)
        .then((setup) => {
          if (!setup) {
            if (typeof console !== "undefined") console.warn(`[SibuJS islands] "${name}" loader produced no setup.`);
            return;
          }
          // Isolate setup failures so one broken island can't take down the
          // rest of the page.
          try {
            disposers.push(enhance(el, setup));
            el.setAttribute("data-sibu-hydrated", "true");
          } catch (err) {
            if (typeof console !== "undefined") console.error(`[SibuJS islands] "${name}" failed to mount:`, err);
          }
        })
        // A failed lazy import() must not surface as an unhandled rejection.
        .catch((err) => {
          if (typeof console !== "undefined") console.error(`[SibuJS islands] "${name}" failed to load:`, err);
        });
    };

    const strategy = (el.getAttribute("data-sibu-load") as IslandStrategy) || "load";
    cancels.push(schedule(strategy, el, activate, options));
  }

  return () => {
    for (const c of cancels.splice(0)) c();
    for (const d of disposers.splice(0)) d();
  };
}

function schedule(
  strategy: IslandStrategy,
  el: HTMLElement,
  activate: () => void,
  options: MountIslandsOptions,
): () => void {
  switch (strategy) {
    case "idle": {
      if (typeof requestIdleCallback !== "undefined") {
        const id = requestIdleCallback(activate);
        return () => cancelIdleCallback(id);
      }
      const t = setTimeout(activate, 1);
      return () => clearTimeout(t);
    }
    case "visible": {
      if (typeof IntersectionObserver === "undefined") {
        queueMicrotask(activate); // no IO (SSR / old engines) → activate eagerly
        return () => {};
      }
      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              observer.disconnect();
              activate();
            }
          }
        },
        { rootMargin: options.rootMargin, threshold: options.threshold },
      );
      observer.observe(el);
      return () => observer.disconnect();
    }
    case "interaction": {
      const events = ["pointerdown", "focusin", "keydown", "touchstart"] as const;
      const onInteract = (): void => {
        cleanup();
        activate();
      };
      const cleanup = (): void => {
        for (const e of events) el.removeEventListener(e, onInteract);
      };
      for (const e of events) el.addEventListener(e, onInteract, { passive: true });
      return cleanup;
    }
    case "media": {
      const query = el.getAttribute("data-sibu-media") || "(min-width: 0px)";
      if (typeof matchMedia === "undefined") {
        queueMicrotask(activate);
        return () => {};
      }
      const mql = matchMedia(query);
      if (mql.matches) {
        queueMicrotask(activate);
        return () => {};
      }
      const onChange = (): void => {
        if (mql.matches) {
          mql.removeEventListener("change", onChange);
          activate();
        }
      };
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    }
    default: {
      queueMicrotask(activate); // "load"
      return () => {};
    }
  }
}
