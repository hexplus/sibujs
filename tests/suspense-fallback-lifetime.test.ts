import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AdoptScope, inScope } from "../src/core/rendering/adoptScope";
import { when } from "../src/core/rendering/directives";
import { dispose, registerDisposer } from "../src/core/rendering/dispose";
import { div, span } from "../src/core/rendering/html";
import { beginHydration } from "../src/core/rendering/hydrationHooks";
import { lazy, Suspense } from "../src/core/rendering/lazy";
import { pendingContent } from "../src/core/rendering/pendingContent";
import { pendingCount } from "../src/core/rendering/range";
import { type LifecycleScope, lifecycleScope } from "../src/core/signals/lifecycleScope";
import { signal } from "../src/core/signals/signal";
import { createRouter, destroyRouter, Route, route } from "../src/plugins/router";
import { heldListenerCount, structuralBinding } from "../src/reactivity/track-core";

// ---------------------------------------------------------------------------
// Core `Suspense`'s fallback runs under its own lifecycle, nested in the
// boundary's and separate from the content's: what it captures ends when the
// content replaces it, when the boundary is disposed, when hydration discards
// it, or at once if it throws (its registrations rolled back) — once.
// ---------------------------------------------------------------------------

let host: HTMLElement;
let base = 0;
let listeners = 0;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  base = pendingCount();
  listeners = heldListenerCount();
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** A fallback capturing a scope with a scoped effect, watch and owned resource on `tick`. */
function instrumentedFallback() {
  const [tick, setTick] = signal(0);
  const record = {
    scope: null as LifecycleScope | null,
    effectRuns: 0,
    watchRuns: 0,
    released: vi.fn(),
    routePath: "",
  };
  const fallback = () => {
    const scope = lifecycleScope();
    record.scope = scope;
    scope.effect(() => {
      tick();
      record.effectRuns++;
    });
    scope.watch(tick, () => {
      record.watchRuns++;
    });
    scope.own(() => record.released);
    pendingContent(scope);
    return span({ class: "fallback" }, "…");
  };
  return { fallback, setTick, record };
}

/** Content that stays loading until `load.resolve`. */
function slowContent() {
  const load = deferred<{ default: () => HTMLElement }>();
  let scope: LifecycleScope | null = null;
  const nodes = () => lazy(() => load.promise)() as HTMLElement;
  const resolve = () =>
    load.resolve({
      default: () => {
        scope = lifecycleScope();
        return span({ class: "content" }, "content");
      },
    });
  return { nodes, resolve, scope: () => scope };
}

/** The fallback's work is over: scope ended, nothing runs any more, released once. */
async function expectEnded(f: ReturnType<typeof instrumentedFallback>) {
  expect(f.record.scope?.state()).toBe("ended");
  const effects = f.record.effectRuns;
  const watches = f.record.watchRuns;
  f.setTick((n) => n + 1);
  await flush();
  expect(f.record.effectRuns).toBe(effects);
  expect(f.record.watchRuns).toBe(watches);
  expect(f.record.released).toHaveBeenCalledTimes(1);
}

describe("standalone", () => {
  it("the content replacing the fallback ends the fallback's lifecycle, not the content's", async () => {
    const f = instrumentedFallback();
    const content = slowContent();
    const container = Suspense({ nodes: content.nodes, fallback: f.fallback });
    host.appendChild(container);
    await flush();
    f.setTick(1);
    await flush();
    expect(f.record.effectRuns).toBe(2);
    expect(f.record.scope?.state()).toBe("active");
    content.resolve();
    await flush();
    expect(container.querySelector(".content")).not.toBeNull();
    expect(container.querySelector(".fallback")).toBeNull();
    await expectEnded(f);
    expect(content.scope()?.state()).toBe("active");
    dispose(container);
    expect(content.scope()?.state()).toBe("ended");
    expect(f.record.released).toHaveBeenCalledTimes(1);
    expect(pendingCount() - base).toBe(0);
    expect(heldListenerCount()).toBeLessThanOrEqual(listeners);
  });

  it("disposing the boundary before the deferred content render ends the fallback; nodes() never runs", async () => {
    const f = instrumentedFallback();
    const nodes = vi.fn(() => div("content"));
    const container = Suspense({ nodes, fallback: f.fallback });
    host.appendChild(container);
    dispose(container);
    await flush();
    expect(nodes).not.toHaveBeenCalled();
    await expectEnded(f);
    expect(pendingCount() - base).toBe(0);
  });

  it("a throwing fallback propagates; its scope ends and its registrations are rolled back", async () => {
    const f = instrumentedFallback();
    for (let i = 0; i < 3; i++) {
      expect(() =>
        Suspense({
          nodes: () => div("content"),
          fallback: () => {
            const el = f.fallback();
            pendingContent(el);
            throw new Error("bad fallback");
          },
        }),
      ).toThrow("bad fallback");
      expect(f.record.scope?.state()).toBe("ended");
    }
    const effects = f.record.effectRuns;
    f.setTick(1);
    await flush();
    expect(f.record.effectRuns).toBe(effects);
    expect(f.record.released).toHaveBeenCalledTimes(3);
    expect(pendingCount() - base).toBe(0);
    expect(heldListenerCount()).toBeLessThanOrEqual(listeners);
  });

  it("the fallback pauses and resumes with the boundary's lifecycle", async () => {
    const f = instrumentedFallback();
    const owner = structuralBinding(() => {});
    host.appendChild(owner.run(() => Suspense({ nodes: slowContent().nodes, fallback: f.fallback })));
    await flush();
    owner.freeze?.();
    expect(f.record.scope?.state()).toBe("paused");
    owner.thaw?.();
    expect(f.record.scope?.state()).toBe("active");
    owner.stop();
    expect(f.record.scope?.state()).toBe("ended");
  });
});

