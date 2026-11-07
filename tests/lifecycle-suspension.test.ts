import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { when } from "../src/core/rendering/directives";
import { dispose, registerDisposer } from "../src/core/rendering/dispose";
import { each } from "../src/core/rendering/each";
import { Fragment } from "../src/core/rendering/fragment";
import { div, span } from "../src/core/rendering/html";
import { lifecycleScope } from "../src/core/signals/lifecycleScope";
import { signal } from "../src/core/signals/signal";
import { createRouter, destroyRouter, lazy, Route, Suspense } from "../src/plugins/router";

// ---------------------------------------------------------------------------
// Suspension, follow-ups:
//
// 1. Discarding a held result never wakes its bindings; adopting one catches
//    them up.
// 2. A list (or KeepAlive) inside a held result is held with it.
// 3. Every route factory call passes the pause gate, cached plans included.
// 4. A route failure is reported when it happens; only its error VIEW waits.
// 5. `lifecycleScope()` gives effects created after an `await` the lifecycle
//    of the render that started the work.
// 6. An enter that a paused ancestor kept from starting replays on resume.
// ---------------------------------------------------------------------------

let host: HTMLElement;

beforeAll(() => {
  const sheet = document.createElement("style");
  sheet.textContent = [
    ".out { animation-name: fade; animation-duration: 0.3s; }",
    ".in { animation-name: rise; animation-duration: 0.2s; }",
  ].join("\n");
  document.head.appendChild(sheet);
});

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

const flush = async (turns = 4) => {
  for (let i = 0; i < turns; i++) await new Promise<void>((r) => setTimeout(r, 0));
};
const end = (el: Element | null | undefined) => el?.dispatchEvent(new Event("animationend"));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A branch whose factory returns the same element: switching back mid-leave reclaims it. */
function reclaimable(build: () => HTMLElement, initiallyVisible = true) {
  const [visible, setVisible] = signal(initiallyVisible);
  let shared: HTMLElement | null = null;
  const anchor = when(
    visible,
    () => (shared ??= build()),
    () => span("off"),
    { transition: { leaveClass: "out" } },
  );
  host.appendChild(anchor);
  return { anchor, setVisible, shared: () => shared as HTMLElement };
}

/** A reactive element whose getter counts its runs. */
function counted(read: () => string) {
  let runs = 0;
  const el = span(() => {
    runs++;
    return read();
  });
  return { el, runs: () => runs };
}

