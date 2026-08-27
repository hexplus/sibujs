/**
 * Platform lifecycle certification.
 *
 * INVARIANT 1 (DOM ownership): removing a SibuJS-owned tree disposes it first.
 * Raw `replaceChildren()` detaches without teardown, leaving effects and
 * listeners alive against detached DOM.
 *
 * INVARIANT 2 (async ownership): an async completion that lands after its owner
 * was disposed must not instantiate DOM or mutate owner state.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispose, registerDisposer } from "../src/core/rendering/dispose";
import { div } from "../src/core/rendering/html";
import { createMicroApp, defineRemoteComponent } from "../src/platform/microfrontend";

describe("createMicroApp — owned tree disposal", () => {
  it("disposes the outgoing tree when a second component is mounted", () => {
    let disposedA = 0;
    const app = createMicroApp({ name: "widget" });

    const a = div("A") as HTMLElement;
    registerDisposer(a, () => {
      disposedA++;
    });

    app.mount(() => a);
    expect(disposedA).toBe(0);

    app.mount(() => div("B") as HTMLElement);
    expect(disposedA).toBe(1);
    expect(app.element.textContent).toBe("B");
  });

  it("disposes the mounted tree on unmount()", () => {
    let disposedA = 0;
    const app = createMicroApp({ name: "widget" });

    const a = div("A") as HTMLElement;
    registerDisposer(a, () => {
      disposedA++;
    });

    app.mount(() => a);
    app.unmount();

    expect(disposedA).toBe(1);
    expect(app.element.childNodes.length).toBe(0);
  });

  it("disposes exactly once across mount/mount/unmount/unmount", () => {
    let disposedA = 0;
    let disposedB = 0;
    const app = createMicroApp({ name: "widget" });

    const a = div("A") as HTMLElement;
    registerDisposer(a, () => {
      disposedA++;
    });
    const b = div("B") as HTMLElement;
    registerDisposer(b, () => {
      disposedB++;
    });

    app.mount(() => a);
    app.mount(() => b);
    app.unmount();
    app.unmount();

    expect(disposedA).toBe(1);
    expect(disposedB).toBe(1);
  });

  it("disposes a nested descendant of the outgoing tree", () => {
    let disposedChild = 0;
    const app = createMicroApp({ name: "widget" });

    const child = div("child") as HTMLElement;
    registerDisposer(child, () => {
      disposedChild++;
    });
    const parent = div({}, child) as HTMLElement;

    app.mount(() => parent);
    app.mount(() => div("next") as HTMLElement);

    expect(disposedChild).toBe(1);
  });

  it("disposes the outgoing tree inside a shadow root too", () => {
    let disposedA = 0;
    const app = createMicroApp({ name: "widget", shadow: true });

    const a = div("A") as HTMLElement;
    registerDisposer(a, () => {
      disposedA++;
    });

    app.mount(() => a);
    app.mount(() => div("B") as HTMLElement);

    expect(disposedA).toBe(1);
  });

  it("does not leave a zombie effect responding after replacement", () => {
    let fired = 0;
    const app = createMicroApp({ name: "widget" });

    const a = div("A") as HTMLElement;
    // Model a live subscription owned by the tree.
    const listeners = new Set<() => void>();
    const listener = () => {
      fired++;
    };
    listeners.add(listener);
    registerDisposer(a, () => listeners.delete(listener));

    app.mount(() => a);
    app.mount(() => div("B") as HTMLElement);

    for (const l of listeners) l();
    expect(fired).toBe(0);
  });

  it("re-mounting the same node does not double-register or leave it detached", () => {
    let disposedA = 0;
    const app = createMicroApp({ name: "widget" });

    const a = div("A") as HTMLElement;
    registerDisposer(a, () => {
      disposedA++;
    });

    app.mount(() => a);
    app.mount(() => a);

    // Re-mounting the SAME node must keep it alive and present, not dispose it.
    expect(disposedA).toBe(0);
    expect(app.element.textContent).toBe("A");
    expect(app.element.childNodes.length).toBe(1);
  });
});

describe("defineRemoteComponent — async ownership", () => {
  let deferred: { resolve: (v: unknown) => void; reject: (e: unknown) => void; promise: Promise<never> };

  beforeEach(() => {
    let resolve!: (v: unknown) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    deferred = { resolve, reject, promise: promise as Promise<never> };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not instantiate the component when the container was disposed first", async () => {
    let componentCreations = 0;

    const Remote = defineRemoteComponent("late", () => deferred.promise);
    const container = Remote();

    dispose(container);

    deferred.resolve({
      default: () => {
        componentCreations++;
        return div("remote") as HTMLElement;
      },
    });
    await deferred.promise.catch(() => {});
    await Promise.resolve();
    await Promise.resolve();

    expect(componentCreations).toBe(0);
    // …and nothing was inserted into the disposed container.
    expect(container.querySelector(".sibu-remote-error")).toBeNull();
    expect(container.textContent).toBe("Loading...");
  });

  it("still renders normally when the container is alive", async () => {
    let componentCreations = 0;

    const Remote = defineRemoteComponent("alive", () => deferred.promise);
    const container = Remote();

    deferred.resolve({
      default: () => {
        componentCreations++;
        return div("remote") as HTMLElement;
      },
    });
    await deferred.promise.catch(() => {});
    await Promise.resolve();
    await Promise.resolve();

    expect(componentCreations).toBe(1);
    expect(container.textContent).toBe("remote");
  });

  it("caches the resolved module even when the first owner died", async () => {
    let componentCreations = 0;
    const factory = () => {
      componentCreations++;
      return div("remote") as HTMLElement;
    };

    const Remote = defineRemoteComponent("cached", () => deferred.promise);
    const first = Remote();
    dispose(first);

    deferred.resolve({ default: factory });
    await deferred.promise.catch(() => {});
    await Promise.resolve();
    await Promise.resolve();

    expect(componentCreations).toBe(0);

    // A later instantiation should use the cached module synchronously.
    const second = Remote();
    expect(componentCreations).toBe(1);
    expect(second.textContent).toBe("remote");
  });

  it("renders the error fallback when the loader rejects while alive", async () => {
    const Remote = defineRemoteComponent("bad", () => deferred.promise);
    const container = Remote();

    deferred.reject(new Error("network down"));
    await deferred.promise.catch(() => {});
    await Promise.resolve();
    await Promise.resolve();

    expect(container.textContent).toContain("network down");
  });

  it("does not mutate a disposed container when the loader rejects", async () => {
    const Remote = defineRemoteComponent("bad-late", () => deferred.promise);
    const container = Remote();

    dispose(container);

    deferred.reject(new Error("network down"));
    await deferred.promise.catch(() => {});
    await Promise.resolve();
    await Promise.resolve();

    expect(container.textContent).toBe("Loading...");
  });

  it("disposes the loading placeholder when swapping in the real component", async () => {
    let placeholderDisposals = 0;

    const Remote = defineRemoteComponent("swap", () => deferred.promise);
    const container = Remote();
    const placeholder = container.firstElementChild as HTMLElement;
    registerDisposer(placeholder, () => {
      placeholderDisposals++;
    });

    deferred.resolve({ default: () => div("remote") as HTMLElement });
    await deferred.promise.catch(() => {});
    await Promise.resolve();
    await Promise.resolve();

    expect(placeholderDisposals).toBe(1);
  });
});
