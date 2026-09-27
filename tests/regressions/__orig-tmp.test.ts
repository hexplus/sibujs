/**
 * Same-route param changes remount the route component.
 *
 * Invariants under test:
 *  - Navigating between two locations of the same route definition whose own
 *    path params differ (`/records/1` → `/records/2`) disposes the old instance
 *    and mounts a fresh one, so a page that reads `route().params.id` once at
 *    setup always shows the right record.
 *  - The old instance is lifecycle-disposed: `onUnmount` runs and its reactive
 *    bindings stop reacting.
 *  - Params are attributed per matched record: a child-only param change
 *    remounts the child inside `Outlet()`, never the parent layout.
 *  - Query- and hash-only changes on the same route never remount.
 *  - A route `key` overrides the default identity; a constant key restores the
 *    previous reuse behaviour.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerDisposer } from "../../src/core/rendering/dispose";
import { onUnmount } from "../../src/core/rendering/lifecycle";
import { effect } from "../../src/core/signals/effect";
import {
  createRouter,
  destroyRouter,
  navigate,
  Outlet,
  Route,
  type RouteDef,
  route,
  routerState,
} from "../../src/plugins/__routerOrigTmp";

const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 10));
};

function text(tag: string, value: string): HTMLElement {
  const el = document.createElement(tag);
  el.textContent = value;
  return el;
}

/** A page that reads its id ONCE at setup — the pattern the fix makes safe. */
function recordPage(log: { created: string[]; unmounted: string[] }) {
  return () => {
    const id = route().params.id;
    log.created.push(id);
    const el = text("div", `Record ${id}`);
    el.dataset.page = "record";
    onUnmount(() => log.unmounted.push(id), el);
    return el;
  };
}

