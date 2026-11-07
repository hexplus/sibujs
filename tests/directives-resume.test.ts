import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { when } from "../src/core/rendering/directives";
import { dispose, registerDisposer } from "../src/core/rendering/dispose";
import { div, span } from "../src/core/rendering/html";
import { signal } from "../src/core/signals/signal";
import { createRouter, destroyRouter, lazy, navigate, Route, Suspense } from "../src/plugins/router";
import { captureFrozen, structuralBinding } from "../src/reactivity/track";

// ---------------------------------------------------------------------------
// A frozen branch is PAUSED, not ended: it can be taken back before its leave
// finishes. Work that settled while it was paused resumes when it is taken
// back, exactly once, and is released (never rendered) if it ends instead.
//
//   active -> paused -> active      (reclaimed: resume)
//   active -> paused -> ended       (released after its leave)
//   active -> ended                 (released at once)
//
// A `Suspense` keeps its single-shot generation: `nodes()` runs once, its
// result is held (bindings included) while paused and adopted on resume. A
// lazy route keeps its loaded module cached and instantiates it on resume,
// unless a navigation made meanwhile superseded it.
// ---------------------------------------------------------------------------

let host: HTMLElement;

beforeAll(() => {
  const sheet = document.createElement("style");
  sheet.textContent = ".out { animation-name: fade; animation-duration: 0.3s; }";
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

/**
 * A branch whose factory returns the SAME element every time, so switching
 * back before the leave ends takes the leaving element back (a reclaim).
 */
function reclaimable(build: () => HTMLElement) {
  const [visible, setVisible] = signal(true);
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

describe("Suspense across a reclaim", () => {
  function mount() {
    const content = deferred<HTMLElement>();
    const nodes = vi.fn(() => content.promise);
    const fallbackCleanup = vi.fn();
    const r = reclaimable(() =>
      div({ class: "panel" }, [
        Suspense({
          nodes,
          fallback: () => {
            const f = span("loading");
            registerDisposer(f, fallbackCleanup);
            return f;
          },
        }),
      ]),
    );
    return { ...r, content, nodes, fallbackCleanup };
  }

  /** Content with a reactive binding and a cleanup, to see it is held and adopted. */
  function loadedContent(label: () => string) {
    const el = span(() => label());
    const cleanup = vi.fn();
    registerDisposer(el, cleanup);
    return { el, cleanup };
  }

  it("resolves while paused, is held, and is shown on reclaim without another nodes() call", async () => {
    const { setVisible, content, nodes, fallbackCleanup, shared } = mount();
    await flush();
    setVisible(false);
    expect(shared().classList.contains("out")).toBe(true);

    const [label, setLabel] = signal("v1");
    let reads = 0;
    const { el, cleanup } = loadedContent(() => {
      reads++;
      return label();
    });
    content.resolve(el);
    await flush();
    expect(shared().textContent).toBe("loading");
    // Held: its binding does not react while the branch is paused.
    const before = reads;
    setLabel("v2");
    expect(reads).toBe(before);

    setVisible(true);
    await flush();
    expect(shared().hasAttribute("inert")).toBe(false);
    expect(shared().classList.contains("out")).toBe(false);
    // Adopted once, caught up with the current state.
    expect(shared().textContent).toBe("v2");
    expect(nodes).toHaveBeenCalledTimes(1);
    expect(fallbackCleanup).toHaveBeenCalledTimes(1);
    expect(cleanup).not.toHaveBeenCalled();
    setLabel("v3");
    expect(shared().textContent).toBe("v3");
  });

  it("reclaimed before it resolves: commits once when it does", async () => {
    const { setVisible, content, nodes, shared } = mount();
    await flush();
    setVisible(false);
    setVisible(true);
    content.resolve(span("loaded"));
    await flush();
    expect(shared().textContent).toBe("loaded");
    expect(nodes).toHaveBeenCalledTimes(1);
  });

  it("repeated pause / resume cycles adopt once", async () => {
    const { setVisible, content, nodes, shared } = mount();
    await flush();
    for (let i = 0; i < 3; i++) {
      setVisible(false);
      setVisible(true);
    }
    setVisible(false);
    content.resolve(span("loaded"));
    await flush();
    setVisible(true);
    await flush();
    setVisible(false);
    setVisible(true);
    await flush();
    expect(shared().textContent).toBe("loaded");
    expect(shared().querySelectorAll("span")).toHaveLength(1);
    expect(nodes).toHaveBeenCalledTimes(1);
  });

  it("released while paused: a completed result is disposed once, never shown", async () => {
    const { setVisible, content, fallbackCleanup } = mount();
    await flush();
    setVisible(false);
    const { el, cleanup } = loadedContent(() => "loaded");
    content.resolve(el);
    await flush();
    end(host.querySelector(".out"));
    await flush();
    expect(host.textContent).toBe("off");
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(fallbackCleanup).toHaveBeenCalledTimes(1);
  });

  it("resolving after the branch ended: the late result is disposed, nothing renders", async () => {
    const { setVisible, content } = mount();
    await flush();
    setVisible(false);
    end(host.querySelector(".out"));
    const { el, cleanup } = loadedContent(() => "late");
    content.resolve(el);
    await flush();
    expect(host.textContent).toBe("off");
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("rejected while paused: the fallback stays; on reclaim the error is handled as usual", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { setVisible, content, shared } = mount();
    await flush();
    setVisible(false);
    content.reject(new Error("boom"));
    await flush();
    expect(shared().textContent).toBe("loading");
    expect(shared().querySelector(".suspense-error")).toBeNull();
    setVisible(true);
    await flush();
    expect(shared().querySelector(".suspense-error")?.textContent).toBe("boom");
  });
});

describe("a lazy route across a reclaim", () => {
  function mount() {
    const pending = deferred<{ default: () => HTMLElement }>();
    const load = vi.fn(() => pending.promise);
    const factory = vi.fn(() => span("home"));
    window.history.replaceState({}, "", "/");
    createRouter(
      [
        { path: "/", component: lazy(load) },
        { path: "/b", component: () => span("B") },
      ],
      { mode: "history" },
    );
    const r = reclaimable(() => div({ class: "page" }, [Route()]));
    return { ...r, pending, load, factory };
  }

  it("does not instantiate while paused; instantiates once from the cached module on reclaim", async () => {
    const { setVisible, pending, load, factory, shared } = mount();
    await flush();
    setVisible(false);
    pending.resolve({ default: factory });
    await flush(6);
    expect(factory).not.toHaveBeenCalled();

    setVisible(true);
    await flush(6);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(1);
    expect(shared().textContent).toBe("home");
  });

  it("a navigation made while paused supersedes the pending page", async () => {
    const { setVisible, pending, factory, shared } = mount();
    await flush();
    setVisible(false);
    await navigate("/b");
    pending.resolve({ default: factory });
    await flush(6);
    setVisible(true);
    await flush(6);
    expect(factory).not.toHaveBeenCalled();
    expect(shared().textContent).toBe("B");
  });

  it("released while paused: no factory runs and nothing is committed", async () => {
    const { setVisible, pending, factory } = mount();
    await flush();
    setVisible(false);
    end(host.querySelector(".out"));
    pending.resolve({ default: factory });
    await flush(6);
    expect(factory).not.toHaveBeenCalled();
    expect(host.textContent).toBe("off");
  });

  it("repeated reclaims instantiate once", async () => {
    const { setVisible, pending, factory, shared } = mount();
    await flush();
    setVisible(false);
    pending.resolve({ default: factory });
    await flush(6);
    for (let i = 0; i < 3; i++) {
      setVisible(true);
      setVisible(false);
    }
    setVisible(true);
    await flush(6);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(shared().querySelectorAll("span")).toHaveLength(1);
  });
});

describe("router.instantiateComponent() with a paused scope", () => {
  /** A gate the test drives, in the shape the router's internal scope uses. */
  function gate() {
    let open!: (active: boolean) => void;
    const until = new Promise<boolean>((r) => {
      open = r;
    });
    let held = true;
    const cancelled = new DOMException("cancelled", "AbortError");
    return {
      scope: {
        adopt: null,
        gate: {
          held: () => held,
          until: () => until,
          cancellation: () => cancelled,
          close: () => {},
        },
      } as never,
      resume: () => {
        held = false;
        open(true);
      },
      end: () => open(false),
      cancelled,
    };
  }

  function setup(factory: () => unknown) {
    window.history.replaceState({}, "", "/");
    const def = { path: "/x", component: lazy(() => Promise.resolve({ default: factory as () => HTMLElement })) };
    const router = createRouter([def], { mode: "history" });
    return { router, def };
  }

  it("stays pending while paused and resolves to one element on resume", async () => {
    const factory = vi.fn(() => span("x"));
    const { router, def } = setup(factory);
    const g = gate();
    const plan = await router.loadPlan(def, "/x");
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
    expect((settled as Element).textContent).toBe("x");
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("rejects with the gate's AbortError when the scope ends, without running the factory", async () => {
    const factory = vi.fn(() => span("x"));
    const { router, def } = setup(factory);
    const g = gate();
    const plan = await router.loadPlan(def, "/x");
    const result = router.instantiateComponent(plan, def, "/x", g.scope);
    g.end();
    await expect(result).rejects.toBe(g.cancelled);
    expect(factory).not.toHaveBeenCalled();
  });

  it("a genuine component error still rejects with that error", async () => {
    const failure = new Error("component broke");
    const { router, def } = setup(() => {
      throw failure;
    });
    const g = gate();
    const plan = await router.loadPlan(def, "/x");
    const result = router.instantiateComponent(plan, def, "/x", g.scope);
    g.resume();
    await expect(result).rejects.toBe(failure);
  });
});

describe("ownership", () => {
  it("a resumed child stays held while an ancestor is paused", () => {
    const outer = structuralBinding(() => {});
    let inner!: ReturnType<typeof structuralBinding>;
    let check!: ReturnType<typeof captureFrozen>;
    outer.run(() => {
      inner = structuralBinding(() => {});
      inner.run(() => {
        check = captureFrozen();
      });
    });
    const resumed = vi.fn();
    const ended = vi.fn();
    outer.freeze?.();
    inner.freeze?.();
    check.wait(resumed, ended);
    inner.thaw?.();
    expect(check()).toBe(true);
    outer.thaw?.();
    expect(check()).toBe(false);
    return Promise.resolve().then(() => {
      expect(resumed).toHaveBeenCalledTimes(1);
      expect(ended).not.toHaveBeenCalled();
      outer.stop();
      inner.stop();
    });
  });

  it("disposal ends the wait: onEnd once, never onActive", async () => {
    const outer = structuralBinding(() => {});
    let check!: ReturnType<typeof captureFrozen>;
    outer.run(() => {
      check = captureFrozen();
    });
    const resumed = vi.fn();
    const ended = vi.fn();
    outer.freeze?.();
    check.wait(resumed, ended);
    outer.stop();
    await Promise.resolve();
    expect(ended).toHaveBeenCalledTimes(1);
    expect(resumed).not.toHaveBeenCalled();
    expect(check.state()).toBe(2);
  });
});
