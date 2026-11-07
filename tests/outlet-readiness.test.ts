import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DirectiveTransition, when } from "../src/core/rendering/directives";
import { dispose } from "../src/core/rendering/dispose";
import { Fragment } from "../src/core/rendering/fragment";
import { div, span } from "../src/core/rendering/html";
import { loadingWithin, pendingCount } from "../src/core/rendering/range";
import { signal } from "../src/core/signals/signal";
import {
  createRouter,
  destroyRouter,
  KeepAliveRoute,
  navigate,
  Outlet,
  Route,
  type RouteDef,
} from "../src/plugins/router";

// ---------------------------------------------------------------------------
// Outlet readiness settles on a committed outcome only.
//
// An outlet's initial content is pending until the CURRENT pass commits its
// page, its error view or a terminal empty outcome. A pass that merely
// returns — superseded, detached and waiting to be attached, cancelled — must
// not settle it. Observable through a custom enter with `waitForContent`:
// it must not run before the current outcome is on the page.
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

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** An async page that renders `.page[data-name]` once `gate` resolves. */
function page(name: string, gate: Promise<unknown>) {
  return async () => {
    await gate;
    return div({ class: "page", "data-name": name }, name);
  };
}

/**
 * `when(on, () => Fragment([heading, outlet()]))` with a custom enter that
 * records what was on the page when it ran.
 */
function mount(outlet: () => Node, extra: Partial<DirectiveTransition> = {}) {
  const [on, setOn] = signal(false);
  const seen: string[][] = [];
  const enter = vi.fn(() => {
    seen.push([...host.querySelectorAll("[data-name]")].map((el) => el.getAttribute("data-name") as string));
  });
  const anchor = when(on, () => Fragment([span({ class: "heading" }, "h"), outlet()]), {
    transition: { enter, waitForContent: 1000, ...extra },
  });
  host.appendChild(anchor);
  return { setOn, enter, seen, anchor };
}

const routes = (defs: RouteDef[], url = "/a") => createRouter(defs, { mode: "memory", url });

describe("deferred initial pages", () => {
  it("Route: the enter waits for the page", async () => {
    const gate = deferred();
    routes([{ path: "/a", component: page("a", gate.promise) }]);
    const { setOn, enter, seen } = mount(() => Route());
    await flush();
    setOn(true);
    await flush();
    expect(enter).not.toHaveBeenCalled();
    gate.resolve();
    await flush();
    expect(enter).toHaveBeenCalledTimes(1);
    expect(seen[0]).toEqual(["a"]);
  });

  it("Outlet: the enter waits for the child page a layout reveals", async () => {
    const gate = deferred();
    routes(
      [
        {
          path: "/l",
          component: () => div({ class: "layout" }, [Outlet()]),
          children: [{ path: "/a", component: page("a", gate.promise) }],
        },
      ],
      "/l/a",
    );
    const { setOn, enter, seen } = mount(() => Route());
    await flush();
    setOn(true);
    await flush();
    expect(host.querySelector(".layout")).not.toBeNull();
    expect(enter).not.toHaveBeenCalled();
    gate.resolve();
    await flush();
    expect(enter).toHaveBeenCalledTimes(1);
    expect(seen[0]).toEqual(["a"]);
  });

  it("KeepAliveRoute: the enter waits for the page", async () => {
    const gate = deferred();
    routes([{ path: "/a", component: page("a", gate.promise) }]);
    const { setOn, enter, seen } = mount(() => KeepAliveRoute());
    await flush();
    setOn(true);
    await flush();
    expect(enter).not.toHaveBeenCalled();
    gate.resolve();
    await flush();
    expect(enter).toHaveBeenCalledTimes(1);
    expect(seen[0]).toEqual(["a"]);
  });
});

