import { afterEach, describe, expect, it, vi } from "vitest";
import { dispose } from "../src/core/rendering/dispose";
import { onCleanup, onMount, onUnmount } from "../src/core/rendering/lifecycle";

/** Flush pending microtasks then a macrotask, giving the MutationObserver a chance to fire. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("onMount (no element)", () => {
  it("defers the callback to a microtask", async () => {
    const order: string[] = [];
    onMount(() => {
      order.push("mount");
    });
    order.push("sync");
    expect(order).toEqual(["sync"]);
    await Promise.resolve();
    expect(order).toEqual(["sync", "mount"]);
  });

  it("swallows callback errors without throwing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    onMount(() => {
      throw new Error("mount boom");
    });
    await Promise.resolve();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("onMount (with element)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("fires when an already-connected element is passed", async () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const cb = vi.fn();
    onMount(cb, el);
    expect(cb).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("fires once the element is later inserted into the DOM", async () => {
    const el = document.createElement("div");
    const cb = vi.fn();
    onMount(cb, el);
    await Promise.resolve();
    // Not connected yet — watcher is registered but not fired.
    expect(cb).not.toHaveBeenCalled();

    document.body.appendChild(el);
    await flush();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("fires when the element is inserted as a descendant of an added subtree", async () => {
    const wrapper = document.createElement("section");
    const el = document.createElement("div");
    wrapper.appendChild(el);
    const cb = vi.fn();
    onMount(cb, el);
    await Promise.resolve();
    expect(cb).not.toHaveBeenCalled();

    document.body.appendChild(wrapper);
    await flush();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("registers a returned cleanup function as a disposer on the element", async () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const cleanup = vi.fn();
    onMount(() => cleanup, el);
    await Promise.resolve();
    expect(cleanup).not.toHaveBeenCalled();

    dispose(el);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("does not fire if the element is disposed before it ever connects", async () => {
    const el = document.createElement("div");
    const cb = vi.fn();
    onMount(cb, el);
    dispose(el);
    await Promise.resolve();
    document.body.appendChild(el);
    await flush();
    expect(cb).not.toHaveBeenCalled();
  });
});

describe("onUnmount", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("fires via dispose() for a connected element", async () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const cb = vi.fn();
    onUnmount(cb, el);
    await flush();
    expect(cb).not.toHaveBeenCalled();

    dispose(el);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("fires via a manual .remove() through the MutationObserver", async () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const cb = vi.fn();
    onUnmount(cb, el);
    await flush();

    el.remove();
    await flush();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("only fires once even if both dispose and removal happen", async () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const cb = vi.fn();
    onUnmount(cb, el);
    await flush();

    dispose(el);
    el.remove();
    await flush();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("does not fire on a synchronous re-parent (remove then re-add same tick)", async () => {
    const a = document.createElement("div");
    const b = document.createElement("div");
    document.body.appendChild(a);
    document.body.appendChild(b);
    const el = document.createElement("span");
    a.appendChild(el);
    const cb = vi.fn();
    onUnmount(cb, el);
    await flush();

    // Synchronous move: removed from a, appended to b in the same tick.
    a.removeChild(el);
    b.appendChild(el);
    await flush();
    expect(cb).not.toHaveBeenCalled();
  });

  it("waits until connection before watching for an initially-detached element", async () => {
    const el = document.createElement("div");
    const cb = vi.fn();
    onUnmount(cb, el);
    await Promise.resolve();
    // Not connected, so nothing yet.
    document.body.appendChild(el);
    await flush();
    expect(cb).not.toHaveBeenCalled();

    el.remove();
    await flush();
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe("onCleanup", () => {
  it("runs the callback when the node is disposed", () => {
    const el = document.createElement("div");
    const cb = vi.fn();
    onCleanup(cb, el);
    expect(cb).not.toHaveBeenCalled();
    dispose(el);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("runs multiple registered cleanups in registration order", () => {
    const el = document.createElement("div");
    const order: number[] = [];
    onCleanup(() => order.push(1), el);
    onCleanup(() => order.push(2), el);
    dispose(el);
    expect(order).toEqual([1, 2]);
  });

  it("disposes descendant cleanups before the parent", () => {
    const parent = document.createElement("div");
    const child = document.createElement("span");
    parent.appendChild(child);
    const order: string[] = [];
    onCleanup(() => order.push("parent"), parent);
    onCleanup(() => order.push("child"), child);
    dispose(parent);
    expect(order).toEqual(["child", "parent"]);
  });
});

describe("lifecycle ordering", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("runs onMount cleanup and onUnmount together when disposed", async () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const order: string[] = [];
    onMount(() => {
      order.push("mount");
      return () => order.push("mount-cleanup");
    }, el);
    onUnmount(() => order.push("unmount"), el);
    await flush();
    expect(order).toEqual(["mount"]);

    dispose(el);
    expect(order).toContain("mount-cleanup");
    expect(order).toContain("unmount");
  });
});
