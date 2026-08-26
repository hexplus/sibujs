/**
 * Router-plugin `Suspense()` async-ownership and lifecycle-disposal suite.
 *
 * This targets the `Suspense` exported from `src/plugins/router.ts` specifically.
 * Other SibuJS Suspense implementations (SSR streaming, islands) have their own
 * lifecycle and are covered elsewhere — do not conflate them.
 *
 * Invariants under test:
 *  - A Suspense boundary owns every node it creates or installs. A node that
 *    leaves the boundary is lifecycle-disposed exactly once — native detachment
 *    alone is not cleanup.
 *  - Async completion grants no commit permission. A generation that is stale, or
 *    whose boundary was torn down, may never insert into the DOM, and any
 *    SibuJS-owned node it produced must be disposed instead of dropped.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispose, registerDisposer } from "../src/core/rendering/dispose";
import { effect } from "../src/core/signals/effect";
import { signal } from "../src/core/signals/signal";
import { Suspense } from "../src/plugins/router";

const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

/** Observable lifecycle resources: an effect, a listener and a disposer. */
interface Probe {
  el: HTMLElement;
  /** Times the registered disposer ran. */
  disposed: number;
  /** Effect re-runs observed. Frozen once the effect is torn down. */
  effectRuns: number;
  /** Listener invocations observed. */
  listenerCalls: number;
  /** Poke the signal the effect depends on. */
  bump: () => void;
  /** Dispatch a click at the probe element. */
  click: () => void;
}

function makeProbe(name: string): Probe {
  const el = document.createElement("div");
  el.textContent = name;
  const [count, setCount] = signal(0);

  const probe: Probe = {
    el,
    disposed: 0,
    effectRuns: 0,
    listenerCalls: 0,
    bump: () => {
      setCount(count() + 1);
    },
    click: () => el.dispatchEvent(new MouseEvent("click", { bubbles: true })),
  };

  const stopEffect = effect(() => {
    count();
    probe.effectRuns++;
  });
  const onClick = () => {
    probe.listenerCalls++;
  };
  el.addEventListener("click", onClick);

  registerDisposer(el, () => {
    probe.disposed++;
    stopEffect();
    el.removeEventListener("click", onClick);
  });

  return probe;
}