describe("passes that return without committing do not settle readiness", () => {
  it("KeepAliveRoute built detached and inserted right after: its attach retry is not an outcome", async () => {
    const gate = deferred();
    routes([{ path: "/a", component: page("a", gate.promise) }]);
    // The outlet runs its first pass inside `KeepAliveRoute()`, before the
    // fragment adopts its anchor: that pass requests an attach retry and
    // returns.
    const { setOn, enter } = mount(() => {
      const outlet = KeepAliveRoute();
      expect(outlet.parentNode).toBeNull();
      return outlet;
    });
    await flush();
    setOn(true);
    await flush();
    expect(enter).not.toHaveBeenCalled();
    gate.resolve();
    await flush();
    expect(enter).toHaveBeenCalledTimes(1);
    expect(host.querySelector("[data-name=a]")).not.toBeNull();
  });

  it("an older pass completing while a newer navigation is pending does not settle it", async () => {
    const a = deferred();
    const b = deferred();
    routes([
      { path: "/a", component: page("a", a.promise) },
      { path: "/b", component: page("b", b.promise) },
    ]);
    const { setOn, enter, seen } = mount(() => Route());
    await flush();
    setOn(true);
    await flush();
    await navigate("/b");
    await flush();
    // The /a pass completes, superseded: nothing is committed for it.
    a.resolve();
    await flush();
    expect(host.querySelector("[data-name=a]")).toBeNull();
    expect(enter).not.toHaveBeenCalled();
    b.resolve();
    await flush();
    expect(enter).toHaveBeenCalledTimes(1);
    expect(seen[0]).toEqual(["b"]);
  });

  it("the same for KeepAliveRoute and Outlet", async () => {
    for (const kind of ["keep-alive", "outlet"] as const) {
      destroyRouter();
      const a = deferred();
      const b = deferred();
      if (kind === "keep-alive")
        routes([
          { path: "/a", component: page("a", a.promise) },
          { path: "/b", component: page("b", b.promise) },
        ]);
      else
        routes(
          [
            {
              path: "/l",
              component: () => div({ class: "layout" }, [Outlet()]),
              children: [
                { path: "/a", component: page("a", a.promise) },
                { path: "/b", component: page("b", b.promise) },
              ],
            },
          ],
          "/l/a",
        );
      const { setOn, enter, seen, anchor } = mount(() => (kind === "keep-alive" ? KeepAliveRoute() : Route()));
      await flush();
      setOn(true);
      await flush();
      await navigate(kind === "keep-alive" ? "/b" : "/l/b");
      await flush();
      a.resolve();
      await flush();
      expect(enter, kind).not.toHaveBeenCalled();
      b.resolve();
      await flush();
      expect(enter, kind).toHaveBeenCalledTimes(1);
      expect(seen[0], kind).toEqual(["b"]);
      dispose(anchor);
      anchor.remove();
    }
  });

  it("a first pass superseded by the attach fallback does not settle it", async () => {
    const gate = deferred();
    routes([{ path: "/a", component: page("a", gate.promise) }]);
    // Built detached: the tracked pass starts with no parent, and the queued
    // first pass that runs once it is attached supersedes it.
    const { setOn, enter, seen } = mount(() => {
      const outlet = Route();
      expect(outlet.parentNode).toBeNull();
      return outlet;
    });
    await flush();
    setOn(true);
    await flush();
    expect(enter).not.toHaveBeenCalled();
    gate.resolve();
    await flush();
    expect(enter).toHaveBeenCalledTimes(1);
    expect(seen[0]).toEqual(["a"]);
  });

  it("an outlet detached until later stays pending, and an enter it later joins waits for it", async () => {
    const gate = deferred();
    routes([{ path: "/a", component: page("a", gate.promise) }]);
    const outlet = Route();
    await flush();
    // Its pass returned (waiting to be attached): still pending.
    expect(loadingWithin([outlet], null)).toHaveLength(1);
    const { setOn, enter, seen } = mount(() => outlet);
    await flush();
    setOn(true);
    await flush();
    expect(enter).not.toHaveBeenCalled();
    gate.resolve();
    await flush();
    expect(enter).toHaveBeenCalledTimes(1);
    expect(seen[0]).toEqual(["a"]);
    expect(loadingWithin([outlet], null)).toHaveLength(0);
  });
});

