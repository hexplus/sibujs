import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "../src/components/ErrorBoundary";
import { setRuntimeErrorHandler } from "../src/core/errors";
import { div } from "../src/core/rendering/html";
import { signal } from "../src/core/signals/signal";
import { batch } from "../src/reactivity/batch";

// ---------------------------------------------------------------------------
// `resetKeys` are VALUES with a baseline, not invalidation pulses.
//
// The documented contract is "whenever any of these VALUES change AFTER an
// error has been caught". Two words carry the whole semantics:
//
//   VALUES — a getter that re-runs because its source was replaced, but which
//            returns an equal result, has not changed. Selectors over larger
//            objects (`() => route().pathname`) are the normal way to use
//            resetKeys, and they must not fire on every unrelated field write.
//
//   AFTER  — a key write that is itself the reason the children threw belongs
//            to the failure, not to the recovery. It must not immediately undo
//            the error it just caused.
//
// The old implementation invoked each getter purely to register the dependency
// and discarded the result, then treated any re-run of its permanent watcher as
// a reset event. Both properties above were therefore unimplemented.
// ---------------------------------------------------------------------------

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

let host: HTMLElement | null = null;

function mount(node: Node): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  container.appendChild(node);
  host = container;
  return container;
}

afterEach(() => {
  setRuntimeErrorHandler(null);
  host?.remove();
  host = null;
  vi.restoreAllMocks();
});

/** Boundary whose child throws on demand, independent of the reset keys. */
function boundaryWithSwitch(resetKeys: Array<() => unknown>) {
  const [fail, setFail] = signal(false);
  const node = ErrorBoundary({ resetKeys, fallback: () => div({ class: "fallback", nodes: "failed" }) }, () =>
    div({
      class: "content",
      nodes: () => {
        if (fail()) throw new Error("boom");
        return "ok";
      },
    }),
  );
  return { node, fail: () => setFail(true), heal: () => setFail(false) };
}

// ---------------------------------------------------------------------------
// Defect A — getter OUTPUT equality
// ---------------------------------------------------------------------------