describe.skip("TEMP FILE, DELETE ME: original-router comparison run", () => {
  let host: HTMLDivElement;

  const start = async (routes: RouteDef[], initial: string) => {
    window.history.replaceState({}, "", initial);
    createRouter(routes, { mode: "history" });
    host.appendChild(Route());
    await settle();
  };

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  afterEach(() => {
    try {
      destroyRouter();
    } catch {}
    host.remove();
    window.history.replaceState({}, "", "/");
  });

  it("regression: a page reading route().params.id at setup shows the new id after /records/1 -> /records/2 and back", async () => {
    const log = { created: [] as string[], unmounted: [] as string[] };
    await start([{ path: "/records/:id", component: recordPage(log) }], "/records/1");
    expect(host.textContent).toBe("Record 1");

    await navigate("/records/2");
    await settle();
    expect(host.textContent).toBe("Record 2");

    await navigate("/records/1");
    await settle();
    expect(host.textContent).toBe("Record 1");
    expect(log.created).toEqual(["1", "2", "1"]);
    expect(host.querySelectorAll("[data-page]").length).toBe(1);
  });

  it("regression: the old instance's onUnmount/dispose runs and its bindings stop reacting", async () => {
    const log = { created: [] as string[], unmounted: [] as string[] };
    const runs = new Map<string, number>();
    const disposed: string[] = [];

    const Page = () => {
      const id = route().params.id;
      const state = routerState();
      const el = text("div", `Record ${id}`);
      const stop = effect(() => {
        state.params();
        runs.set(id, (runs.get(id) ?? 0) + 1);
      });
      registerDisposer(el, () => {
        disposed.push(id);
        stop();
      });
      onUnmount(() => log.unmounted.push(id), el);
      return el;
    };

    await start([{ path: "/records/:id", component: Page }], "/records/1");
    await navigate("/records/2");
    await settle();

    expect(disposed).toEqual(["1"]);
    expect(log.unmounted).toEqual(["1"]);

    // The disposed instance's effect must no longer react to navigation.
    const firstRuns = runs.get("1");
    await navigate("/records/3");
    await settle();
    expect(runs.get("1")).toBe(firstRuns);
    expect(disposed).toEqual(["1", "2"]);
    expect(host.textContent).toBe("Record 3");
  });

  it("regression: a nested layout keeps its instance while the child Outlet remounts on a child param change", async () => {
    let layoutCreated = 0;
    let layoutUnmounted = 0;
    const children: string[] = [];
    const childUnmounted: string[] = [];

    const Layout = () => {
      layoutCreated++;
      const el = document.createElement("section");
      el.appendChild(text("h1", "Records"));
      el.appendChild(Outlet());
      onUnmount(() => layoutUnmounted++, el);
      return el;
    };
    const Child = () => {
      const id = route().params.id;
      children.push(id);
      const el = text("p", `Child ${id}`);
      onUnmount(() => childUnmounted.push(id), el);
      return el;
    };

    await start(
      [{ path: "/records", component: Layout, children: [{ path: "/:id", component: Child }] }],
      "/records/1",
    );
    expect(host.textContent).toBe("RecordsChild 1");

    await navigate("/records/2");
    await settle();

    expect(host.textContent).toBe("RecordsChild 2");
    expect(children).toEqual(["1", "2"]);
    expect(childUnmounted).toEqual(["1"]);
    expect(layoutCreated).toBe(1);
    expect(layoutUnmounted).toBe(0);
  });

  it("regression: a query- or hash-only change on the same route does not remount", async () => {
    let created = 0;
    const Page = () => {
      created++;
      return text("div", `Record ${route().params.id}`);
    };

    await start([{ path: "/records/:id", component: Page }], "/records/1?tab=a");
    const first = host.firstChild;
    expect(created).toBe(1);

    await navigate("/records/1?tab=b");
    await settle();
    await navigate("/records/1?tab=b#notes");
    await settle();

    expect(created).toBe(1);
    expect(host.firstChild).toBe(first);
  });

  it("regression: a constant key keeps the instance across param changes", async () => {
    let created = 0;
    let unmounted = 0;
    const Page = () => {
      created++;
      const el = document.createElement("div");
      // A long-lived instance must read params reactively.
      const stop = effect(() => {
        el.textContent = `Record ${routerState().params().id}`;
      });
      registerDisposer(el, stop);
      onUnmount(() => unmounted++, el);
      return el;
    };

    await start([{ path: "/records/:id", component: Page, key: () => "record" }], "/records/1");
    const first = host.firstChild;

    await navigate("/records/2");
    await settle();

    expect(created).toBe(1);
    expect(unmounted).toBe(0);
    expect(host.firstChild).toBe(first);
    expect(host.textContent).toBe("Record 2");
  });

  it("a parent param change remounts the layout (and with it the child)", async () => {
    const layouts: string[] = [];
    const Layout = () => {
      const org = route().params.org;
      layouts.push(org);
      const el = document.createElement("section");
      el.appendChild(text("h1", `Org ${org}`));
      el.appendChild(Outlet());
      return el;
    };
    const Child = () => text("p", `Project ${route().params.project}`);

    await start(
      [{ path: "/orgs/:org", component: Layout, children: [{ path: "/projects/:project", component: Child }] }],
      "/orgs/a/projects/1",
    );
    expect(host.textContent).toBe("Org aProject 1");

    await navigate("/orgs/b/projects/1");
    await settle();

    expect(layouts).toEqual(["a", "b"]);
    expect(host.textContent).toBe("Org bProject 1");
  });

  it("a custom key can also remount on a query change", async () => {
    const tabs: string[] = [];
    const Page = () => {
      const tab = route().query.tab ?? "";
      tabs.push(tab);
      return text("div", `Tab ${tab}`);
    };

    await start(
      [{ path: "/records/:id", component: Page, key: (r) => `${r.params.id}|${r.query.tab ?? ""}` }],
      "/records/1?tab=a",
    );
    await navigate("/records/1?tab=b");
    await settle();

    expect(tabs).toEqual(["a", "b"]);
    expect(host.textContent).toBe("Tab b");
  });

  it("a static route is not remounted by navigations that stay on it", async () => {
    let created = 0;
    const Page = () => {
      created++;
      return text("div", "About");
    };

    await start([{ path: "/about", component: Page }], "/about");
    await navigate("/about?x=1");
    await settle();

    expect(created).toBe(1);
  });

  it("a wildcard route remounts when the matched tail changes", async () => {
    const seen: string[] = [];
    const Page = () => {
      const tail = route().params.pathMatch;
      seen.push(tail);
      return text("div", tail);
    };

    await start([{ path: "/docs/*", component: Page }], "/docs/intro");
    await navigate("/docs/setup");
    await settle();

    expect(seen).toEqual(["/intro", "/setup"]);
    expect(host.textContent).toBe("/setup");
  });
});
