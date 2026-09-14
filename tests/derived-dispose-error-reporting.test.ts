import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "../src/components/ErrorBoundary";
import { type RuntimeErrorContext, setRuntimeErrorHandler } from "../src/core/errors";
import { div } from "../src/core/rendering/html";
import { type DerivedAccessor, derived } from "../src/core/signals/derived";
import { effect } from "../src/core/signals/effect";
import { signal } from "../src/core/signals/signal";
import { getSubscriberCount } from "../src/devtools/introspect";

// A getter that disposes its own derived and then throws must not lose the
// exception. Once disposed, no later read can recompute and rethrow it, so the
// failure is kept pending and thrown to the NEXT reader — the consuming
// binding or effect, or a direct caller. The reader's own error handling then
// applies: a binding reports with its node, so the nearest ErrorBoundary gets
// first refusal; a direct caller can catch it.

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

const reports: Array<{ error: unknown; context: RuntimeErrorContext }> = [];
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
  reports.length = 0;
  host?.remove();
  host = null;
  vi.restoreAllMocks();
});

const recordReports = () => setRuntimeErrorHandler((error, context) => reports.push({ error, context }));

function selfDisposingThrower() {
  const [source, setSource] = signal(1);
  let armed = false;
  let runs = 0;
  const boom = new Error("boom");
  const value: DerivedAccessor<number> = derived(() => {
    runs++;
    const next = source();
    if (armed) {
      value.dispose();
      throw boom;
    }
    return next;
  });
  return {
    source,
    setSource,
    value,
    boom,
    runs: () => runs,
    arm: () => {
      armed = true;
    },
  };
}

describe("a derived that disposes itself and then throws", () => {
  it("is claimed by the ErrorBoundary around the binding that consumes it", async () => {
    const handler = vi.fn();
    setRuntimeErrorHandler(handler);
    const t = selfDisposingThrower();

    const boundary = ErrorBoundary({ fallback: () => div({ class: "fallback" }, "caught") }, () =>
      div({ class: "content" }, [() => `value ${t.value()}`]),
    );
    const container = mount(boundary);
    await flush();
    expect(container.querySelector(".content")?.textContent).toBe("value 1");

    t.arm();
    t.setSource(2);
    await flush();

    expect(container.querySelector(".fallback")?.textContent).toBe("caught");
    expect(handler).not.toHaveBeenCalled();
    expect(getSubscriberCount(t.source)).toBe(0);
  });

  it("is reported once, by the consuming binding with its node, when no boundary claims it", () => {
    recordReports();
    const t = selfDisposingThrower();
    const el = div({ "data-value": () => String(t.value()) });
    mount(el);

    t.arm();
    t.setSource(2);

    expect(reports).toHaveLength(1);
    expect(reports[0].error).toBe(t.boom);
    expect(reports[0].context.phase).toBe("binding");
    expect(reports[0].context.node).toBe(el);
    // The failed commit leaves the attribute at its last value.
    expect(el.getAttribute("data-value")).toBe("1");

    t.setSource(3);
    expect(reports).toHaveLength(1);
  });

  it("is reported once, by the consuming effect, and never again", () => {
    recordReports();
    const t = selfDisposingThrower();
    const seen: number[] = [];
    const stop = effect(() => {
      seen.push(t.value());
    });

    t.arm();
    t.setSource(2);

    expect(reports).toHaveLength(1);
    expect(reports[0].error).toBe(t.boom);
    expect(reports[0].context.phase).toBe("effect");
    expect(seen).toEqual([1]);

    // Frozen, released, and inert from here on.
    expect(t.value()).toBe(1);
    expect(getSubscriberCount(t.source)).toBe(0);
    const runsAfter = t.runs();
    t.setSource(3);
    expect(t.value()).toBe(1);
    expect(t.runs()).toBe(runsAfter);
    expect(reports).toHaveLength(1);
    stop();
  });

  it("throws to a direct reader exactly once, then returns the frozen value", () => {
    recordReports();
    const t = selfDisposingThrower();
    t.arm();
    t.setSource(2);

    expect(() => t.value()).toThrow(t.boom);
    expect(t.value()).toBe(1);
    expect(t.value()).toBe(1);
    expect(reports).toHaveLength(0);
    expect(getSubscriberCount(t.source)).toBe(0);
  });

  it("stays pending until read when the failure happens during a scheduler validation", () => {
    recordReports();
    const t = selfDisposingThrower();
    let reads = 0;
    const stop = effect(() => {
      reads++;
      // Reads the derived only on the first run; a later run skips it.
      if (reads === 1) t.value();
    });

    t.arm();
    t.setSource(2);
    // The effect ran again without reading, so nothing has surfaced yet.
    expect(reports).toHaveLength(0);

    expect(() => t.value()).toThrow(t.boom);
    expect(t.value()).toBe(1);
    stop();
  });
});