describe("1. held Suspense results", () => {
  function mount() {
    const content = deferred<HTMLElement>();
    const r = reclaimable(() => div([Suspense({ nodes: () => content.promise, fallback: () => span("loading") })]));
    return { ...r, content };
  }

  it("discarding never re-runs a dirty held binding", async () => {
    const { setVisible, content } = mount();
    await flush();
    setVisible(false);
    const [label, setLabel] = signal("a");
    const result = counted(() => label());
    const cleanup = vi.fn();
    registerDisposer(result.el, cleanup);
    content.resolve(result.el);
    await flush();
    expect(result.runs()).toBe(1);
    setLabel("b");
    expect(result.runs()).toBe(1);
    end(host.querySelector(".out"));
    await flush();
    expect(result.runs()).toBe(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
    setLabel("c");
    expect(result.runs()).toBe(1);
  });

  it("adopting catches a dirty held binding up, once", async () => {
    const { setVisible, content, shared } = mount();
    await flush();
    setVisible(false);
    const [label, setLabel] = signal("a");
    const result = counted(() => label());
    content.resolve(result.el);
    await flush();
    setLabel("b");
    setLabel("c");
    setVisible(true);
    await flush();
    expect(result.runs()).toBe(2);
    expect(shared().textContent).toBe("c");
  });
});

describe("1b. a route node built while its branch pauses", () => {
  function mount() {
    const ready = deferred<void>();
    const [label, setLabel] = signal("a");
    let page!: ReturnType<typeof counted>;
    const cleanup = vi.fn();
    window.history.replaceState({}, "", "/");
    createRouter(
      [
        {
          path: "/",
          component: async () => {
            await ready.promise;
            page = counted(() => label());
            registerDisposer(page.el, cleanup);
            return page.el;
          },
        },
      ],
      { mode: "history" },
    );
    const r = reclaimable(() => div([Route()]));
    return { ...r, ready, setLabel, page: () => page, cleanup };
  }

  it("is disposed before its hold is released when the branch ends", async () => {
    const { setVisible, ready, setLabel, page, cleanup } = mount();
    await flush();
    setVisible(false);
    ready.resolve();
    await flush();
    expect(page().runs()).toBe(1);
    setLabel("b");
    end(host.querySelector(".out"));
    await flush();
    expect(page().runs()).toBe(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("is committed, caught up, when the branch is taken back", async () => {
    const { setVisible, ready, setLabel, page, shared } = mount();
    await flush();
    setVisible(false);
    ready.resolve();
    await flush();
    setLabel("b");
    setVisible(true);
    await flush();
    expect(shared().textContent).toBe("b");
    expect(page().runs()).toBe(2);
  });
});

describe("2. structural renderers inside a held result", () => {
  function mount() {
    const content = deferred<HTMLElement>();
    const r = reclaimable(() => div([Suspense({ nodes: () => content.promise, fallback: () => span("loading") })]));
    return { ...r, content };
  }

  it("an each() in a held result does not reconcile until adopted, then catches up", async () => {
    const { setVisible, content, shared } = mount();
    await flush();
    setVisible(false);
    const [items, setItems] = signal([1, 2]);
    let reads = 0;
    const result = div([
      each(
        () => {
          reads++;
          return items();
        },
        (item) => span(String(item.peek())),
        { key: (item) => item },
      ),
    ]);
    content.resolve(result);
    await flush();
    const before = reads;
    setItems([3]);
    expect(reads).toBe(before);
    setVisible(true);
    await flush();
    expect(shared().textContent).toBe("3");
    expect(reads).toBe(before + 1);
  });

  it("a held each() whose result is discarded never reconciles again", async () => {
    const { setVisible, content } = mount();
    await flush();
    setVisible(false);
    const [items, setItems] = signal([1]);
    let reads = 0;
    content.resolve(
      div([
        each(
          () => {
            reads++;
            return items();
          },
          (item) => span(String(item.peek())),
          { key: (item) => item },
        ),
      ]),
    );
    await flush();
    const before = reads;
    setItems([2]);
    end(host.querySelector(".out"));
    await flush();
    setItems([3]);
    expect(reads).toBe(before);
  });
});

describe("3. every route factory call passes the gate", () => {
  function gate() {
    let open!: (active: boolean) => void;
    const until = new Promise<boolean>((r) => {
      open = r;
    });
    let held = true;
    let current = true;
    const cancelled = new DOMException("cancelled", "AbortError");
    return {
      scope: {
        adopt: null,
        gate: { held: () => held, until: () => until, cancellation: () => cancelled, close: () => {} },
        current: () => current,
      } as never,
      resume: () => {
        held = false;
        open(true);
      },
      supersede: () => {
        current = false;
        held = false;
        open(true);
      },
      end: () => open(false),
      cancelled,
    };
  }

  async function setup(kind: "cached" | "uncached" | "direct") {
    const factory = vi.fn(() => span("page"));
    const def =
      kind === "direct"
        ? { path: "/x", component: factory }
        : { path: "/x", component: lazy(() => Promise.resolve({ default: factory })) };
    window.history.replaceState({}, "", "/nowhere");
    const router = createRouter([def], { mode: "history" });
    if (kind === "cached") await router.preloadPlan(def, "/x");
    const plan = await router.loadPlan(def, "/x");
    if (kind === "cached") expect(plan.kind).toBe("factory");
    return { router, def, plan, factory };
  }

  for (const kind of ["cached", "uncached", "direct"] as const) {
    it(`${kind} plan: pending while paused, one element on resume`, async () => {
      const { router, def, plan, factory } = await setup(kind);
      const g = gate();
      let settled: unknown = "pending";
      const result = router.instantiateComponent(plan, def, "/x", g.scope).then(
        (el) => (settled = el),
        (err) => (settled = err),
      );
      await flush();
      expect(settled).toBe("pending");
      expect(factory).not.toHaveBeenCalled();
      g.resume();
      await result;
      expect((settled as Element).textContent).toBe("page");
      expect(factory).toHaveBeenCalledTimes(1);
    });

    it(`${kind} plan: ends or is superseded with an AbortError and no factory call`, async () => {
      const { router, def, plan, factory } = await setup(kind);
      const ended = gate();
      const a = router.instantiateComponent(plan, def, "/x", ended.scope);
      ended.end();
      await expect(a).rejects.toBe(ended.cancelled);
      const superseded = gate();
      const b = router.instantiateComponent(plan, def, "/x", superseded.scope);
      superseded.supersede();
      await expect(b).rejects.toBe(superseded.cancelled);
      expect(factory).not.toHaveBeenCalled();
    });
  }
});

describe("4. route failures are reported when they happen", () => {
  function mount() {
    const pending = deferred<{ default: () => HTMLElement }>();
    window.history.replaceState({}, "", "/");
    createRouter([{ path: "/", component: lazy(() => pending.promise) }], { mode: "history" });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = reclaimable(() => div([Route()]));
    const reports = () => error.mock.calls.filter((c) => String(c[0]).includes("[Route] Component error")).length;
    return { ...r, pending, reports };
  }

  it("reports a failure settling while paused at once, and not again when the branch ends", async () => {
    const { setVisible, pending, reports } = mount();
    await flush();
    setVisible(false);
    pending.reject(new Error("load failed"));
    await flush();
    expect(reports()).toBe(1);
    expect(host.querySelector(".route-error")).toBeNull();
    end(host.querySelector(".out"));
    await flush();
    expect(reports()).toBe(1);
  });

  it("shows the error view on resume without reporting again", async () => {
    const { setVisible, pending, reports, shared } = mount();
    await flush();
    setVisible(false);
    pending.reject(new Error("load failed"));
    await flush();
    setVisible(true);
    await flush();
    expect(shared().querySelector(".route-error")).not.toBeNull();
    expect(reports()).toBe(1);
  });
});

describe("5. lifecycleScope()", () => {
  it("a new effect created while paused waits for the resume, then runs once", async () => {
    const work = deferred<void>();
    const runs: string[] = [];
    const [label] = signal("x");
    const { setVisible } = reclaimable(() => {
      const scope = lifecycleScope();
      void work.promise.then(() => {
        scope.effect(() => {
          runs.push(label());
        });
      });
      return div("panel");
    });
    await flush();
    setVisible(false);
    work.resolve();
    await flush();
    expect(runs).toEqual([]);
    setVisible(true);
    await flush();
    expect(runs).toEqual(["x"]);
  });

  it("an existing effect is suppressed while paused, coalesced into one run on resume, cleanups first", async () => {
    const work = deferred<void>();
    const log: string[] = [];
    const [label, setLabel] = signal("a");
    const { setVisible } = reclaimable(() => {
      const scope = lifecycleScope();
      void work.promise.then(() => {
        scope.effect((onCleanup) => {
          const v = label();
          log.push(`run ${v}`);
          onCleanup(() => log.push(`cleanup ${v}`));
        });
      });
      return div("panel");
    });
    await flush();
    work.resolve();
    await flush();
    expect(log).toEqual(["run a"]);
    setVisible(false);
    setLabel("b");
    setLabel("c");
    expect(log).toEqual(["run a"]);
    setVisible(true);
    await flush();
    expect(log).toEqual(["run a", "cleanup a", "run c"]);
  });

  it("ends with its lifecycle: cleanup once, never runs again", async () => {
    const work = deferred<void>();
    const log: string[] = [];
    const [label, setLabel] = signal("a");
    const { setVisible } = reclaimable(() => {
      const scope = lifecycleScope();
      void work.promise.then(() => {
        scope.effect((onCleanup) => {
          log.push(`run ${label()}`);
          onCleanup(() => log.push("cleanup"));
        });
      });
      return div("panel");
    });
    await flush();
    work.resolve();
    await flush();
    setVisible(false);
    end(host.querySelector(".out"));
    await flush();
    setLabel("z");
    await flush();
    expect(log).toEqual(["run a", "cleanup"]);
  });

  it("a disposer works before the first run, and scopes are independent", async () => {
    const work = deferred<void>();
    const a: string[] = [];
    const b: string[] = [];
    let stopA!: () => void;
    const one = reclaimable(() => {
      const scope = lifecycleScope();
      void work.promise.then(() => {
        stopA = scope.effect(() => void a.push("a"));
      });
      return div("one");
    });
    reclaimable(() => {
      const scope = lifecycleScope();
      void work.promise.then(() => {
        scope.effect(() => void b.push("b"));
      });
      return div("two");
    });
    await flush();
    one.setVisible(false); // only the first lifecycle pauses
    work.resolve();
    await flush();
    expect(b).toEqual(["b"]);
    expect(a).toEqual([]);
    stopA();
    one.setVisible(true);
    await flush();
    expect(a).toEqual([]);
  });

  it("captured outside any render it is always active", () => {
    const scope = lifecycleScope();
    expect(scope.state()).toBe("active");
    const runs = vi.fn();
    const stop = scope.effect(runs);
    expect(runs).toHaveBeenCalledTimes(1);
    stop();
  });
});

describe("6. an enter kept from starting by a paused ancestor replays on resume", () => {
  function mount(transition: Record<string, unknown>) {
    const [items] = signal([1]);
    return reclaimable(
      () =>
        div([
          when(
            () => true,
            () =>
              Fragment([span("heading"), each(items, (item) => span(String(item.peek())), { key: (item) => item })]),
            { transition: { appear: true, ...transition } },
          ),
        ]),
      false,
    );
  }

  it("custom and class enters run once after the reclaim", async () => {
    const enter = vi.fn();
    const { setVisible, shared } = mount({ enter, enterClass: "in" });
    await flush();
    setVisible(true);
    queueMicrotask(() => setVisible(false)); // pause before the nested enter starts
    await flush();
    expect(enter).not.toHaveBeenCalled();
    setVisible(true); // reclaim
    await flush();
    expect(enter).toHaveBeenCalledTimes(1);
    const nodes = enter.mock.calls[0][0] as Node[];
    expect(nodes.filter((n) => n.nodeType === 1).map((n) => n.textContent)).toEqual(["heading", "1"]);
    // Repeated reclaims do not replay it again.
    setVisible(false);
    setVisible(true);
    await flush();
    expect(enter).toHaveBeenCalledTimes(1);
    expect(shared().isConnected).toBe(true);
  });

  it("a class enter is applied on resume", async () => {
    const { setVisible, shared } = mount({ enterClass: "in" });
    await flush();
    setVisible(true);
    queueMicrotask(() => setVisible(false));
    await flush();
    expect(shared().querySelector(".in")).toBeNull();
    setVisible(true);
    await flush();
    expect(shared().querySelectorAll(".in").length).toBeGreaterThan(0);
  });

  it("is dropped when the ancestor ends, or the directive is disposed", async () => {
    const enter = vi.fn();
    const { setVisible, anchor } = mount({ enter });
    await flush();
    setVisible(true);
    queueMicrotask(() => setVisible(false));
    await flush();
    end(host.querySelector(".out"));
    await flush();
    expect(enter).not.toHaveBeenCalled();
    dispose(anchor);
    await flush();
    expect(enter).not.toHaveBeenCalled();
  });
});