describe("disposal and termination while pending", () => {
  it("switching the branch away drops the wait and the registration; the page resolving later changes nothing", async () => {
    const gate = deferred();
    routes([{ path: "/a", component: page("a", gate.promise) }]);
    const before = pendingCount();
    const { setOn, enter } = mount(() => Route());
    await flush();
    setOn(true);
    await flush();
    setOn(false);
    await flush();
    expect(pendingCount()).toBe(before);
    gate.resolve();
    await flush();
    expect(enter).not.toHaveBeenCalled();
    expect(host.querySelector("[data-name]")).toBeNull();
  });

  it("disposing the outlet releases its registration once; the enter no longer waits for it", async () => {
    const gate = deferred();
    routes([{ path: "/a", component: page("a", gate.promise) }]);
    let outlet!: Node;
    const { setOn, enter } = mount(() => {
      outlet = Route();
      return outlet;
    });
    await flush();
    setOn(true);
    await flush();
    expect(enter).not.toHaveBeenCalled();
    dispose(outlet);
    dispose(outlet);
    await flush();
    expect(enter).toHaveBeenCalledTimes(1);
    expect(loadingWithin([outlet], null)).toHaveLength(0);
  });

  it("once settled, a later navigation never reopens it", async () => {
    const a = deferred();
    const b = deferred();
    routes([
      { path: "/a", component: page("a", a.promise) },
      { path: "/b", component: page("b", b.promise) },
    ]);
    let outlet!: Node;
    const { setOn } = mount(() => {
      outlet = Route();
      return outlet;
    });
    await flush();
    setOn(true);
    a.resolve();
    await flush();
    await navigate("/b");
    await flush();
    expect(loadingWithin([outlet], null)).toHaveLength(0);
  });
});

describe("error and empty outcomes settle it", () => {
  it("Route: a failing page settles with its error view", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const gate = deferred();
    routes([
      {
        path: "/a",
        component: async () => {
          await gate.promise;
          throw new Error("boom");
        },
      },
    ]);
    const { setOn, enter } = mount(() => Route());
    await flush();
    setOn(true);
    await flush();
    expect(enter).not.toHaveBeenCalled();
    gate.resolve();
    await flush();
    expect(enter).toHaveBeenCalledTimes(1);
    const nodes = (enter.mock.calls[0] as unknown as [Node[]])[0];
    expect(host.querySelector(".route-error")).not.toBeNull();
    expect(nodes.some((n) => (n as Element).classList?.contains("route-error"))).toBe(true);
  });

  it("KeepAliveRoute and Outlet: a failure (no error view) settles it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const kind of ["keep-alive", "outlet"] as const) {
      destroyRouter();
      const gate = deferred();
      const failing = async () => {
        await gate.promise;
        throw new Error("boom");
      };
      if (kind === "keep-alive") routes([{ path: "/a", component: failing }]);
      else
        routes(
          [{ path: "/l", component: () => div([Outlet()]), children: [{ path: "/a", component: failing }] }],
          "/l/a",
        );
      const { setOn, enter, anchor } = mount(() => (kind === "keep-alive" ? KeepAliveRoute() : Route()));
      await flush();
      setOn(true);
      await flush();
      expect(enter, kind).not.toHaveBeenCalled();
      gate.resolve();
      await flush();
      expect(enter, kind).toHaveBeenCalledTimes(1);
      dispose(anchor);
      anchor.remove();
    }
  });

  it("no matching route is a terminal empty outcome: the enter does not wait for the deadline", async () => {
    routes([{ path: "/a", component: () => div("a") }], "/nowhere");
    const { setOn, enter } = mount(() => Route(), { waitForContent: 5000 });
    await flush();
    setOn(true);
    await flush();
    expect(enter).toHaveBeenCalledTimes(1);
  });

  it("an Outlet with no matched child is a terminal empty outcome", async () => {
    routes([{ path: "/l", component: () => div({ class: "layout" }, [Outlet()]) }], "/l");
    const { setOn, enter } = mount(() => Route(), { waitForContent: 5000 });
    await flush();
    setOn(true);
    await flush();
    expect(enter).toHaveBeenCalledTimes(1);
  });
});