describe("a derived that throws without disposing itself", () => {
  it("still throws to its reader and stays live", () => {
    recordReports();
    const [source, setSource] = signal(1);
    let fail = false;
    const value = derived(() => {
      const next = source();
      if (fail) throw new Error("transient");
      return next;
    });
    expect(value()).toBe(1);

    fail = true;
    setSource(2);
    expect(() => value()).toThrow("transient");
    expect(() => value()).toThrow("transient");
    expect(reports).toHaveLength(0);

    fail = false;
    setSource(3);
    expect(value()).toBe(3);
    expect(getSubscriberCount(source)).toBe(1);
    value.dispose();
    expect(getSubscriberCount(source)).toBe(0);
  });
});

describe("a pending failure propagates through derived chains", () => {
  function chain(levels: number) {
    const t = selfDisposingThrower();
    let top: DerivedAccessor<number> = t.value;
    for (let i = 0; i < levels; i++) {
      const below = top;
      top = derived(() => below() * 2);
    }
    return { ...t, top };
  }

  it("signal → self-disposing derived → derived → effect: the effect reports it once", () => {
    recordReports();
    const t = chain(1);
    const seen: number[] = [];
    const stop = effect(() => {
      seen.push(t.top());
    });

    t.arm();
    t.setSource(2);

    expect(reports).toHaveLength(1);
    expect(reports[0].error).toBe(t.boom);
    expect(reports[0].context.phase).toBe("effect");
    expect(seen).toEqual([2]);

    // The chain recovers onto the frozen value and reports nothing further.
    expect(t.top()).toBe(2);
    expect(getSubscriberCount(t.source)).toBe(0);
    t.setSource(3);
    expect(t.top()).toBe(2);
    expect(reports).toHaveLength(1);
    stop();
  });

  it("the same chain consumed by a binding inside ErrorBoundary is claimed by the boundary", async () => {
    const handler = vi.fn();
    setRuntimeErrorHandler(handler);
    const t = chain(1);

    const boundary = ErrorBoundary({ fallback: () => div({ class: "fallback" }, "caught") }, () =>
      div({ class: "content" }, [() => `value ${t.top()}`]),
    );
    const container = mount(boundary);
    await flush();
    expect(container.querySelector(".content")?.textContent).toBe("value 2");

    t.arm();
    t.setSource(2);
    await flush();

    expect(container.querySelector(".fallback")?.textContent).toBe("caught");
    expect(handler).not.toHaveBeenCalled();
  });

  it("a multi-level chain delivers it to the effect, the boundary, or a direct reader", async () => {
    recordReports();
    const viaEffect = chain(4);
    const stop = effect(() => {
      viaEffect.top();
    });
    viaEffect.arm();
    viaEffect.setSource(2);
    expect(reports).toHaveLength(1);
    expect(reports[0].error).toBe(viaEffect.boom);
    expect(viaEffect.top()).toBe(16);
    stop();

    const handler = vi.fn();
    setRuntimeErrorHandler(handler);
    const viaBoundary = chain(4);
    const boundary = ErrorBoundary({ fallback: () => div({ class: "fallback" }, "caught") }, () =>
      div({ class: "content" }, [() => String(viaBoundary.top())]),
    );
    const container = mount(boundary);
    await flush();
    viaBoundary.arm();
    viaBoundary.setSource(2);
    await flush();
    expect(container.querySelector(".fallback")?.textContent).toBe("caught");
    expect(handler).not.toHaveBeenCalled();

    const direct = chain(4);
    direct.top();
    direct.arm();
    direct.setSource(2);
    expect(() => direct.top()).toThrow(direct.boom);
    expect(direct.top()).toBe(16);
  });

  it("a live throwing derived inside a chain still reaches the effect on every failure", () => {
    recordReports();
    const [source, setSource] = signal(1);
    let fail = false;
    const inner = derived(() => {
      const next = source();
      if (fail) throw new Error("transient");
      return next;
    });
    const outer = derived(() => inner() * 2);
    const stop = effect(() => {
      outer();
    });

    fail = true;
    setSource(2);
    expect(reports).toHaveLength(1);
    expect(reports[0].context.phase).toBe("effect");
    expect(() => outer()).toThrow("transient");

    fail = false;
    expect(outer()).toBe(4);
    stop();
  });
});