describe("router Suspense: lifecycle ownership", () => {
  let host: HTMLElement;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    host.remove();
    vi.restoreAllMocks();
  });

  it("mounts the fallback while content is pending", async () => {
    const fallback = makeProbe("loading");
    let resolveContent!: (el: HTMLElement) => void;
    const pending = new Promise<HTMLElement>((r) => {
      resolveContent = r;
    });

    host.appendChild(Suspense({ fallback: () => fallback.el, nodes: () => pending }));
    await settle();

    expect(host.contains(fallback.el)).toBe(true);
    expect(fallback.disposed).toBe(0);

    resolveContent(document.createElement("span"));
    await settle();
  });

  // SUS-001
  it("lifecycle-disposes the fallback when content resolves", async () => {
    const fallback = makeProbe("loading");
    const content = makeProbe("content");
    let resolveContent!: (el: HTMLElement) => void;
    const pending = new Promise<HTMLElement>((r) => {
      resolveContent = r;
    });

    host.appendChild(Suspense({ fallback: () => fallback.el, nodes: () => pending }));
    await settle();
    expect(host.contains(fallback.el)).toBe(true);

    const runsBefore = fallback.effectRuns;
    resolveContent(content.el);
    await settle();

    // Content committed, fallback gone from the DOM.
    expect(host.contains(content.el)).toBe(true);
    expect(host.contains(fallback.el)).toBe(false);

    // …and the fallback's lifecycle resources are actually torn down, not just
    // detached. Detachment alone leaves a live effect and a live listener.
    expect(fallback.disposed).toBe(1);
    fallback.bump();
    expect(fallback.effectRuns).toBe(runsBefore);
    fallback.click();
    expect(fallback.listenerCalls).toBe(0);

    // The committed content is still live while the boundary owns it.
    expect(content.disposed).toBe(0);
  });

  // SUS-001
  it("disposes committed content exactly once when the boundary is torn down", async () => {
    const content = makeProbe("content");
    const anchor = Suspense({ nodes: () => Promise.resolve(content.el) });
    host.appendChild(anchor);
    await settle();

    expect(host.contains(content.el)).toBe(true);
    expect(content.disposed).toBe(0);

    dispose(anchor);
    anchor.parentNode?.removeChild(anchor);

    expect(content.disposed).toBe(1);
    content.bump();
    content.click();
    expect(content.listenerCalls).toBe(0);
  });

  // SUS-002
  it("disposes the fallback and never commits when torn down while pending", async () => {
    const fallback = makeProbe("loading");
    const content = makeProbe("late-content");
    let resolveContent!: (el: HTMLElement) => void;
    const pending = new Promise<HTMLElement>((r) => {
      resolveContent = r;
    });

    const anchor = Suspense({ fallback: () => fallback.el, nodes: () => pending });
    host.appendChild(anchor);
    await settle();
    expect(host.contains(fallback.el)).toBe(true);

    // Boundary torn down while the content is still in flight.
    dispose(anchor);
    anchor.parentNode?.removeChild(anchor);

    expect(fallback.disposed).toBe(1);
    expect(host.contains(fallback.el)).toBe(false);

    // The pending continuation resolves afterwards. It has permanently lost
    // commit permission.
    resolveContent(content.el);
    await settle();

    expect(host.contains(content.el)).toBe(false);
    expect(host.contains(fallback.el)).toBe(false);
    expect(host.childNodes.length).toBe(0);
    // No fallback resurrection, no double cleanup.
    expect(fallback.disposed).toBe(1);
  });

  // SUS-002 — the important distinction: the Promise resolves with an *already
  // constructed* Element whose effects/listeners were created before Suspense
  // discovered it lost ownership. Dropping the reference leaks them.
  it("disposes a resolved Element that arrives after the boundary lost ownership", async () => {
    const fallback = makeProbe("loading");
    let resolveContent!: (el: HTMLElement) => void;
    const pending = new Promise<HTMLElement>((r) => {
      resolveContent = r;
    });

    const anchor = Suspense({ fallback: () => fallback.el, nodes: () => pending });
    host.appendChild(anchor);
    await settle();

    dispose(anchor);
    anchor.parentNode?.removeChild(anchor);

    // Component work happens *after* teardown — the Element and its lifecycle
    // resources exist by the time Suspense sees them.
    const late = makeProbe("late");
    const runsBefore = late.effectRuns;
    resolveContent(late.el);
    await settle();

    expect(host.contains(late.el)).toBe(false);
    expect(late.disposed).toBe(1);
    late.bump();
    expect(late.effectRuns).toBe(runsBefore);
    late.click();
    expect(late.listenerCalls).toBe(0);
  });

  it("does not resurrect the DOM when the anchor is detached without disposal", async () => {
    const content = makeProbe("content");
    let resolveContent!: (el: HTMLElement) => void;
    const pending = new Promise<HTMLElement>((r) => {
      resolveContent = r;
    });

    const anchor = Suspense({ nodes: () => pending });
    host.appendChild(anchor);
    await settle();

    // Plain detachment (no dispose) — e.g. an ancestor replaced natively.
    anchor.parentNode?.removeChild(anchor);

    resolveContent(content.el);
    await settle();

    expect(host.childNodes.length).toBe(0);
    expect(content.el.parentNode).toBe(null);
  });

  it("keeps the boundary lifecycle-safe when the promise rejects", async () => {
    const fallback = makeProbe("loading");
    const anchor = Suspense({
      fallback: () => fallback.el,
      nodes: () => Promise.reject(new Error("boom")),
    });
    host.appendChild(anchor);
    await settle();

    // Documented behaviour: the fallback is removed and an error node replaces it.
    expect(host.contains(fallback.el)).toBe(false);
    expect(fallback.disposed).toBe(1);
    expect(host.querySelector(".suspense-error")?.textContent).toBe("boom");
    expect(errorSpy).toHaveBeenCalled();

    // Tearing down afterwards must not throw or leave the error node behind.
    dispose(anchor);
    anchor.parentNode?.removeChild(anchor);
    expect(host.querySelector(".suspense-error")).toBe(null);
    expect(fallback.disposed).toBe(1);
  });

  it("produces no unhandled rejection when the boundary is torn down before rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (e: PromiseRejectionEvent) => {
      unhandled.push(e.reason);
      e.preventDefault();
    };
    // Node surfaces these on `process`; jsdom on `window`. Cover both.
    const onProcess = (reason: unknown) => unhandled.push(reason);
    window.addEventListener("unhandledrejection", onUnhandled as EventListener);
    process.on("unhandledRejection", onProcess);

    try {
      let rejectContent!: (err: Error) => void;
      const pending = new Promise<HTMLElement>((_, rej) => {
        rejectContent = rej;
      });
      const anchor = Suspense({ nodes: () => pending });
      host.appendChild(anchor);
      await settle();

      dispose(anchor);
      anchor.parentNode?.removeChild(anchor);

      rejectContent(new Error("late failure"));
      await settle();
      await new Promise((r) => setTimeout(r, 10));

      expect(unhandled).toEqual([]);
    } finally {
      window.removeEventListener("unhandledrejection", onUnhandled as EventListener);
      process.off("unhandledRejection", onProcess);
    }
  });

  it("does not leak across repeated create → resolve → dispose cycles", async () => {
    const probes: Probe[] = [];

    for (let i = 0; i < 200; i++) {
      const fallback = makeProbe(`f${i}`);
      const content = makeProbe(`c${i}`);
      probes.push(fallback, content);

      let resolveContent!: (el: HTMLElement) => void;
      const pending = new Promise<HTMLElement>((r) => {
        resolveContent = r;
      });

      const anchor = Suspense({ fallback: () => fallback.el, nodes: () => pending });
      host.appendChild(anchor);
      await settle();
      resolveContent(content.el);
      await settle();

      dispose(anchor);
      anchor.parentNode?.removeChild(anchor);
    }

    // Every probe created over the run is disposed exactly once, and the host
    // holds no residual DOM.
    expect(probes.every((p) => p.disposed === 1)).toBe(true);
    expect(host.childNodes.length).toBe(0);
  });
});
