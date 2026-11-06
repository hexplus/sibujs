import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setRuntimeErrorHandler } from "../src/core/errors";
import { match, when } from "../src/core/rendering/directives";
import { dispose } from "../src/core/rendering/dispose";
import { Fragment } from "../src/core/rendering/fragment";
import { div, span } from "../src/core/rendering/html";
import { effect } from "../src/core/signals/effect";
import { type LifecycleScope, lifecycleScope } from "../src/core/signals/lifecycleScope";
import { signal } from "../src/core/signals/signal";
import { withSSR } from "../src/core/ssr-context";
import { structuralBinding, track } from "../src/reactivity/track";
import { heldListenerCount, type StructuralBinding } from "../src/reactivity/track-core";

// ---------------------------------------------------------------------------
// 3. Lifecycle registration is exception-safe.
// 4. A branch the directive built has a lifecycle of its own, with or without
//    a transition.
// 8. Work created after an `await` is owned only through a captured scope;
//    concurrent work never inherits another's lifecycle.
// ---------------------------------------------------------------------------

let host: HTMLElement;
let owners: StructuralBinding[] = [];
let reported: unknown[] = [];

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  reported = [];
  setRuntimeErrorHandler((error) => {
    reported.push(error);
  });
});

afterEach(() => {
  dispose(host);
  host.remove();
  for (const owner of owners) owner.stop();
  owners = [];
  setRuntimeErrorHandler(null);
  vi.restoreAllMocks();
});

const flush = async (turns = 4) => {
  for (let i = 0; i < turns; i++) await new Promise<void>((r) => setTimeout(r, 0));
};

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function owner() {
  const binding = structuralBinding(() => {});
  owners.push(binding);
  const scope = binding.run(() => lifecycleScope());
  return {
    scope,
    pause: () => binding.freeze?.(),
    resume: () => binding.thaw?.(),
    end: () => binding.stop(),
  };
}

describe("3. a registration that throws keeps nothing", () => {
  it("own(): rethrown synchronously, no listener left", () => {
    const { scope } = owner();
    const before = heldListenerCount();
    expect(() =>
      scope.own(() => {
        throw new Error("registration failed");
      }),
    ).toThrow("registration failed");
    expect(heldListenerCount()).toBe(before);
  });

  it("repeated failures accumulate no listener", () => {
    const { scope } = owner();
    const before = heldListenerCount();
    for (let i = 0; i < 25; i++) {
      try {
        scope.own(() => {
          throw new Error("again");
        });
      } catch {}
    }
    expect(heldListenerCount()).toBe(before);
  });

  it("an effect or watch whose first run throws: rethrown, nothing kept, its source has no subscriber", () => {
    const { scope } = owner();
    const [value, setValue] = signal(0);
    const before = heldListenerCount();
    let effectRuns = 0;
    expect(() =>
      scope.effect(() => {
        effectRuns++;
        value();
        throw new Error("effect failed");
      }),
    ).toThrow("effect failed");
    expect(() =>
      scope.watch(
        () => {
          value();
          throw new Error("getter failed");
        },
        () => {},
      ),
    ).toThrow("getter failed");
    expect(heldListenerCount()).toBe(before);
    setValue(1);
    expect(effectRuns).toBe(1);
  });

  it("deferred to a resume: the failure is reported, rolled back, and other waiting registrations still start", async () => {
    const o = owner();
    o.pause();
    const before = heldListenerCount();
    const started: string[] = [];
    const first = o.scope.own(() => {
      started.push("first");
      return () => started.push("first stopped");
    });
    o.scope.own(() => {
      throw new Error("deferred failure");
    });
    const last = o.scope.own(() => {
      started.push("last");
      return () => started.push("last stopped");
    });
    o.resume();
    await flush();
    expect(started).toEqual(["first", "last"]);
    expect(reported.map((e) => (e as Error).message)).toEqual(["deferred failure"]);
    first();
    last();
    expect(heldListenerCount()).toBe(before);
  });

  it("a registration that ends its own lifecycle disposes what it returned exactly once", () => {
    const o = owner();
    let stops = 0;
    const dispose = o.scope.own(() => {
      o.end();
      return () => stops++;
    });
    expect(stops).toBe(1);
    dispose();
    expect(stops).toBe(1);
  });

  it("a registration that ends its lifecycle and then throws: rethrown, nothing left", () => {
    const o = owner();
    const before = heldListenerCount();
    expect(() =>
      o.scope.own(() => {
        o.end();
        throw new Error("after end");
      }),
    ).toThrow("after end");
    expect(heldListenerCount()).toBeLessThanOrEqual(before);
  });
});

