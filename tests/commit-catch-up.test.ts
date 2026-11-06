import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispose, registerDisposer } from "../src/core/rendering/dispose";
import { div, span } from "../src/core/rendering/html";
import { lazy, Suspense } from "../src/core/rendering/lazy";
import { pendingCount } from "../src/core/rendering/range";
import { signal } from "../src/core/signals/signal";
import { createRouter, destroyRouter, Outlet, Route, type RouteDef } from "../src/plugins/router";
import { heldListenerCount, heldRootCount, structuralBinding } from "../src/reactivity/track-core";

// ---------------------------------------------------------------------------
// Releasing the hold on a built result is not passive: its skipped bindings
// catch up synchronously, and they are application code. A commit that found
// its lifecycle active must look again after the catch-up — paused again: the
// result is held and waits; ended, or the renderer gone or superseded: it is
// disposed, once, and never inserted. Nothing is built twice, and nothing is
// left held or waiting afterwards.
// ---------------------------------------------------------------------------

let host: HTMLElement;
let base = 0;
let listeners = 0;
let roots = 0;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  base = pendingCount();
  listeners = heldListenerCount();
  roots = heldRootCount();
});

afterEach(() => {
  dispose(host);
  host.remove();
  destroyRouter();
  vi.restoreAllMocks();
});