describe("hydration", () => {
  it("a fallback built and discarded for adopted server content ends at once", async () => {
    const server = document.createElement("div");
    server.className = "sibu-suspense";
    server.appendChild(document.createElement("p"));
    host.appendChild(server);
    const scope: AdoptScope = { p: "", n: 0, s: { on: true, el: (tag) => (tag === "div" ? server : null) } };
    const session = beginHydration();
    const f = instrumentedFallback();
    let container!: HTMLElement;
    try {
      container = inScope(scope, () => Suspense({ nodes: slowContent().nodes, fallback: f.fallback }));
    } finally {
      session.end();
    }
    expect(container).toBe(server);
    expect(container.querySelector(".fallback")).toBeNull();
    await expectEnded(f);
  });
});

describe("inside a directive branch", () => {
  it("switching the branch away before the content arrives ends the fallback once", async () => {
    const f = instrumentedFallback();
    const [on, setOn] = signal(true);
    host.appendChild(when(on, () => Suspense({ nodes: slowContent().nodes, fallback: f.fallback })));
    await flush();
    expect(f.record.scope?.state()).toBe("active");
    setOn(false);
    await flush();
    await expectEnded(f);
    expect(pendingCount() - base).toBe(0);
  });

  it("the content replacing the fallback ends it while the branch lives on", async () => {
    const f = instrumentedFallback();
    const content = slowContent();
    const [on] = signal(true);
    host.appendChild(when(on, () => Suspense({ nodes: content.nodes, fallback: f.fallback })));
    await flush();
    content.resolve();
    await flush();
    expect(host.querySelector(".content")).not.toBeNull();
    await expectEnded(f);
  });
});

describe("inside a route", () => {
  it("the fallback reads its instance's route, and ends when the content replaces it", async () => {
    const f = instrumentedFallback();
    const content = slowContent();
    createRouter(
      [
        {
          path: "/a",
          name: "a",
          component: () =>
            Suspense({
              nodes: content.nodes,
              fallback: () => {
                f.record.routePath = route().path;
                return f.fallback();
              },
            }),
        },
      ],
      { mode: "memory", url: "/a" },
    );
    host.appendChild(Route());
    await flush();
    expect(f.record.routePath).toBe("/a");
    expect(f.record.scope?.state()).toBe("active");
    content.resolve();
    await flush();
    expect(host.querySelector(".content")).not.toBeNull();
    await expectEnded(f);
  });

  it("disposing the route instance ends the fallback once", async () => {
    const f = instrumentedFallback();
    createRouter(
      [{ path: "/a", name: "a", component: () => Suspense({ nodes: slowContent().nodes, fallback: f.fallback }) }],
      {
        mode: "memory",
        url: "/a",
      },
    );
    const anchor = Route();
    host.appendChild(anchor);
    await flush();
    expect(f.record.scope?.state()).toBe("active");
    dispose(anchor);
    await expectEnded(f);
  });
});

describe("a fallback disposer", () => {
  it("runs once whatever ends the fallback", async () => {
    const cleanup = vi.fn();
    const content = slowContent();
    const container = Suspense({
      nodes: content.nodes,
      fallback: () => {
        const el = span({ class: "fallback" }, "…");
        registerDisposer(el, cleanup);
        return el;
      },
    });
    host.appendChild(container);
    await flush();
    content.resolve();
    await flush();
    dispose(container);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