describe("resetKeys compare selected values, not dependency invalidation", () => {
  it("does not reset when the backing object is replaced but the selected value is equal", async () => {
    setRuntimeErrorHandler(() => {});
    const [route, setRoute] = signal({ pathname: "/a", nonce: 1 });
    const b = boundaryWithSwitch([() => route().pathname]);
    const container = mount(b.node);
    await flush();

    b.fail();
    await flush();
    expect(container.querySelector(".fallback")).not.toBeNull();

    // The signal changes by identity; the SELECTED value does not.
    b.heal();
    setRoute({ pathname: "/a", nonce: 2 });
    await flush();
    expect(container.querySelector(".fallback")).not.toBeNull();

    // A genuine change of the selected value does recover it.
    setRoute({ pathname: "/b", nonce: 3 });
    await flush();
    expect(container.querySelector(".fallback")).toBeNull();
    expect(container.querySelector(".content")).not.toBeNull();
  });

  it("realistic selector: user().id unchanged while name changes", async () => {
    setRuntimeErrorHandler(() => {});
    const [user, setUser] = signal({ id: 42, name: "Alice" });
    const b = boundaryWithSwitch([() => user().id]);
    const container = mount(b.node);
    await flush();

    b.fail();
    await flush();
    expect(container.querySelector(".fallback")).not.toBeNull();

    b.heal();
    setUser({ id: 42, name: "Bob" }); // same id
    await flush();
    expect(container.querySelector(".fallback")).not.toBeNull();

    setUser({ id: 43, name: "Bob" }); // id changed
    await flush();
    expect(container.querySelector(".fallback")).toBeNull();
  });

  it("uses Object.is: NaN -> NaN is unchanged", async () => {
    setRuntimeErrorHandler(() => {});
    const [n, setN] = signal(Number.NaN);
    const b = boundaryWithSwitch([n]);
    const container = mount(b.node);
    await flush();

    b.fail();
    await flush();
    expect(container.querySelector(".fallback")).not.toBeNull();

    b.heal();
    // A fresh NaN write. `===` would call this a change; Object.is does not.
    // (The signal itself also uses Object.is, so this asserts the whole path.)
    setN(Number.NaN);
    await flush();
    expect(container.querySelector(".fallback")).not.toBeNull();

    setN(1);
    await flush();
    expect(container.querySelector(".fallback")).toBeNull();
  });

  it("a stable object reference is unchanged; a new equal-shaped one is a change", async () => {
    setRuntimeErrorHandler(() => {});
    const stable = { id: 1 };
    const [obj, setObj] = signal(stable);
    const b = boundaryWithSwitch([obj]);
    const container = mount(b.node);
    await flush();

    b.fail();
    await flush();
    b.heal();

    setObj(stable); // same reference
    await flush();
    expect(container.querySelector(".fallback")).not.toBeNull();

    setObj({ id: 1 }); // new reference, structurally equal — a change
    await flush();
    expect(container.querySelector(".fallback")).toBeNull();
  });

  it("conditional selector: dependency topology changes but the value is equal", async () => {
    setRuntimeErrorHandler(() => {});
    const [which, setWhich] = signal("a");
    const [a] = signal({ id: 1 });
    const [bSig, setB] = signal({ id: 1 });
    const b = boundaryWithSwitch([() => (which() === "a" ? a().id : bSig().id)]);
    const container = mount(b.node);
    await flush();

    b.fail();
    await flush();
    expect(container.querySelector(".fallback")).not.toBeNull();

    b.heal();
    setWhich("b"); // different dependency set, same selected value (1)
    await flush();
    expect(container.querySelector(".fallback")).not.toBeNull();

    setB({ id: 2 }); // now the selected value really moves
    await flush();
    expect(container.querySelector(".fallback")).toBeNull();
  });

  it("multiple keys: all outputs equal -> no reset; one output changes -> retry", async () => {
    setRuntimeErrorHandler(() => {});
    const [route, setRoute] = signal({ pathname: "/x", nonce: 1 });
    const [user, setUser] = signal({ id: 7, name: "A" });
    const [locale, setLocale] = signal("en");
    const b = boundaryWithSwitch([() => route().pathname, () => user().id, locale]);
    const container = mount(b.node);
    await flush();

    b.fail();
    await flush();
    b.heal();

    setRoute({ pathname: "/x", nonce: 2 });
    await flush();
    setUser({ id: 7, name: "B" });
    await flush();
    expect(container.querySelector(".fallback")).not.toBeNull();

    setLocale("fr"); // one selected output moves
    await flush();
    expect(container.querySelector(".fallback")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Defect B — the key write that CAUSES the failure is part of the baseline
// ---------------------------------------------------------------------------

describe("a reset-key change that causes the failure does not undo it", () => {
  /** The SAME signal is both the reset key and the reason the child throws. */
  function sharedSourceBoundary() {
    const [route, setRoute] = signal("/good");
    const node = ErrorBoundary(
      { resetKeys: [route], fallback: () => div({ class: "fallback", nodes: "failed" }) },
      () =>
        div({
          class: "content",
          nodes: () => {
            if (route() === "/bad") throw new Error("bad route");
            return "ok";
          },
        }),
    );
    return { node, setRoute };
  }

  it("one write that both changes the key and makes the child throw leaves the boundary failed", async () => {
    setRuntimeErrorHandler(() => {});
    const { node, setRoute } = sharedSourceBoundary();
    const container = mount(node);
    await flush();
    expect(container.querySelector(".content")).not.toBeNull();

    // ONE update: the reset key changes AND the child starts throwing.
    setRoute("/bad");
    await flush();

    // The key change belongs to the failure, not the recovery.
    expect(container.querySelector(".fallback")).not.toBeNull();
  });

  it("a key change AFTER that failure does recover it", async () => {
    setRuntimeErrorHandler(() => {});
    const { node, setRoute } = sharedSourceBoundary();
    const container = mount(node);
    await flush();

    setRoute("/bad");
    await flush();
    expect(container.querySelector(".fallback")).not.toBeNull();

    setRoute("/good");
    await flush();
    expect(container.querySelector(".fallback")).toBeNull();
    expect(container.querySelector(".content")).not.toBeNull();
  });

  it("holds inside a batch too — correctness must not depend on ordering", async () => {
    setRuntimeErrorHandler(() => {});
    const [route, setRoute] = signal("/good");
    const [other, setOther] = signal(0);
    const node = ErrorBoundary(
      { resetKeys: [route], fallback: () => div({ class: "fallback", nodes: "failed" }) },
      () =>
        div({
          class: "content",
          nodes: () => {
            other();
            if (route() === "/bad") throw new Error("bad route");
            return "ok";
          },
        }),
    );
    const container = mount(node);
    await flush();

    batch(() => {
      setRoute("/bad");
      setOther(1);
    });
    await flush();

    expect(container.querySelector(".fallback")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Episode lifecycle
// ---------------------------------------------------------------------------

describe("reset-key baselines are per error episode", () => {
  it("re-failing immediately after a retry does not loop", async () => {
    setRuntimeErrorHandler(() => {});
    const [route, setRoute] = signal("/a");
    // The child throws for every route value, so a retry re-fails at once.
    // The throw propagates out of `children()` so the boundary's own try/catch
    // sees it — a throw raised inside a `nodes:` binding during initial
    // construction has no attached node yet and so reaches the runtime handler
    // instead (covered separately in ErrorBoundary-ownership).
    const node = ErrorBoundary(
      { resetKeys: [route], fallback: () => div({ class: "fallback", nodes: "failed" }) },
      () => {
        route();
        throw new Error("always broken");
      },
    );
    const container = mount(node);
    await flush();
    expect(container.querySelector(".fallback")).not.toBeNull();

    // A key change retries; the child throws again immediately.
    setRoute("/b");
    await flush();
    expect(container.querySelector(".fallback")).not.toBeNull();

    // And the boundary settles rather than spinning.
    setRoute("/c");
    await flush();
    expect(container.querySelector(".fallback")).not.toBeNull();
  });

  it("full cycle: healthy -> fail -> key -> recover -> fail -> stays failed -> key -> recover", async () => {
    setRuntimeErrorHandler(() => {});
    const [route, setRoute] = signal("A");
    const b = boundaryWithSwitch([route]);
    const container = mount(b.node);
    await flush();

    b.fail();
    await flush();
    expect(container.querySelector(".fallback")).not.toBeNull();

    b.heal();
    setRoute("B");
    await flush();
    expect(container.querySelector(".fallback")).toBeNull();

    b.fail();
    await flush();
    expect(container.querySelector(".fallback")).not.toBeNull();

    // No stale baseline from the first episode may leak in.
    b.heal();
    setRoute("C");
    await flush();
    expect(container.querySelector(".fallback")).toBeNull();
  });

  it("a key change while healthy does not arm recovery for a later failure", async () => {
    setRuntimeErrorHandler(() => {});
    const [route, setRoute] = signal("A");
    const b = boundaryWithSwitch([route]);
    const container = mount(b.node);
    await flush();

    setRoute("B"); // healthy
    await flush();

    b.fail();
    await flush();
    expect(container.querySelector(".fallback")).not.toBeNull();
  });

  it("explicit retry still works with no key change, and re-baselines", async () => {
    setRuntimeErrorHandler(() => {});
    const [route] = signal("A");
    const [fail, setFail] = signal(false);
    const retryRef: { fn: (() => void) | null } = { fn: null };

    const node = ErrorBoundary(
      {
        resetKeys: [route],
        fallback: (_e, retry) => {
          retryRef.fn = retry;
          return div({ class: "fallback", nodes: "failed" });
        },
      },
      () =>
        div({
          class: "content",
          nodes: () => {
            if (fail()) throw new Error("boom");
            return "ok";
          },
        }),
    );
    const container = mount(node);
    await flush();

    setFail(true);
    await flush();
    expect(container.querySelector(".fallback")).not.toBeNull();

    setFail(false);
    retryRef.fn?.();
    await flush();
    expect(container.querySelector(".fallback")).toBeNull();

    setFail(true);
    await flush();
    expect(container.querySelector(".fallback")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Throwing getters
// ---------------------------------------------------------------------------

describe("throwing reset-key getters", () => {
  it("reports through the central pipeline and does not falsely reset while it keeps throwing", async () => {
    const seen: Array<{ message: string; phase: string; name?: string }> = [];
    setRuntimeErrorHandler((error, context) =>
      seen.push({ message: (error as Error).message, phase: context.phase, name: context.name }),
    );

    const [tick, setTick] = signal(0);
    const b = boundaryWithSwitch([
      () => {
        tick();
        throw new Error("bad getter");
      },
    ]);
    const container = mount(b.node);
    await flush();

    b.fail();
    await flush();
    expect(container.querySelector(".fallback")).not.toBeNull();

    // The getter keeps throwing. A per-run sentinel object would look like a
    // new value every time and reset the boundary spuriously.
    b.heal();
    setTick(1);
    await flush();
    setTick(2);
    await flush();
    expect(container.querySelector(".fallback")).not.toBeNull();

    const reports = seen.filter((s) => s.message === "bad getter");
    expect(reports.length).toBeGreaterThan(0);
    expect(reports[0].phase).toBe("effect");
    expect(reports[0].name).toBe("ErrorBoundary.resetKeys");
  });

  it("a throwing getter does not stop a sibling key from recovering the boundary", async () => {
    setRuntimeErrorHandler(() => {});
    const [route, setRoute] = signal({ pathname: "/a", nonce: 1 });
    const b = boundaryWithSwitch([
      () => {
        throw new Error("bad getter");
      },
      () => route().pathname,
    ]);
    const container = mount(b.node);
    await flush();

    b.fail();
    await flush();
    expect(container.querySelector(".fallback")).not.toBeNull();

    // Equal selected value -> still failed.
    b.heal();
    setRoute({ pathname: "/a", nonce: 2 });
    await flush();
    expect(container.querySelector(".fallback")).not.toBeNull();

    // Real change on the valid sibling -> recovers.
    setRoute({ pathname: "/b", nonce: 3 });
    await flush();
    expect(container.querySelector(".fallback")).toBeNull();
  });

  it("transitions valid -> throwing and throwing -> valid count as changes", async () => {
    setRuntimeErrorHandler(() => {});
    const [mode, setMode] = signal<"ok" | "throw">("ok");
    const b = boundaryWithSwitch([
      () => {
        if (mode() === "throw") throw new Error("bad getter");
        return "stable";
      },
    ]);
    const container = mount(b.node);
    await flush();

    b.fail();
    await flush();
    expect(container.querySelector(".fallback")).not.toBeNull();

    // valid -> throwing is a state change, so the boundary recovers.
    b.heal();
    setMode("throw");
    await flush();
    expect(container.querySelector(".fallback")).toBeNull();

    // Fail again, then throwing -> valid is also a change.
    b.fail();
    await flush();
    expect(container.querySelector(".fallback")).not.toBeNull();
    b.heal();
    setMode("ok");
    await flush();
    expect(container.querySelector(".fallback")).toBeNull();
  });
});
