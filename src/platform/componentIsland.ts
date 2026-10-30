// ============================================================================
// COMPONENT ISLANDS FROM A SERVER RENDER
// ============================================================================
//
// Server:  island("cart", Cart, { items }, { load: "visible" })
//
//   <div data-sibu-island="cart" data-sibu-load="visible"
//        data-sibu-props='{"items":[…]}' style="display: contents">
//     …Cart's markup, every element carrying its adoption id…
//   </div>
//
// Browser: registerIsland("cart", islandComponent(Cart)); mountIslands();
//
// `mountIslands` honours the island's load strategy; when it activates, the
// island's props are read back from the markup and `Cart(props)` is built ON
// the server nodes (adopting hydration, scoped to the island). Everything
// outside the islands stays inert server HTML: no bindings, no listeners, and
// no JavaScript beyond the islands' own chunks.

import { type AdoptScope, inScope } from "../core/rendering/adoptScope";
import { dispose } from "../core/rendering/dispose";
import { isServer } from "../core/ssr-context";
import type { EnhanceSetup } from "./enhance";
import { ADOPT_ID_ATTR, hydrateAdopt } from "./hydrateAdopt";
import type { IslandStrategy } from "./islands";

/** The attribute carrying an island's serialized props. */
export const ISLAND_PROPS_ATTR = "data-sibu-props";

const SAFE_NAME = /^[A-Za-z0-9_-]+$/;

/** Options of a server-rendered component island. */
export interface ComponentIslandOptions {
  /** When the browser activates it (`data-sibu-load`). Default `"load"`. */
  load?: IslandStrategy;
  /** Media query for `load: "media"`. */
  media?: string;
}

/**
 * Render `Component(props)` as an island: on the server the markup carries the
 * island marker, its props (JSON) and adoption ids; in the browser, outside an
 * island runtime, the component simply renders.
 *
 * @param name Island name, matched by `registerIsland(name, islandComponent(Component))`.
 * @param component The island's component.
 * @param props JSON-serializable props, sent to the browser in the markup.
 * @param options Load strategy.
 * @returns The island's wrapper element (`display: contents`).
 */
export function componentIsland<P>(
  name: string,
  component: (props: P) => Node,
  props: P,
  options: ComponentIslandOptions = {},
): HTMLElement {
  if (!SAFE_NAME.test(name)) {
    throw new Error(`[SibuJS SSR] island: name must match [A-Za-z0-9_-]+ (got: ${JSON.stringify(name.slice(0, 32))})`);
  }
  const wrapper = document.createElement("div");
  wrapper.setAttribute("data-sibu-island", name);
  if (options.load) wrapper.setAttribute("data-sibu-load", options.load);
  if (options.media) wrapper.setAttribute("data-sibu-media", options.media);
  wrapper.setAttribute("style", "display: contents");
  let json: string;
  try {
    json = JSON.stringify(props ?? null);
  } catch (err) {
    throw new Error(`[SibuJS SSR] island "${name}": props must be JSON-serializable`, { cause: err });
  }
  wrapper.setAttribute(ISLAND_PROPS_ATTR, json);

  // On the server, every element of the island carries its id as an attribute,
  // numbered from the island's own root — independent of the page around it,
  // which does not need adoption markers at all.
  const scope: AdoptScope | null = isServer()
    ? {
        p: "",
        n: 0,
        s: {
          on: true,
          el(tag, ns, id) {
            const el = ns ? document.createElementNS(ns, tag) : document.createElement(tag);
            el.setAttribute(ADOPT_ID_ATTR, id);
            return el;
          },
        },
      }
    : null;
  wrapper.appendChild(inScope(scope, () => component(props)));
  return wrapper;
}

function readProps(root: Element): unknown {
  const raw = root.getAttribute(ISLAND_PROPS_ATTR);
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * The browser side of a server-rendered component island: an island setup
 * (for `registerIsland` / `lazyIsland`) that reads the props from the markup
 * and adopts the island's server nodes with `Component(props)`.
 *
 * @param component The same component the server rendered.
 * @param validate Optional guard for the props read from the markup (they come
 * from the page, so treat them as input).
 * @returns An island setup.
 *
 * @example
 * ```ts
 * registerIsland("cart", islandComponent(Cart));
 * registerIsland("reviews", lazyIsland(() => import("./Reviews").then((m) => islandComponent(m.Reviews))));
 * mountIslands();
 * ```
 */
export function islandComponent<P>(
  component: (props: P) => Node,
  validate?: (props: unknown) => props is P,
): EnhanceSetup {
  return (ctx) => {
    const props = readProps(ctx.root);
    if (validate && !validate(props)) {
      throw new Error(`[SibuJS islands] props of "${ctx.root.getAttribute("data-sibu-island")}" failed validation`);
    }
    let disposed = false;
    void hydrateAdopt(() => component(props as P), ctx.root).then(() => {
      if (disposed) for (const child of Array.from(ctx.root.childNodes)) dispose(child);
    });
    return () => {
      disposed = true;
      for (const child of Array.from(ctx.root.childNodes)) dispose(child);
    };
  };
}
