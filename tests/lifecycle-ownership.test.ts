import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispose, registerDisposer } from "../src/core/rendering/dispose";
import { div, span } from "../src/core/rendering/html";
import { type LifecycleScope, lifecycleScope } from "../src/core/signals/lifecycleScope";
import { signal } from "../src/core/signals/signal";
import { watch } from "../src/core/signals/watch";
import { getSubscriberCount } from "../src/devtools/introspect";
import { createRouter, destroyRouter, lazy, navigate, Route, type RouteDef, Suspense } from "../src/plugins/router";
import { getOwnerScope, structuralBinding, track } from "../src/reactivity/track";
import { heldListenerCount, type StructuralBinding } from "../src/reactivity/track-core";

// ---------------------------------------------------------------------------
// Lifecycle ownership, follow-ups:
//
// 1. A scoped registration never runs once its lifecycle ended — not even in
//    the task that ended it, and not as the catch-up of a pause.
// 2. Framework render callbacks (route factories, `Suspense.nodes()` and its
//    fallback) run in a lifecycle of their own, so `lifecycleScope()` works
//    inside them.
// 3. A resume notification is a reason to look again: every gated wait
//    re-checks, so a branch paused again keeps waiting.
// 4. Node-less bindings (`watch`, internal `track`) can be lifecycle-owned.
// ---------------------------------------------------------------------------

let host: HTMLElement;
let owners: StructuralBinding[] = [];

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  dispose(host);
  host.remove();
  for (const owner of owners) owner.stop();
  owners = [];
  destroyRouter();
  vi.restoreAllMocks();
});