describe("4. owned branches have a lifecycle without a transition", () => {
  for (const kind of ["when", "match"] as const) {
    it(`${kind}(): replacing the branch ends its scope synchronously; scoped work stops with it`, async () => {
      const [on, setOn] = signal("a");
      const [value, setValue] = signal(0);
      const scopes: LifecycleScope[] = [];
      const log: string[] = [];
      const branch = (name: string) => () => {
        const scope = lifecycleScope();
        scopes.push(scope);
        scope.effect((onCleanup) => {
          log.push(`${name} ${value()}`);
          onCleanup(() => log.push(`${name} cleanup`));
        });
        return Fragment([span(name), span(`${name}-2`)]);
      };
      const anchor =
        kind === "when"
          ? when(() => on() === "a", branch("a"), branch("b"))
          : match(on, { a: branch("a"), b: branch("b") });
      host.appendChild(anchor);
      await flush();
      expect(scopes[0].state()).toBe("active");
      setOn("b");
      // Synchronously: no transition, so no pause either.
      expect(scopes[0].state()).toBe("ended");
      expect(log).toEqual(["a 0", "a cleanup", "b 0"]);
      setValue(1);
      expect(log).toEqual(["a 0", "a cleanup", "b 0", "b cleanup", "b 1"]);
      // Registered through the ended scope: never starts.
      let late = 0;
      scopes[0].effect(() => {
        late++;
      });
      expect(late).toBe(0);
      await flush();
      expect(late).toBe(0);
    });
  }

  it("a scope captured by a factory that returns nothing, or throws, is ended at once", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const [on, setOn] = signal(0);
    const scopes: LifecycleScope[] = [];
    host.appendChild(
      match(on, {
        "0": () => {
          scopes.push(lifecycleScope());
          return null as unknown as Node;
        },
        "1": () => {
          scopes.push(lifecycleScope());
          throw new Error("factory failed");
        },
        "2": () => span("ok"),
      }),
    );
    await flush();
    expect(scopes[0].state()).toBe("ended");
    try {
      setOn(1);
    } catch {}
    await flush();
    expect(scopes[1].state()).toBe("ended");
    setOn(2);
    await flush();
    expect(host.textContent).toBe("ok");
  });

  it("rapid switches end every intermediate branch", async () => {
    const [on, setOn] = signal(0);
    const scopes: LifecycleScope[] = [];
    const factory = () => {
      scopes.push(lifecycleScope());
      return span("x");
    };
    host.appendChild(match(on, { "0": factory, "1": factory, "2": factory }));
    await flush();
    setOn(1);
    setOn(2);
    setOn(0);
    setOn(1);
    expect(scopes.slice(0, -1).every((s) => s.state() === "ended")).toBe(true);
    expect(scopes[scopes.length - 1].state()).toBe("active");
  });

  it("caller-owned nodes are left alone: a bare element keeps its bindings across switches", async () => {
    const [on, setOn] = signal(true);
    const [label, setLabel] = signal("a");
    const bare = span(() => label());
    host.appendChild(when(on, bare, () => span("off")));
    await flush();
    setOn(false);
    setLabel("b");
    setOn(true);
    await flush();
    expect(bare.textContent).toBe("b");
    expect(bare.parentNode).toBe(host);
  });

  it("a factory returning the same node again keeps it working (reuse detection unchanged)", async () => {
    const [on, setOn] = signal(true);
    const [label, setLabel] = signal("a");
    const stable = span(() => label());
    host.appendChild(
      when(
        on,
        () => stable,
        () => span("off"),
      ),
    );
    await flush();
    setOn(false);
    setOn(true);
    setOn(false);
    setOn(true);
    await flush();
    expect(stable.parentNode).toBe(host);
    // Demoted to unowned on its second attach: its binding was disposed by the
    // first switch-away (documented), and nothing else tears it down again.
    setLabel("b");
    expect(stable.isConnected).toBe(true);
  });

  it("a transition's leave still pauses the branch, and the scope ends when the leave ends", async () => {
    const [on, setOn] = signal(true);
    let scope!: LifecycleScope;
    host.appendChild(
      when(
        on,
        () => {
          scope = lifecycleScope();
          return div({ class: "a" });
        },
        () => span("off"),
        { transition: { leave: () => new Promise<void>((r) => setTimeout(r, 30)) } },
      ),
    );
    await flush();
    setOn(false);
    expect(scope.state()).toBe("paused");
    await new Promise((r) => setTimeout(r, 80));
    expect(scope.state()).toBe("ended");
  });

  it("server render: transitions are off, and the branch's lifetime does not depend on them", async () => {
    const [on, setOn] = signal(true);
    let scope!: LifecycleScope;
    let anchor!: Comment;
    withSSR(() => {
      anchor = when(
        on,
        () => {
          scope = lifecycleScope();
          return span("a");
        },
        () => span("b"),
        { transition: { leaveClass: "out" } },
      );
    });
    host.appendChild(anchor);
    await flush();
    expect(scope.state()).toBe("active");
    setOn(false);
    // Ended at the switch, not paused for a leave the server never plays.
    expect(scope.state()).toBe("ended");
  });
});

