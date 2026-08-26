import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "../src/components/ErrorBoundary";
import { setRuntimeErrorHandler } from "../src/core/errors";
import { div } from "../src/core/rendering/html";
import { signal } from "../src/core/signals/signal";
import { getSubscriberCount } from "../src/reactivity/track";

// ---------------------------------------------------------------------------
// ErrorBoundary `resetKeys` dependency semantics.
//
// THE INVARIANT UNDER TEST: reset keys are TRIGGERS. The boundary's current
// error is STATE that the watcher inspects when a trigger fires — it must never
// become a trigger of the watcher itself.
//
//   reset key changed  -> maybe retry        CORRECT
//   error changed      -> retry              WRONG
//
// Regression origin: the watcher read `error()` inside its own tracked effect,
// after the initialization guard had returned early. So the read happened for
// the first time on the first NON-initial run — i.e. the first time a reset key
// changed — and from then on the watcher was subscribed to the boundary's error
// signal. A later, unrelated failure then re-ran the watcher, which saw a
// non-null error and called retry(), clearing the failure it had just been told
// about. The boundary silently un-failed itself with no reset key involved.
// ---------------------------------------------------------------------------

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

let host: HTMLElement | null = null;

function mount(...nodes: Node[]): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  for (const n of nodes) container.appendChild(n);
  host = container;
  return container;
}

afterEach(() => {
  setRuntimeErrorHandler(null);
  host?.remove();
  host = null;
  vi.restoreAllMocks();
});

