import { describe, expect, it, vi } from "vitest";
import { dispose, registerDisposer } from "../src/core/rendering/dispose";
import { derived } from "../src/core/signals/derived";
import { effect } from "../src/core/signals/effect";
import { signal } from "../src/core/signals/signal";
import { store } from "../src/core/signals/store";
import { watch } from "../src/core/signals/watch";
import { batch } from "../src/reactivity/batch";

// ── Ownership model: signals outlive effects ─────────────────────────────────

describe("Ownership model", () => {
  it("signals survive after all effects are disposed", () => {
    const [count, setCount] = signal(0);
    const spy = vi.fn();

    const teardown = effect(() => spy(count()));
    expect(spy).toHaveBeenCalledTimes(1);

    teardown();
    setCount(5);
    expect(spy).toHaveBeenCalledTimes(1); // effect dead
    expect(count()).toBe(5); // signal still works
  });

  it("store survives after subscribers are disposed", () => {
    const [s, { setState }] = store({ count: 0 });
    const spy = vi.fn();

    const teardown = effect(() => spy(store.count));
    expect(spy).toHaveBeenCalledTimes(1);

    teardown();
    setState({ count: 42 });
    expect(spy).toHaveBeenCalledTimes(1); // subscriber dead
    expect(s.count).toBe(42); // store still works
  });

  it("derived values survive after downstream effects are disposed", () => {
    const [count, setCount] = signal(0);
    const doubled = derived(() => count() * 2);
    const spy = vi.fn();

    const teardown = effect(() => spy(doubled()));
    expect(spy).toHaveBeenCalledTimes(1);

    teardown();
    setCount(10);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(doubled()).toBe(20); // derived still works
  });
});

// ── Nested component disposal ────────────────────────────────────────────────

describe("Nested component disposal", () => {
  it("child disposal does not break parent signals", () => {
    const [parentCount, setParentCount] = signal(0);
    const parentSpy = vi.fn();
    const childSpy = vi.fn();

    // Parent effect
    const parentTeardown = effect(() => parentSpy(parentCount()));

    // Child effect on same signal
    const childTeardown = effect(() => childSpy(parentCount()));

    setParentCount(1);
    expect(parentSpy).toHaveBeenCalledTimes(2);
    expect(childSpy).toHaveBeenCalledTimes(2);

    // Dispose child
    childTeardown();
    setParentCount(2);
    expect(parentSpy).toHaveBeenCalledTimes(3); // parent still works
    expect(childSpy).toHaveBeenCalledTimes(2); // child stopped

    parentTeardown();
  });

  it("parent disposal does not break child signals that are still alive", () => {
    const [shared, setShared] = signal(0);
    const childSpy = vi.fn();
    const parentSpy = vi.fn();

    const parentTeardown = effect(() => parentSpy(shared()));
    const childTeardown = effect(() => childSpy(shared()));

    // Dispose parent first
    parentTeardown();
    setShared(5);
    expect(parentSpy).toHaveBeenCalledTimes(1); // parent dead
    expect(childSpy).toHaveBeenCalledTimes(2); // child still alive

    childTeardown();
  });

  it("deep nested disposal chain (3 levels)", () => {
    const [val, setVal] = signal(0);
    const spies = [vi.fn(), vi.fn(), vi.fn()];
    const teardowns = spies.map((spy) => effect(() => spy(val())));

    setVal(1);
    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(2);

    // Dispose middle
    teardowns[1]();
    setVal(2);
    expect(spies[0]).toHaveBeenCalledTimes(3);
    expect(spies[1]).toHaveBeenCalledTimes(2); // stopped
    expect(spies[2]).toHaveBeenCalledTimes(3);

    // Dispose first
    teardowns[0]();
    setVal(3);
    expect(spies[0]).toHaveBeenCalledTimes(3); // stopped
    expect(spies[2]).toHaveBeenCalledTimes(4); // still alive

    teardowns[2]();
  });
});

// ── DOM dispose() — recursive cleanup ────────────────────────────────────────