const flush = async (turns = 4) => {
  for (let i = 0; i < turns; i++) await new Promise<void>((r) => setTimeout(r, 0));
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A structural owner to pause (`freeze`), resume (`thaw`) and end (`stop`). */
function owner() {
  const binding = structuralBinding(() => {});
  owners.push(binding);
  return {
    run: binding.run,
    pause: () => binding.freeze?.(),
    resume: () => binding.thaw?.(),
    end: () => binding.stop(),
  };
}

describe("1. a scoped effect never runs after its lifecycle ended", () => {
  function scoped(o: ReturnType<typeof owner>) {
    const [value, setValue] = signal(0);
    const log: string[] = [];
    let scope!: LifecycleScope;
    o.run(() => {
      scope = lifecycleScope();
    });
    const stop = scope.effect((onCleanup) => {
      const v = value();
      log.push(`run ${v}`);
      onCleanup(() => log.push(`cleanup ${v}`));
    });
    return { setValue, log, stop, scope };
  }

  it("A. a write right after the owner's disposal", async () => {
    const o = owner();
    const { setValue, log } = scoped(o);
    o.end();
    expect(log).toEqual(["run 0", "cleanup 0"]);
    setValue(1);
    expect(log).toEqual(["run 0", "cleanup 0"]);
    await flush();
    expect(log).toEqual(["run 0", "cleanup 0"]);
  });

  it("B. a dirty paused effect is dropped, not caught up, when the owner ends", async () => {
    const o = owner();
    const { setValue, log } = scoped(o);
    o.pause();
    setValue(1);
    expect(log).toEqual(["run 0"]);
    o.end();
    expect(log).toEqual(["run 0", "cleanup 0"]);
    await flush();
    setValue(2);
    await flush();
    expect(log).toEqual(["run 0", "cleanup 0"]);
  });

  it("ends with an ancestor: nested owner disposal", async () => {
    const outer = owner();
    const inner = outer.run(() => owner());
    const { setValue, log, scope } = scoped(inner);
    outer.end();
    expect(scope.state()).toBe("ended");
    setValue(1);
    expect(log).toEqual(["run 0", "cleanup 0"]);
    await flush();
    expect(log).toEqual(["run 0", "cleanup 0"]);
  });

  it("ends during its own initial run", async () => {
    const o = owner();
    const [value, setValue] = signal(0);
    const log: string[] = [];
    let scope!: LifecycleScope;
    o.run(() => {
      scope = lifecycleScope();
    });
    scope.effect((onCleanup) => {
      log.push(`run ${value()}`);
      onCleanup(() => log.push("cleanup"));
      o.end();
    });
    expect(log).toEqual(["run 0", "cleanup"]);
    setValue(1);
    await flush();
    expect(log).toEqual(["run 0", "cleanup"]);
  });

  it("a deferred initial run never happens once the lifecycle ended", async () => {
    const o = owner();
    const [value, setValue] = signal(0);
    const runs = vi.fn(() => value());
    let scope!: LifecycleScope;
    o.run(() => {
      scope = lifecycleScope();
    });
    o.pause();
    const stop = scope.effect(runs);
    o.end();
    setValue(1);
    await flush();
    expect(runs).not.toHaveBeenCalled();
    stop();
    stop();
    expect(heldListenerCount()).toBe(0);
  });

  it("a genuine resume still catches up once, cleanups first; disposers stay idempotent", async () => {
    const o = owner();
    const { setValue, log, stop } = scoped(o);
    o.pause();
    setValue(1);
    setValue(2);
    o.resume();
    expect(log).toEqual(["run 0", "cleanup 0", "run 2"]);
    stop();
    stop();
    o.end();
    expect(log).toEqual(["run 0", "cleanup 0", "run 2", "cleanup 2"]);
  });

  it("an unscoped effect created under the same owner keeps its documented behaviour", async () => {
    const o = owner();
    const [value, setValue] = signal(0);
    const seen: number[] = [];
    let scope!: LifecycleScope;
    o.run(() => {
      scope = lifecycleScope();
    });
    // Created through the scope's owner but not through the scope: plain.
    const { effect } = await import("../src/core/signals/effect");
    const stop = o.run(() => effect(() => void seen.push(value())));
    o.end();
    expect(scope.state()).toBe("ended");
    setValue(1);
    expect(seen).toEqual([0, 1]);
    stop();
  });
});

describe("2. lifecycleScope() inside framework render callbacks", () => {
  it("Suspense.nodes(): active, paused, resumed, ended; registration after its await", async () => {
    const o = owner();
    const ready = deferred<void>();
    const [value, setValue] = signal("a");
    const seen: string[] = [];
    let scope!: LifecycleScope;
    const anchor = o.run(() =>
      Suspense({
        nodes: async () => {
          scope = lifecycleScope();
          await ready.promise;
          scope.effect(() => void seen.push(value()));
          return div("content");
        },
      }),
    );
    host.appendChild(anchor);
    await flush();
    expect(scope.state()).toBe("active");
    o.pause();
    expect(scope.state()).toBe("paused");
    ready.resolve();
    await flush();
    expect(seen).toEqual([]);
    o.resume();
    await flush();
    expect(scope.state()).toBe("active");
    expect(seen).toEqual(["a"]);
    // The boundary ends the content's lifecycle; the shell lives on.
    dispose(anchor);
    expect(scope.state()).toBe("ended");
    setValue("b");
    expect(seen).toEqual(["a"]);
  });

  it("Suspense fallback(): its lifecycle ends when the content replaces it", async () => {
    const o = owner();
    const ready = deferred<HTMLElement>();
    let scope!: LifecycleScope;
    host.appendChild(
      o.run(() =>
        Suspense({
          nodes: () => ready.promise,
          fallback: () => {
            scope = lifecycleScope();
            return span("loading");
          },
        }),
      ),
    );
    await flush();
    o.pause();
    expect(scope.state()).toBe("paused");
    o.resume();
    expect(scope.state()).toBe("active");
    ready.resolve(div("content"));
    await flush();
    expect(scope.state()).toBe("ended");
  });

  it("concurrent renders are independent", async () => {
    const a = owner();
    const b = owner();
    const scopes: LifecycleScope[] = [];
    for (const o of [a, b]) {
      host.appendChild(
        o.run(() =>
          Suspense({
            nodes: () => {
              scopes.push(lifecycleScope());
              return div("x");
            },
          }),
        ),
      );
    }
    await flush();
    a.pause();
    expect(scopes.map((s) => s.state())).toEqual(["paused", "active"]);
    b.end();
    expect(scopes.map((s) => s.state())).toEqual(["paused", "ended"]);
  });

  const pageDefs: Record<string, (page: () => HTMLElement) => unknown> = {
    direct: (page) => page,
    async: (page) => async () => page(),
    lazy: (page) => lazy(() => Promise.resolve({ default: page })),
    unwrapped: (page) => (async () => ({ default: page })) as never,
  };

  for (const [kind, make] of Object.entries(pageDefs)) {
    it(`a ${kind} route component: active, paused, resumed, ended on replacement`, async () => {
      const o = owner();
      const scopes: LifecycleScope[] = [];
      const page = () => {
        scopes.push(lifecycleScope());
        return div("page");
      };
      window.history.replaceState({}, "", "/a");
      createRouter(
        [
          { path: "/a", component: make(page) },
          { path: "/b", component: () => div("b") },
        ] as RouteDef[],
        { mode: "history" },
      );
      host.appendChild(o.run(() => Route()));
      await flush();
      expect(scopes).toHaveLength(1);
      expect(scopes[0].state()).toBe("active");
      o.pause();
      expect(scopes[0].state()).toBe("paused");
      o.resume();
      expect(scopes[0].state()).toBe("active");
      await navigate("/b");
      await flush();
      // Replaced: ended, although the shell (the owner) is alive.
      expect(scopes[0].state()).toBe("ended");
      // Mounted again (the lazy plan is cached by now): a new lifecycle.
      await navigate("/a");
      await flush();
      expect(scopes).toHaveLength(2);
      expect(scopes[1].state()).toBe("active");
    });
  }

  it("a scope captured before a route component's await owns what it registers after it", async () => {
    const o = owner();
    const ready = deferred<void>();
    const [value, setValue] = signal(0);
    const seen: number[] = [];
    window.history.replaceState({}, "", "/a");
    createRouter(
      [
        {
          path: "/a",
          component: async () => {
            const scope = lifecycleScope();
            await ready.promise;
            scope.effect(() => void seen.push(value()));
            return div("a");
          },
        },
        { path: "/b", component: () => div("b") },
      ],
      { mode: "history" },
    );
    host.appendChild(o.run(() => Route()));
    await flush();
    ready.resolve();
    await flush();
    expect(seen).toEqual([0]);
    o.pause();
    setValue(1);
    expect(seen).toEqual([0]);
    o.resume();
    expect(seen).toEqual([0, 1]);
    await navigate("/b");
    await flush();
    setValue(2);
    expect(seen).toEqual([0, 1]);
  });

  it("outside any render the scope stays active", () => {
    const scope = lifecycleScope();
    expect(scope.state()).toBe("active");
  });
});

describe("3. every gated wait re-checks after a resume notification", () => {
  async function mount(component: () => HTMLElement | Promise<HTMLElement>) {
    const o = owner();
    const states: string[] = [];
    let routeScope: unknown;
    const factory = vi.fn(() => {
      states.push(lifecycleScope().state());
      routeScope ??= getOwnerScope();
      return component();
    });
    const def = { path: "/a", component: factory as never };
    window.history.replaceState({}, "", "/a");
    const router = createRouter([def, { path: "/b", component: () => div("b") }], { mode: "history" });
    host.appendChild(o.run(() => Route()));
    await flush();
    return { o, states, factory, router, def, scope: () => routeScope as never };
  }

  /** Resume, then pause again before any continuation woken by the resume runs. */
  const resumeThenPauseAgain = (o: ReturnType<typeof owner>) => {
    o.resume();
    queueMicrotask(() => o.pause());
  };

  it("a factory call stays pending through a second pause, and runs on the second resume", async () => {
    const { o, states, factory, router, def, scope } = await mount(() => div("page"));
    expect(states).toEqual(["active"]);
    o.pause();
    const plan = await router.loadPlan(def, "/a");
    let settled: unknown = "pending";
    const pending = router.instantiateComponent(plan, def, "/a", scope()).then(
      (el) => (settled = el),
      (err) => (settled = err),
    );
    await flush();
    resumeThenPauseAgain(o);
    await flush();
    expect(states).toEqual(["active"]);
    expect(settled).toBe("pending");
    o.resume();
    await pending;
    expect(states).toEqual(["active", "active"]);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("an owner that ends after a second pause cancels the call", async () => {
    const { o, factory, router, def, scope } = await mount(() => div("page"));
    o.pause();
    const plan = await router.loadPlan(def, "/a");
    const pending = router.instantiateComponent(plan, def, "/a", scope());
    await flush();
    resumeThenPauseAgain(o);
    await flush();
    o.end();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("a navigation made while paused supersedes the call", async () => {
    const { o, factory, router, def, scope } = await mount(() => div("page"));
    o.pause();
    const plan = await router.loadPlan(def, "/a");
    const pending = router.instantiateComponent(plan, def, "/a", scope());
    await navigate("/b");
    o.resume();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("a node built while paused stays held through a second pause; committed and caught up on the second resume", async () => {
    const ready = deferred<void>();
    const [label, setLabel] = signal("a");
    let runs = 0;
    const cleanup = vi.fn();
    const { o } = await mount(async () => {
      await ready.promise;
      const el = span(() => {
        runs++;
        return label();
      });
      registerDisposer(el, cleanup);
      return el;
    });
    o.pause();
    ready.resolve();
    await flush();
    expect(runs).toBe(1);
    setLabel("b");
    resumeThenPauseAgain(o);
    await flush();
    expect(runs).toBe(1);
    expect(host.textContent).toBe("");
    setLabel("c");
    o.resume();
    await flush();
    expect(runs).toBe(2);
    expect(host.textContent).toBe("c");
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("a node held through a second pause is disposed without waking its bindings when the owner ends", async () => {
    const ready = deferred<void>();
    const [label, setLabel] = signal("a");
    let runs = 0;
    const cleanup = vi.fn();
    const { o } = await mount(async () => {
      await ready.promise;
      const el = span(() => {
        runs++;
        return label();
      });
      registerDisposer(el, cleanup);
      return el;
    });
    o.pause();
    ready.resolve();
    await flush();
    resumeThenPauseAgain(o);
    await flush();
    setLabel("b");
    o.end();
    await flush();
    expect(runs).toBe(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(host.textContent).toBe("");
  });

  it("an active outlet still invokes synchronously after its plan resolves", async () => {
    const { states, factory } = await mount(() => div("page"));
    expect(states).toEqual(["active"]);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(host.textContent).toBe("page");
  });
});

describe("4. lifecycle-owned node-less bindings", () => {
  function setup() {
    const o = owner();
    let scope!: LifecycleScope;
    o.run(() => {
      scope = lifecycleScope();
    });
    return { o, scope };
  }

  it("watch() after an await: current and previous values, coalesced over a pause", async () => {
    const { o, scope } = setup();
    const [value, setValue] = signal(1);
    const calls: [number, number | undefined][] = [];
    await Promise.resolve();
    scope.watch(value, (v, prev) => void calls.push([v, prev]));
    setValue(2);
    expect(calls).toEqual([[2, 1]]);
    o.pause();
    setValue(3);
    setValue(4);
    expect(calls).toEqual([[2, 1]]);
    o.resume();
    expect(calls).toEqual([
      [2, 1],
      [4, 2],
    ]);
    // Back to the delivered value while paused: nothing to deliver.
    o.pause();
    setValue(5);
    setValue(4);
    o.resume();
    expect(calls).toHaveLength(2);
    expect(getSubscriberCount(value)).toBe(1);
  });

  it("watch() created while paused reads its initial value on resume", async () => {
    const { o, scope } = setup();
    const [value, setValue] = signal(1);
    const calls: [number, number | undefined][] = [];
    o.pause();
    scope.watch(value, (v, prev) => void calls.push([v, prev]));
    setValue(2);
    o.resume();
    await flush();
    expect(calls).toEqual([]);
    setValue(3);
    expect(calls).toEqual([[3, 2]]);
  });

  it("own(track) after an await: suppressed while paused, one run on resume", async () => {
    const { o, scope } = setup();
    const [value, setValue] = signal(0);
    const seen: number[] = [];
    await Promise.resolve();
    scope.own(() => track(() => void seen.push(value())));
    o.pause();
    setValue(1);
    setValue(2);
    expect(seen).toEqual([0]);
    o.resume();
    expect(seen).toEqual([0, 2]);
    expect(getSubscriberCount(value)).toBe(1);
  });

  it("disposal before initialization, and while dirty", async () => {
    const { o, scope } = setup();
    const [value, setValue] = signal(0);
    const cb = vi.fn();
    const runs = vi.fn(() => value());
    o.pause();
    const stopWatch = scope.watch(value, cb);
    stopWatch();
    o.resume();
    await flush();
    setValue(1);
    expect(cb).not.toHaveBeenCalled();
    const stopTrack = scope.own(() => track(runs));
    expect(runs).toHaveBeenCalledTimes(1);
    o.pause();
    setValue(2);
    stopTrack();
    o.resume();
    setValue(3);
    expect(runs).toHaveBeenCalledTimes(1);
    expect(getSubscriberCount(value)).toBe(0);
  });

  it("nothing runs after the owner ends, in the same task; cleanup once", async () => {
    const { o, scope } = setup();
    const [value, setValue] = signal(0);
    const cb = vi.fn();
    const runs = vi.fn(() => value());
    const release = vi.fn();
    scope.watch(value, cb);
    scope.own(() => {
      const stop = track(runs);
      return () => {
        release();
        stop();
      };
    });
    o.pause();
    setValue(1);
    o.end();
    expect(release).toHaveBeenCalledTimes(1);
    setValue(2);
    expect(cb).not.toHaveBeenCalled();
    expect(runs).toHaveBeenCalledTimes(1);
    expect(getSubscriberCount(value)).toBe(0);
    await flush();
    expect(release).toHaveBeenCalledTimes(1);
    expect(heldListenerCount()).toBe(0);
  });

  it("independent scopes and unscoped bindings are unaffected", async () => {
    const one = setup();
    const two = setup();
    const [value, setValue] = signal(0);
    const a = vi.fn();
    const b = vi.fn();
    const plain = vi.fn();
    one.scope.watch(value, a);
    two.scope.watch(value, b);
    const stopPlain = one.o.run(() => watch(value, plain));
    one.o.pause();
    setValue(1);
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
    // A plain watcher created through the owner, not the scope, is paused
    // with it too (it was created under that owner) — but an unscoped one
    // created after an await is not: it has no owner.
    await Promise.resolve();
    const late = vi.fn();
    const stopLate = watch(value, late);
    setValue(2);
    expect(late).toHaveBeenCalledTimes(1);
    one.o.end();
    setValue(3);
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(3);
    stopPlain();
    stopLate();
  });

  it("repeated cycles accumulate no edges or lifecycle listeners", async () => {
    const { o, scope } = setup();
    const [value, setValue] = signal(0);
    const cb = vi.fn();
    scope.watch(value, cb);
    scope.effect(() => void value());
    scope.own(() => track(() => void value()));
    const listeners = heldListenerCount();
    for (let i = 1; i <= 20; i++) {
      o.pause();
      setValue(i);
      o.resume();
    }
    await flush();
    expect(cb).toHaveBeenCalledTimes(20);
    expect(getSubscriberCount(value)).toBe(3);
    expect(heldListenerCount()).toBe(listeners);
    o.end();
    expect(getSubscriberCount(value)).toBe(0);
    expect(heldListenerCount()).toBe(0);
  });
});

describe("5. a leaving branch holds its DOM, not only what its owner reaches", () => {
  async function mount() {
    const { when } = await import("../src/core/rendering/directives");
    const sheet = document.createElement("style");
    sheet.textContent = ".out { animation-name: fade; animation-duration: 0.3s; }";
    document.head.appendChild(sheet);
    const [on, setOn] = signal(true);
    const [label, setLabel] = signal("a");
    const ready = deferred<void>();
    let runs = 0;
    let shared: HTMLElement | null = null;
    host.appendChild(
      when(
        on,
        () => {
          if (shared) return shared;
          const el = div({ class: "panel" });
          // Built after an await: no structural owner reaches this binding.
          void ready.promise.then(() =>
            el.appendChild(
              span(() => {
                runs++;
                return label();
              }),
            ),
          );
          shared = el;
          return el;
        },
        () => span("off"),
        { transition: { leaveClass: "out" } },
      ),
    );
    ready.resolve();
    await flush();
    return { setOn, setLabel, runs: () => runs, panel: () => shared as HTMLElement };
  }

  it("is paused while the branch leaves and caught up once when it is taken back", async () => {
    const { setOn, setLabel, runs, panel } = await mount();
    expect(runs()).toBe(1);
    setOn(false);
    setLabel("b");
    setLabel("c");
    expect(runs()).toBe(1);
    expect(panel().textContent).toBe("a");
    setOn(true);
    expect(runs()).toBe(2);
    expect(panel().textContent).toBe("c");
  });

  it("is dropped, not woken, when the branch ends", async () => {
    const { setOn, setLabel, runs } = await mount();
    setOn(false);
    setLabel("b");
    host.querySelector(".out")?.dispatchEvent(new Event("animationend"));
    await flush();
    expect(runs()).toBe(1);
    setLabel("c");
    expect(runs()).toBe(1);
  });
});