describe("8. post-await work: owned through a captured scope only", () => {
  it("overlapping async tasks of two components never inherit each other's lifecycle", async () => {
    const [aOn, setAOn] = signal(true);
    const [bOn, setBOn] = signal(true);
    const [value, setValue] = signal(0);
    const gates = { a: deferred(), b: deferred() };
    const runs = { a: 0, b: 0, aUnscoped: 0 };
    const lateScopes: Record<string, LifecycleScope> = {};
    const stops: (() => void)[] = [];
    const Component = (name: "a" | "b") => () => {
      const scope = lifecycleScope();
      const el = div(name);
      void (async () => {
        await gates[name].promise;
        // A scope captured AFTER the await belongs to nothing: not to this
        // component, and not to whichever component rendered last.
        lateScopes[name] = lifecycleScope();
        scope.effect(() => {
          value();
          runs[name]++;
        });
        if (name === "a")
          stops.push(
            effect(() => {
              value();
              runs.aUnscoped++;
            }),
          );
      })();
      return el;
    };
    const leave = { leave: () => new Promise<void>(() => {}) };
    // Each component is built once and taken back while it leaves (the same
    // node again), so a resume is the same instance resuming.
    let aNode: Node | null = null;
    let bNode: Node | null = null;
    const buildA = Component("a");
    const buildB = Component("b");
    host.appendChild(
      when(
        aOn,
        () => (aNode ??= buildA()),
        () => span("a off"),
        { transition: leave },
      ),
    );
    host.appendChild(
      when(
        bOn,
        () => (bNode ??= buildB()),
        () => span("b off"),
        { transition: leave },
      ),
    );
    await flush();
    // Interleaved: b resolves first, then a.
    gates.b.resolve();
    await flush();
    gates.a.resolve();
    await flush();
    expect(runs).toEqual({ a: 1, b: 1, aUnscoped: 1 });
    expect(lateScopes.a.state()).toBe("active");
    expect(lateScopes.b.state()).toBe("active");
    // Pause a's branch only.
    setAOn(false);
    setValue(1);
    expect(runs).toEqual({ a: 1, b: 2, aUnscoped: 2 });
    // The unscoped effect and the late scopes are owned by nothing.
    expect(lateScopes.a.state()).toBe("active");
    // Pause b's branch instead; resume a's.
    setBOn(false);
    setAOn(true);
    await flush();
    expect(runs.a).toBe(2); // one catch-up
    setValue(2);
    expect(runs).toEqual({ a: 3, b: 2, aUnscoped: 3 });
    for (const stop of stops) stop();
  });

  it("track() inside own() follows the same contract", async () => {
    const o = owner();
    const [value, setValue] = signal(0);
    let runs = 0;
    o.scope.own(() =>
      track(() => {
        value();
        runs++;
      }),
    );
    o.pause();
    setValue(1);
    setValue(2);
    expect(runs).toBe(1);
    o.resume();
    expect(runs).toBe(2);
  });
});

describe("activation hooks", () => {
  it("onPause / onResume follow the lifecycle, coalesced, and stop when it ends", async () => {
    const o = owner();
    const log: string[] = [];
    o.scope.onPause(() => log.push("pause"));
    const dropResume = o.scope.onResume(() => log.push("resume"));
    o.pause();
    await flush();
    o.resume();
    await flush();
    // Paused and resumed within one task: nothing to deliver.
    o.pause();
    o.resume();
    await flush();
    expect(log).toEqual(["pause", "resume"]);
    dropResume();
    o.pause();
    await flush();
    o.resume();
    await flush();
    expect(log).toEqual(["pause", "resume", "pause"]);
    const before = heldListenerCount();
    o.end();
    expect(heldListenerCount()).toBeLessThan(before);
  });
});