describe("DOM dispose()", () => {
  it("disposes all registered teardowns on a node", () => {
    const el = document.createElement("div");
    const spy1 = vi.fn();
    const spy2 = vi.fn();

    registerDisposer(el, spy1);
    registerDisposer(el, spy2);

    dispose(el);
    expect(spy1).toHaveBeenCalledTimes(1);
    expect(spy2).toHaveBeenCalledTimes(1);
  });

  it("disposes children depth-first", () => {
    const order: string[] = [];
    const parent = document.createElement("div");
    const child = document.createElement("span");
    const grandchild = document.createElement("b");

    child.appendChild(grandchild);
    parent.appendChild(child);

    registerDisposer(grandchild, () => order.push("grandchild"));
    registerDisposer(child, () => order.push("child"));
    registerDisposer(parent, () => order.push("parent"));

    dispose(parent);
    expect(order).toEqual(["grandchild", "child", "parent"]);
  });

  it("double dispose is safe (no-op second time)", () => {
    const el = document.createElement("div");
    const spy = vi.fn();
    registerDisposer(el, spy);

    dispose(el);
    dispose(el);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("dispose stops reactive bindings on element", () => {
    const [val, setVal] = signal("hello");
    const el = document.createElement("div");

    const teardown = effect(() => {
      el.textContent = val();
    });
    registerDisposer(el, teardown);

    expect(el.textContent).toBe("hello");
    setVal("world");
    expect(el.textContent).toBe("world");

    dispose(el);
    setVal("nope");
    expect(el.textContent).toBe("world"); // stopped
  });
});

// ── Rapid mount/unmount cycles ───────────────────────────────────────────────

describe("Rapid mount/unmount cycles", () => {
  it("100 mount/unmount cycles do not leak subscribers", () => {
    const [count, setCount] = signal(0);
    const spy = vi.fn();

    for (let i = 0; i < 100; i++) {
      const teardown = effect(() => spy(count()));
      teardown();
    }

    // All effects should be dead
    setCount(999);
    // spy was called 100 times (once per mount, initial run) but never after teardown
    expect(spy).toHaveBeenCalledTimes(100);
  });

  it("100 watch/unwatch cycles do not leak", () => {
    const [count, setCount] = signal(0);
    const spy = vi.fn();

    for (let i = 0; i < 100; i++) {
      const teardown = watch(count, (v) => spy(v));
      teardown();
    }

    setCount(999);
    expect(spy).toHaveBeenCalledTimes(0); // watchers don't fire on initial
  });

  it("interleaved mount/unmount with batch", () => {
    const [a, setA] = signal(0);
    const [b, setB] = signal(0);
    const spy = vi.fn();

    for (let i = 0; i < 50; i++) {
      const teardown = effect(() => {
        spy(a() + b());
      });

      batch(() => {
        setA(i);
        setB(i);
      });

      teardown();
    }

    // After all teardowns, no more updates
    const callCount = spy.mock.calls.length;
    batch(() => {
      setA(999);
      setB(999);
    });
    expect(spy.mock.calls.length).toBe(callCount);
  });
});

// ── Shared signals across components ─────────────────────────────────────────

describe("Shared signals (global store pattern)", () => {
  it("shared signal survives individual consumer disposal", () => {
    // Simulate a global signal used by multiple "components"
    const [theme, setTheme] = signal("light");
    const consumers: Array<() => void> = [];
    const spies: ReturnType<typeof vi.fn>[] = [];

    // Mount 5 "components" sharing the same signal
    for (let i = 0; i < 5; i++) {
      const spy = vi.fn();
      spies.push(spy);
      consumers.push(effect(() => spy(theme())));
    }

    setTheme("dark");
    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(2);

    // Dispose first 3 "components"
    consumers[0]();
    consumers[1]();
    consumers[2]();

    setTheme("auto");
    expect(spies[0]).toHaveBeenCalledTimes(2); // disposed
    expect(spies[1]).toHaveBeenCalledTimes(2); // disposed
    expect(spies[2]).toHaveBeenCalledTimes(2); // disposed
    expect(spies[3]).toHaveBeenCalledTimes(3); // still alive
    expect(spies[4]).toHaveBeenCalledTimes(3); // still alive

    // Dispose remaining
    consumers[3]();
    consumers[4]();

    // Signal still works even with zero subscribers
    setTheme("system");
    expect(theme()).toBe("system");
  });
});

// ── Conditional branches with shared state ───────────────────────────────────

describe("Conditional branches with shared state", () => {
  it("switching between branches correctly disposes old effects", () => {
    const [flag, setFlag] = signal(true);
    const [data, setData] = signal(0);

    const branchASpy = vi.fn();
    const branchBSpy = vi.fn();

    let currentTeardown: (() => void) | null = null;

    // Simulate conditional rendering
    function renderBranch() {
      if (currentTeardown) currentTeardown();

      if (flag()) {
        currentTeardown = effect(() => branchASpy(data()));
      } else {
        currentTeardown = effect(() => branchBSpy(data()));
      }
    }

    renderBranch(); // branch A
    setData(1);
    expect(branchASpy).toHaveBeenCalledTimes(2);
    expect(branchBSpy).toHaveBeenCalledTimes(0);

    // Switch to branch B
    setFlag(false);
    renderBranch();
    setData(2);
    expect(branchASpy).toHaveBeenCalledTimes(2); // disposed
    expect(branchBSpy).toHaveBeenCalledTimes(2);

    // Switch back to A
    setFlag(true);
    renderBranch();
    setData(3);
    expect(branchASpy).toHaveBeenCalledTimes(4); // 2 old + 1 new mount + 1 update
    expect(branchBSpy).toHaveBeenCalledTimes(2); // disposed

    if (currentTeardown) currentTeardown();
  });
});

// ── Computed chain disposal ──────────────────────────────────────────────────

describe("Computed chain disposal", () => {
  it("disposing an effect at the end of a computed chain stops the whole chain from running", () => {
    const [a, setA] = signal(1);
    const b = derived(() => a() * 2);
    const c = derived(() => b() + 1);
    const spy = vi.fn();

    const teardown = effect(() => spy(c()));
    expect(spy).toHaveBeenCalledWith(3); // 1*2+1

    setA(5);
    expect(spy).toHaveBeenCalledWith(11); // 5*2+1

    teardown();
    setA(10);
    expect(spy).toHaveBeenCalledTimes(2); // no more calls

    // But derived values are still readable (lazy)
    expect(c()).toBe(21);
  });
});
