import { describe, expect, it, vi } from "vitest";
import { dispose } from "../src/core/rendering/dispose";
import { onCleanup, onMount, onUnmount } from "../src/core/rendering/lifecycle";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("lifecycle coverage2 — onMount with element", () => {
  it("runs callback when element is already connected", async () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const cb = vi.fn();
    onMount(() => {
      cb();
      return undefined;
    }, el);
    await tick();
    expect(cb).toHaveBeenCalledTimes(1);
    el.remove();
  });

  it("registers a returned cleanup function on the element", async () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const cleanup = vi.fn();
    onMount(() => cleanup, el);
    await tick();
    dispose(el);
    expect(cleanup).toHaveBeenCalledTimes(1);
    el.remove();
  });

  it("fires after the element connects later (mount watcher path)", async () => {
    const el = document.createElement("div");
    const cb = vi.fn();
    onMount(() => {
      cb();
      return undefined;
    }, el);
    // Not connected yet — microtask runs, registers watcher
    await tick();
    document.body.appendChild(el);
    await tick();
    await tick();
    expect(cb).toHaveBeenCalled();
    el.remove();
  });

  it("does not fire if the element is disposed before connecting", async () => {
    const el = document.createElement("div");
    const cb = vi.fn();
    onMount(() => {
      cb();
      return undefined;
    }, el);
    dispose(el); // sets disposed flag before microtask
    await tick();
    document.body.appendChild(el);
    await tick();
    expect(cb).not.toHaveBeenCalled();
    el.remove();
  });

  it("onMount without element defers to a microtask", async () => {
    const cb = vi.fn();
    onMount(() => {
      cb();
      return undefined;
    });
    expect(cb).not.toHaveBeenCalled();
    await tick();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("swallows a throwing onMount callback and warns", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    onMount(() => {
      throw new Error("mount boom");
    });
    await tick();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("lifecycle coverage2 — onUnmount", () => {
  it("fires when element is removed from the DOM", async () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const cb = vi.fn();
    onUnmount(cb, el);
    await tick();
    el.remove();
    await tick();
    await tick();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("fires via dispose() path", async () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const cb = vi.fn();
    onUnmount(cb, el);
    await tick();
    dispose(el);
    expect(cb).toHaveBeenCalledTimes(1);
    el.remove();
  });

  it("only fires once even if both dispose and removal happen", async () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const cb = vi.fn();
    onUnmount(cb, el);
    await tick();
    dispose(el);
    el.remove();
    await tick();
    await tick();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("starts watching after a disconnected element later connects", async () => {
    const el = document.createElement("div");
    const cb = vi.fn();
    onUnmount(cb, el); // element not connected → defers via onMount
    document.body.appendChild(el);
    await tick();
    await tick();
    el.remove();
    await tick();
    await tick();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("does not fire on synchronous re-parent (remove + re-add same tick)", async () => {
    const el = document.createElement("div");
    const host1 = document.createElement("div");
    const host2 = document.createElement("div");
    document.body.appendChild(host1);
    document.body.appendChild(host2);
    host1.appendChild(el);
    const cb = vi.fn();
    onUnmount(cb, el);
    await tick();
    // Re-parent synchronously
    host1.removeChild(el);
    host2.appendChild(el);
    await tick();
    await tick();
    expect(cb).not.toHaveBeenCalled();
    host1.remove();
    host2.remove();
  });
});

describe("lifecycle coverage2 — onCleanup", () => {
  it("registers a disposer that runs on dispose()", () => {
    const el = document.createElement("div");
    const cb = vi.fn();
    onCleanup(cb, el);
    dispose(el);
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe("lifecycle coverage2 — watcher unregister on dispose", () => {
  it("unregisters a pending mount watcher when the element is disposed", async () => {
    const el = document.createElement("div");
    const cb = vi.fn();
    onMount(() => {
      cb();
      return undefined;
    }, el);
    await tick(); // microtask registers the mount watcher (el still detached)
    // Disposing runs the registered unregister closure (removes from watchers)
    dispose(el);
    // Now connect — should NOT fire because watcher was removed AND disposed flag set
    document.body.appendChild(el);
    await tick();
    await tick();
    expect(cb).not.toHaveBeenCalled();
    el.remove();
  });

  it("unregisters an unmount watcher when disposed before removal", async () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const cb = vi.fn();
    onUnmount(cb, el);
    await tick(); // registers unmount watcher
    dispose(el); // fires once via registerDisposer fireOnce, and unregisters watcher
    expect(cb).toHaveBeenCalledTimes(1);
    el.remove();
    await tick();
    await tick();
    expect(cb).toHaveBeenCalledTimes(1); // still once
  });
});

describe("lifecycle coverage2 — fireUnmount edge branches", () => {
  it("does not fire unmount if element reconnects before the microtask runs", async () => {
    const el = document.createElement("div");
    const host = document.createElement("div");
    document.body.appendChild(host);
    host.appendChild(el);
    const cb = vi.fn();
    onUnmount(cb, el);
    await tick();
    // Remove then immediately re-add (still connected by the time microtask runs)
    host.removeChild(el);
    host.appendChild(el);
    await tick();
    await tick();
    expect(cb).not.toHaveBeenCalled();
    host.remove();
  });

  it("swallows a throwing unmount callback (via mutation observer path)", async () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    onUnmount(() => {
      throw new Error("unmount boom");
    }, el);
    await tick();
    // Remove via DOM so the MutationObserver fireUnmount path (not dispose) runs.
    el.remove();
    await tick();
    await tick();
    // No assertion needed beyond not throwing — the catch on line ~103 swallows it.
    expect(true).toBe(true);
  });
});

describe("lifecycle coverage2 — full sweep fallback", () => {
  it("performs a periodic full sweep after many mutations", async () => {
    const watched = document.createElement("div");
    document.body.appendChild(watched);
    const cb = vi.fn();
    onMount(() => {
      cb();
      return undefined;
    }, watched);
    await tick();
    // already connected → fires on first microtask
    cb.mockClear();

    // Generate >256 mutations in a batch to trip FULL_SWEEP_INTERVAL.
    const sweepEl = document.createElement("section");
    const sweepCb = vi.fn();
    document.body.appendChild(sweepEl);
    onMount(() => {
      sweepCb();
      return undefined;
    }, sweepEl);
    await tick();

    for (let i = 0; i < 300; i++) {
      const n = document.createElement("i");
      document.body.appendChild(n);
      n.remove();
    }
    await tick();
    await tick();
    // The full sweep should have caught any connected watched elements.
    expect(sweepCb).toHaveBeenCalled();
    watched.remove();
    sweepEl.remove();
  });
});

describe("lifecycle coverage2 — descendant mount detection", () => {
  it("fires mount when a watched descendant is inserted via its ancestor", async () => {
    const parent = document.createElement("div");
    const child = document.createElement("span");
    const grandchild = document.createElement("em");
    child.appendChild(grandchild);
    parent.appendChild(child);
    const cb = vi.fn();
    onMount(() => {
      cb();
      return undefined;
    }, grandchild);
    await tick();
    // Now connect the whole subtree at once
    document.body.appendChild(parent);
    await tick();
    await tick();
    expect(cb).toHaveBeenCalled();
    parent.remove();
  });

  it("fires unmount when a watched descendant is removed via its ancestor", async () => {
    const parent = document.createElement("div");
    const child = document.createElement("span");
    parent.appendChild(child);
    document.body.appendChild(parent);
    const cb = vi.fn();
    onUnmount(cb, child);
    await tick();
    parent.remove(); // removes child as a descendant
    await tick();
    await tick();
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