/** Boundary whose child throws on demand, with the given reset keys. */
function makeBoundary(resetKeys: Array<() => unknown>) {
  const [fail, setFail] = signal(false);
  const node = ErrorBoundary(
    {
      resetKeys,
      fallback: () => div({ class: "fallback", nodes: "failed" }),
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
  return { node, fail: () => setFail(true), heal: () => setFail(false) };
}

describe("resetKeys are triggers, not subscriptions", () => {
  it("does not reset a future error merely because a reset key changed while healthy", async () => {
    // THE REGRESSION. Steps 1-3 are benign; step 4 is where the old watcher
    // would re-run off the error signal and immediately retry itself.
    setRuntimeErrorHandler(() => {});
    const [route, setRoute] = signal("a");
    const b = makeBoundary([route]);
    const container = mount(b.node);
    await flush();

    expect(container.querySelector(".fallback")).toBeNull();

    // Reset key changes while the boundary is HEALTHY.
    setRoute("b");
    await flush();
    expect(container.querySelector(".fallback")).toBeNull();

    // A later failure, with NO further reset-key change.
    b.fail();
    await flush();

    // The boundary must stay failed.
    expect(container.querySelector(".fallback")).not.toBeNull();
  });

  it("watches reset keys only while failed, and never the error signal", async () => {
    // The watcher belongs to a failed EPISODE. Its absence while healthy is
    // what makes "changes AFTER an error has been caught" structural rather
    // than something the watcher has to reason about — and it is why the
    // watcher can never subscribe itself to the boundary's own error signal.
    setRuntimeErrorHandler(() => {});
    const [route, setRoute] = signal("a");
    const keyState = (route as unknown as { __signal: object }).__signal;
    const b = makeBoundary([route]);
    const container = mount(b.node);
    await flush();

    // Healthy: no episode, so no reset-key subscription at all.
    expect(getSubscriberCount(keyState as never)).toBe(0);

    // A key change while healthy is simply not observed.
    setRoute("b");
    await flush();
    expect(getSubscriberCount(keyState as never)).toBe(0);
    expect(container.querySelector(".fallback")).toBeNull();

    // Failing starts an episode, which subscribes to the key.
    b.fail();
    await flush();
    expect(container.querySelector(".fallback")).not.toBeNull();
    expect(getSubscriberCount(keyState as never)).toBeGreaterThan(0);

    // Recovering ends the episode and releases the subscription again.
    b.heal();
    setRoute("c");
    await flush();
    expect(container.querySelector(".fallback")).toBeNull();
    expect(getSubscriberCount(keyState as never)).toBe(0);
  });
});

describe("resetKeys semantic matrix", () => {
  it("Case A — initial mount evaluates keys without resetting", async () => {
    setRuntimeErrorHandler(() => {});
    const [route] = signal("a");
    const b = makeBoundary([route]);
    const container = mount(b.node);
    await flush();
    expect(container.querySelector(".fallback")).toBeNull();
    expect(container.querySelector(".content")).not.toBeNull();
  });

  it("Case B — key change while healthy leaves the boundary healthy", async () => {
    setRuntimeErrorHandler(() => {});
    const [route, setRoute] = signal("a");
    const b = makeBoundary([route]);
    const container = mount(b.node);
    await flush();

    setRoute("b");
    await flush();
    expect(container.querySelector(".fallback")).toBeNull();
  });

  it("Case D — key change while failed retries and recovers", async () => {
    setRuntimeErrorHandler(() => {});
    const [route, setRoute] = signal("a");
    const b = makeBoundary([route]);
    const container = mount(b.node);
    await flush();

    b.fail();
    await flush();
    expect(container.querySelector(".fallback")).not.toBeNull();

    b.heal();
    setRoute("b");
    await flush();
    expect(container.querySelector(".fallback")).toBeNull();
    expect(container.querySelector(".content")).not.toBeNull();
  });

  it("Case E — failure without any key change does not self-reset", async () => {
    setRuntimeErrorHandler(() => {});
    const [route] = signal("a");
    const b = makeBoundary([route]);
    const container = mount(b.node);
    await flush();

    b.fail();
    await flush();
    expect(container.querySelector(".fallback")).not.toBeNull();
  });

  it("Case F — a second failure persists until a NEW key change", async () => {
    setRuntimeErrorHandler(() => {});
    const [route, setRoute] = signal("a");
    const b = makeBoundary([route]);
    const container = mount(b.node);
    await flush();

    b.fail();
    await flush();
    expect(container.querySelector(".fallback")).not.toBeNull();

    b.heal();
    setRoute("b");
    await flush();
    expect(container.querySelector(".fallback")).toBeNull();

    // Fail again; no key change this time.
    b.fail();
    await flush();
    expect(container.querySelector(".fallback")).not.toBeNull();

    // Only a NEW key change recovers it.
    b.heal();
    setRoute("c");
    await flush();
    expect(container.querySelector(".fallback")).toBeNull();
  });

  it("full repeated cycle: healthy -> key -> fail -> key -> healthy -> fail stays failed", async () => {
    setRuntimeErrorHandler(() => {});
    const [route, setRoute] = signal("a");
    const b = makeBoundary([route]);
    const container = mount(b.node);
    await flush();

    setRoute("b"); // healthy key change
    await flush();
    expect(container.querySelector(".fallback")).toBeNull();

    b.fail(); // fallback shown
    await flush();
    expect(container.querySelector(".fallback")).not.toBeNull();

    b.heal();
    setRoute("c"); // key change while failed -> retry
    await flush();
    expect(container.querySelector(".fallback")).toBeNull();

    b.fail(); // second failure, no key change
    await flush();
    expect(container.querySelector(".fallback")).not.toBeNull();
  });
});

describe("multiple reset keys", () => {
  it("changing several keys while healthy does not arm auto-recovery", async () => {
    setRuntimeErrorHandler(() => {});
    const [userId, setUserId] = signal(1);
    const [route, setRoute] = signal("a");
    const [locale, setLocale] = signal("en");
    const b = makeBoundary([userId, route, locale]);
    const container = mount(b.node);
    await flush();

    setUserId(2);
    await flush();
    setRoute("b");
    await flush();
    setLocale("fr");
    await flush();
    expect(container.querySelector(".fallback")).toBeNull();

    b.fail();
    await flush();
    expect(container.querySelector(".fallback")).not.toBeNull();
  });

  it("changing any one key while failed retries", async () => {
    setRuntimeErrorHandler(() => {});
    const [userId] = signal(1);
    const [route] = signal("a");
    const [locale, setLocale] = signal("en");
    const b = makeBoundary([userId, route, locale]);
    const container = mount(b.node);
    await flush();

    b.fail();
    await flush();
    expect(container.querySelector(".fallback")).not.toBeNull();

    b.heal();
    setLocale("fr"); // only the third key moves
    await flush();
    expect(container.querySelector(".fallback")).toBeNull();
  });
});

describe("throwing reset-key getters (PR #54 behaviour preserved)", () => {
  it("still reports through the central pipeline and keeps the valid key tracked", async () => {
    const seen: Array<{ message: string; phase: string; name?: string }> = [];
    setRuntimeErrorHandler((error, context) =>
      seen.push({ message: (error as Error).message, phase: context.phase, name: context.name }),
    );

    const [route, setRoute] = signal("a");
    const b = makeBoundary([
      () => {
        throw new Error("bad reset key");
      },
      route,
    ]);
    const container = mount(b.node);
    await flush();

    // Reset keys are only consulted during a failed episode, so a broken
    // getter surfaces when the boundary actually fails — not at construction.
    expect(seen.filter((s) => s.message === "bad reset key")).toHaveLength(0);

    b.fail();
    await flush();
    expect(container.querySelector(".fallback")).not.toBeNull();

    const reports = seen.filter((s) => s.message === "bad reset key");
    expect(reports.length).toBeGreaterThan(0);
    expect(reports[0].phase).toBe("effect");
    expect(reports[0].name).toBe("ErrorBoundary.resetKeys");

    // The throwing getter must not corrupt the watcher: the valid sibling key
    // still drives recovery.
    b.heal();
    setRoute("b");
    await flush();
    expect(container.querySelector(".fallback")).toBeNull();
  });
});

describe("explicit retry remains independent of reset keys", () => {
  it("a fallback-provided retry clears the boundary with no key change", async () => {
    setRuntimeErrorHandler(() => {});
    const [route] = signal("a");
    const [fail, setFail] = signal(false);
    // Ref object rather than a bare `let`: TS narrows a closure-assigned
    // local to `never` at the call site. Matches the existing suite's style.
    const retryRef: { fn: (() => void) | null } = { fn: null };

    const node = ErrorBoundary(
      {
        resetKeys: [route],
        fallback: (_err, retry) => {
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

    // And explicit retry must not have armed the watcher either.
    setFail(true);
    await flush();
    expect(container.querySelector(".fallback")).not.toBeNull();
  });
});

describe("sibling boundary isolation", () => {
  it("a key change on A while healthy does not affect a later failure in B", async () => {
    setRuntimeErrorHandler(() => {});
    const [routeA, setRouteA] = signal("a1");
    const [routeB] = signal("b1");
    const a = makeBoundary([routeA]);
    const b = makeBoundary([routeB]);
    const container = mount(a.node, b.node);
    await flush();

    setRouteA("a2");
    await flush();

    b.fail();
    await flush();
    // B failed and stays failed; A is untouched and healthy.
    expect(container.querySelectorAll(".fallback")).toHaveLength(1);
    expect(container.querySelectorAll(".content")).toHaveLength(1);
  });

  it("A stays failed until routeA changes again", async () => {
    setRuntimeErrorHandler(() => {});
    const [routeA, setRouteA] = signal("a1");
    const [routeB, setRouteB] = signal("b1");
    const a = makeBoundary([routeA]);
    const b = makeBoundary([routeB]);
    const container = mount(a.node, b.node);
    await flush();

    setRouteA("a2");
    await flush();

    a.fail();
    await flush();
    expect(container.querySelectorAll(".fallback")).toHaveLength(1);

    // B's key moving must not recover A.
    setRouteB("b2");
    await flush();
    expect(container.querySelectorAll(".fallback")).toHaveLength(1);

    // Only A's own key recovers A.
    a.heal();
    setRouteA("a3");
    await flush();
    expect(container.querySelectorAll(".fallback")).toHaveLength(0);
  });
});

describe("disposal", () => {
  it("the reset-key watcher unsubscribes when the boundary is disposed", async () => {
    setRuntimeErrorHandler(() => {});
    const [route, setRoute] = signal("a");
    const state = (route as unknown as { __signal: object }).__signal;

    const b = makeBoundary([route]);
    const container = mount(b.node);
    await flush();

    // A watcher exists only while an episode is open, so fail first.
    b.fail();
    await flush();
    expect(getSubscriberCount(state as never)).toBeGreaterThan(0);

    const { dispose } = await import("../src/core/rendering/dispose");
    dispose(b.node);
    container.remove();

    expect(getSubscriberCount(state as never)).toBe(0);
    expect(() => setRoute("b")).not.toThrow();
  });
});
