import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispose } from "../src/core/rendering/dispose";
import { div } from "../src/core/rendering/html";
import { type LifecycleScope, lifecycleScope } from "../src/core/signals/lifecycleScope";
import {
  createRouter,
  destroyRouter,
  KeepAliveRoute,
  navigate,
  Outlet,
  type RouteContext,
  type RouteDef,
  route,
} from "../src/plugins/router";

// ---------------------------------------------------------------------------
// `scope.onPause()` / `scope.onResume()` run in the context the scope
// captured: `route()` is the pausing page's own route (not the page navigated
// to), and the captured lifecycle owns what the hook creates. Nothing stays
// installed after the call.
// ---------------------------------------------------------------------------

let host: HTMLElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  dispose(host);
  host.remove();
  destroyRouter();
  vi.restoreAllMocks();
});

const flush = async (turns = 6) => {
  for (let i = 0; i < turns; i++) await new Promise<void>((r) => setTimeout(r, 0));
};

let log: string[] = [];
// Hooks of different scopes changing state in the same task are delivered in
// the same microtask, in no promised order.
const unordered = (entries: string[]) => [...entries].sort();
beforeEach(() => {
  log = [];
});

/** A page whose hooks log `name:state:route().path`. */
function page(name: string) {
  return () => {
    const scope = lifecycleScope();
    scope.onPause(() => log.push(`${name}:pause:${route().path}`));
    scope.onResume(() => log.push(`${name}:resume:${route().path}`));
    return div({ class: `page-${name}` }, name);
  };
}

function setup(routes: RouteDef[], url = "/a", max?: number) {
  createRouter(routes, { mode: "memory", url });
  host.appendChild(KeepAliveRoute({ suspendInactive: true, max }));
}

const flat = (...names: string[]): RouteDef[] =>
  names.map((name) => ({ path: `/${name}`, name, component: page(name) }));

describe("hooks read their own instance's route", () => {
  it("pause and resume see the pausing page's route", async () => {
    setup(flat("a", "b"));
    await flush();
    await navigate("/b");
    await flush();
    expect(log).toEqual(["a:pause:/a"]);
    await navigate("/a");
    await flush();
    expect(unordered(log)).toEqual(unordered(["a:pause:/a", "b:pause:/b", "a:resume:/a"]));
  });

  it("several cached instances each see their own route", async () => {
    setup(flat("a", "b", "c"));
    await flush();
    await navigate("/b");
    await flush();
    await navigate("/c");
    await flush();
    await navigate("/a");
    await flush();
    expect(unordered(log)).toEqual(unordered(["a:pause:/a", "b:pause:/b", "c:pause:/c", "a:resume:/a"]));
  });

  it("a hook in a nested route sees the child instance's route", async () => {
    const routes: RouteDef[] = [
      {
        path: "/l",
        name: "l",
        component: () => div({ class: "layout" }, Outlet()),
        children: [{ path: "/x", name: "x", component: page("x") }],
      },
      { path: "/b", name: "b", component: page("b") },
    ];
    setup(routes, "/l/x");
    await flush();
    expect(host.querySelector(".page-x")).not.toBeNull();
    await navigate("/b");
    await flush();
    expect(log).toEqual(["x:pause:/l/x"]);
    await navigate("/l/x");
    await flush();
    expect(unordered(log)).toEqual(unordered(["x:pause:/l/x", "b:pause:/b", "x:resume:/l/x"]));
  });

  it("a hook registered after an await, through the scope captured while rendering", async () => {
    setup([
      {
        path: "/a",
        name: "a",
        component: () => {
          const scope = lifecycleScope();
          void Promise.resolve().then(() => {
            scope.onPause(() => log.push(`late:pause:${route().path}`));
          });
          return div({ class: "page-a" }, "a");
        },
      },
      { path: "/b", name: "b", component: () => div("b") },
    ]);
    await flush();
    await navigate("/b");
    await flush();
    expect(log).toEqual(["late:pause:/a"]);
  });

  it("onResume runs after the shown instance's route was updated", async () => {
    let seen: RouteContext | null = null;
    setup([
      {
        path: "/a",
        name: "a",
        component: () => {
          const scope = lifecycleScope();
          scope.onResume(() => {
            seen = route();
          });
          return div("a");
        },
      },
      { path: "/b", name: "b", component: () => div("b") },
    ]);
    await flush();
    await navigate("/b");
    await flush();
    await navigate("/a");
    await flush();
    // The route the instance is shown for: the router's current one.
    expect(seen).toBe(route());
  });
});

describe("hooks keep their delivery contract", () => {
  it("a failing hook is reported, and the other hooks still run", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    setup([
      {
        path: "/a",
        name: "a",
        component: () => {
          const scope = lifecycleScope();
          scope.onPause(() => {
            throw new Error("hook failed");
          });
          scope.onPause(() => log.push(`a:pause:${route().path}`));
          return div("a");
        },
      },
      { path: "/b", name: "b", component: page("b") },
    ]);
    await flush();
    await navigate("/b");
    await flush();
    expect(log).toEqual(["a:pause:/a"]);
    expect(error).toHaveBeenCalled();
  });

  it("what a hook creates synchronously belongs to the scope's lifecycle", async () => {
    let inner: LifecycleScope | null = null;
    let outer!: LifecycleScope;
    setup([
      {
        path: "/a",
        name: "a",
        component: () => {
          outer = lifecycleScope();
          outer.onPause(() => {
            inner = lifecycleScope();
          });
          return div("a");
        },
      },
      { path: "/b", name: "b", component: () => div("b") },
    ]);
    await flush();
    await navigate("/b");
    await flush();
    expect(inner).not.toBeNull();
    expect((inner as unknown as LifecycleScope).state()).toBe("paused");
    await navigate("/a");
    await flush();
    expect((inner as unknown as LifecycleScope).state()).toBe("active");
    // Nothing stayed installed: a scope captured now, outside any render,
    // belongs to no lifecycle.
    expect(lifecycleScope().state()).toBe("active");
    expect(outer.state()).toBe("active");
  });

  it("a page evicted in the task it was paused delivers nothing", async () => {
    setup(flat("a", "b"), "/a", 1);
    await flush();
    await navigate("/b");
    await flush();
    expect(log).toEqual([]);
  });
});