const flush = async (turns = 8) => {
  for (let i = 0; i < turns; i++) await new Promise<void>((r) => setTimeout(r, 0));
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

type Owner = ReturnType<typeof structuralBinding>;

/**
 * A component whose node runs `react(value)` in its binding, and which pauses
 * `owner` before returning: the node is built, then held.
 */
function pausingPage(owner: () => Owner, react: (value: string) => void, cls = "loaded") {
  const [label, setLabel] = signal("a");
  const stats = { runs: 0, cleanup: vi.fn(), factory: vi.fn() };
  const component = () => {
    stats.factory();
    const el = span({ class: cls }, () => {
      stats.runs++;
      const value = label();
      react(value);
      return value;
    });
    registerDisposer(el, stats.cleanup);
    owner().freeze?.();
    return el;
  };
  return { component, setLabel, stats };
}

/** No hold, wait or registration is left behind. */
function expectNothingRetained() {
  expect(heldRootCount()).toBe(roots);
  expect(heldListenerCount()).toBeLessThanOrEqual(listeners);
  expect(pendingCount() - base).toBe(0);
}

describe("core lazy()", () => {
  function mount(react: (value: string, owner: Owner, container: HTMLElement) => void) {
    const owner = structuralBinding(() => {});
    let container!: HTMLElement;
    const page = pausingPage(
      () => owner,
      (value) => react(value, owner, container),
    );
    const load = deferred<{ default: () => HTMLElement }>();
    container = owner.run(() => lazy(() => load.promise)()) as HTMLElement;
    host.appendChild(container);
    load.resolve({ default: page.component });
    return { owner, container, ...page };
  }

  it("catch-up pauses the owner again: held, not committed; committed on the next resume", async () => {
    const { owner, container, setLabel, stats } = mount((value, o) => {
      if (value === "pause") o.freeze?.();
    });
    await flush();
    expect(container.querySelector(".loaded")).toBeNull();
    setLabel("pause");
    owner.thaw?.();
    await flush();
    // The catch-up ran (and paused the owner again): still held, not shown.
    expect(stats.runs).toBe(2);
    expect(container.querySelector(".loaded")).toBeNull();
    expect(heldRootCount()).toBe(roots + 1);
    owner.thaw?.();
    await flush();
    expect(container.querySelector(".loaded")?.textContent).toBe("pause");
    expect(stats.factory).toHaveBeenCalledTimes(1);
    expect(stats.cleanup).not.toHaveBeenCalled();
    expectNothingRetained();
  });

  it("catch-up ends the owner: disposed once, never inserted", async () => {
    const { owner, container, setLabel, stats } = mount((value, o) => {
      if (value === "end") o.stop();
    });
    await flush();
    setLabel("end");
    owner.thaw?.();
    await flush();
    expect(container.querySelector(".loaded")).toBeNull();
    expect(stats.cleanup).toHaveBeenCalledTimes(1);
    dispose(container);
    expect(stats.cleanup).toHaveBeenCalledTimes(1);
    expectNothingRetained();
  });

  it("catch-up disposes the renderer: disposed once, never inserted", async () => {
    const { owner, container, setLabel, stats } = mount((value, _o, c) => {
      if (value === "dispose") dispose(c);
    });
    await flush();
    setLabel("dispose");
    owner.thaw?.();
    await flush();
    expect(container.querySelector(".loaded")).toBeNull();
    expect(stats.cleanup).toHaveBeenCalledTimes(1);
    expectNothingRetained();
  });

  it("several pause/resume cycles, then one commit — the factory ran once", async () => {
    const { owner, container, setLabel, stats } = mount((value, o) => {
      if (value.startsWith("p")) o.freeze?.();
    });
    await flush();
    for (const value of ["p1", "p2", "p3"]) {
      setLabel(value);
      owner.thaw?.();
      await flush();
      expect(container.querySelector(".loaded")).toBeNull();
    }
    setLabel("done");
    owner.thaw?.();
    await flush();
    expect(container.querySelector(".loaded")?.textContent).toBe("done");
    expect(stats.factory).toHaveBeenCalledTimes(1);
    expect(stats.runs).toBe(5);
    expect(stats.cleanup).not.toHaveBeenCalled();
    expectNothingRetained();
  });

  it("disposal while held after a re-pause disposes it once, without waking it", async () => {
    const { owner, container, setLabel, stats } = mount((value, o) => {
      if (value === "pause") o.freeze?.();
    });
    await flush();
    setLabel("pause");
    owner.thaw?.();
    await flush();
    const runs = stats.runs;
    setLabel("later");
    dispose(container);
    await flush();
    expect(stats.runs).toBe(runs);
    expect(stats.cleanup).toHaveBeenCalledTimes(1);
    expectNothingRetained();
  });
});

describe("core Suspense()", () => {
  it("catch-up pauses the owner again: the fallback stays until the next resume", async () => {
    const owner = structuralBinding(() => {});
    const page = pausingPage(
      () => owner,
      (value) => {
        if (value === "pause") owner.freeze?.();
      },
    );
    const container = owner.run(() =>
      Suspense({ nodes: page.component, fallback: () => span({ class: "fallback" }, "…") }),
    );
    host.appendChild(container);
    await flush();
    expect(container.querySelector(".fallback")).not.toBeNull();
    page.setLabel("pause");
    owner.thaw?.();
    await flush();
    expect(container.querySelector(".loaded")).toBeNull();
    expect(container.querySelector(".fallback")).not.toBeNull();
    owner.thaw?.();
    await flush();
    expect(container.querySelector(".loaded")?.textContent).toBe("pause");
    expect(container.querySelector(".fallback")).toBeNull();
    expect(page.stats.factory).toHaveBeenCalledTimes(1);
    expectNothingRetained();
  });
});

describe("Route()", () => {
  function mount(react: (value: string, owner: Owner, anchor: Node) => void) {
    const owner = structuralBinding(() => {});
    let anchor!: Node;
    const page = pausingPage(
      () => owner,
      (value) => react(value, owner, anchor),
      "page-a",
    );
    const routes: RouteDef[] = [
      { path: "/a", name: "a", component: page.component },
      { path: "/b", name: "b", component: () => div({ class: "page-b" }, "b") },
    ];
    createRouter(routes, { mode: "memory", url: "/a" });
    anchor = owner.run(() => Route());
    host.appendChild(anchor);
    return { owner, routes, ...page };
  }

  it("catch-up pauses the owner again: held, not committed; committed on the next resume", async () => {
    const { owner, setLabel, stats } = mount((value, o) => {
      if (value === "pause") o.freeze?.();
    });
    await flush();
    expect(host.querySelector(".page-a")).toBeNull();
    setLabel("pause");
    owner.thaw?.();
    await flush();
    expect(stats.runs).toBe(2);
    expect(host.querySelector(".page-a")).toBeNull();
    owner.thaw?.();
    await flush();
    expect(host.querySelector(".page-a")?.textContent).toBe("pause");
    expect(stats.factory).toHaveBeenCalledTimes(1);
    expect(stats.cleanup).not.toHaveBeenCalled();
    expect(heldRootCount()).toBe(roots);
  });

  it("catch-up ends the owner: disposed once, never inserted", async () => {
    const { owner, setLabel, stats } = mount((value, o) => {
      if (value === "end") o.stop();
    });
    await flush();
    setLabel("end");
    owner.thaw?.();
    await flush();
    expect(host.querySelector(".page-a")).toBeNull();
    expect(stats.cleanup).toHaveBeenCalledTimes(1);
    expect(heldRootCount()).toBe(roots);
  });

  it("catch-up disposes the outlet: disposed once, never inserted, readiness released", async () => {
    const { owner, setLabel, stats } = mount((value, _o, anchor) => {
      if (value === "dispose") dispose(anchor);
    });
    await flush();
    setLabel("dispose");
    owner.thaw?.();
    await flush();
    expect(host.querySelector(".page-a")).toBeNull();
    expect(stats.cleanup).toHaveBeenCalledTimes(1);
    expectNothingRetained();
  });

  it("catch-up supersedes the pass: disposed once, the newer pass renders", async () => {
    let routes: RouteDef[] = [];
    const {
      owner,
      setLabel,
      stats,
      routes: defs,
    } = mount((value) => {
      // A new router: the outlet's pass re-runs, in this same flush.
      if (value === "swap") createRouter(routes, { mode: "memory", url: "/b" });
    });
    routes = defs;
    await flush();
    setLabel("swap");
    owner.thaw?.();
    await flush();
    expect(host.querySelector(".page-a")).toBeNull();
    expect(stats.cleanup).toHaveBeenCalledTimes(1);
    expect(host.querySelector(".page-b")).not.toBeNull();
    expect(stats.factory).toHaveBeenCalledTimes(1);
    expect(heldRootCount()).toBe(roots);
  });

  it("several pause/resume cycles, then one commit", async () => {
    const { owner, setLabel, stats } = mount((value, o) => {
      if (value.startsWith("p")) o.freeze?.();
    });
    await flush();
    for (const value of ["p1", "p2", "p3"]) {
      setLabel(value);
      owner.thaw?.();
      await flush();
      expect(host.querySelector(".page-a")).toBeNull();
    }
    setLabel("done");
    owner.thaw?.();
    await flush();
    expect(host.querySelector(".page-a")?.textContent).toBe("done");
    expect(stats.factory).toHaveBeenCalledTimes(1);
    expect(stats.cleanup).not.toHaveBeenCalled();
    expect(heldRootCount()).toBe(roots);
  });
});

describe("Outlet()", () => {
  it("catch-up pauses the layout's owner again: the child is held, not committed", async () => {
    let layoutOwner!: Owner;
    const page = pausingPage(
      () => layoutOwner,
      (value) => {
        if (value === "pause") layoutOwner.freeze?.();
      },
      "page-x",
    );
    createRouter(
      [
        {
          path: "/l",
          name: "l",
          component: () => {
            layoutOwner = structuralBinding(() => {});
            return div(
              { class: "layout" },
              layoutOwner.run(() => Outlet()),
            );
          },
          children: [{ path: "/x", name: "x", component: page.component }],
        },
      ],
      { mode: "memory", url: "/l/x" },
    );
    host.appendChild(Route());
    await flush();
    expect(host.querySelector(".layout")).not.toBeNull();
    expect(host.querySelector(".page-x")).toBeNull();
    page.setLabel("pause");
    layoutOwner.thaw?.();
    await flush();
    expect(page.stats.runs).toBe(2);
    expect(host.querySelector(".page-x")).toBeNull();
    layoutOwner.thaw?.();
    await flush();
    expect(host.querySelector(".page-x")?.textContent).toBe("pause");
    expect(page.stats.factory).toHaveBeenCalledTimes(1);
    expect(heldRootCount()).toBe(roots);
  });
});
