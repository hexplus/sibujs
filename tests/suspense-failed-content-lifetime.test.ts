import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispose, registerDisposer } from "../src/core/rendering/dispose";
import { div } from "../src/core/rendering/html";
import { Suspense as CoreSuspense } from "../src/core/rendering/lazy";
import { pendingContent } from "../src/core/rendering/pendingContent";
import { pendingCount } from "../src/core/rendering/range";
import { type LifecycleScope, lifecycleScope } from "../src/core/signals/lifecycleScope";
import { signal } from "../src/core/signals/signal";
import { Suspense as RouterSuspense } from "../src/plugins/router";
import { getSubscriberCount } from "../src/reactivity/track";
import { heldListenerCount, heldRootCount, heldSkippedCount, structuralBinding } from "../src/reactivity/track-core";

// ---------------------------------------------------------------------------
// A Suspense boundary whose content is permanently abandoned — `nodes()`
// threw or rejected, or what it built could not be inserted — ends the
// content's lifecycle then: what the content registered through a captured
// `lifecycleScope()` is disposed once, stops reacting, never catches up on a
// resume, and leaves nothing registered. The boundary itself lives on, with
// its fallback or error view, until it is disposed — which repeats nothing.
// ---------------------------------------------------------------------------

let host: HTMLElement;
let pendingBase = 0;
let listenerBase = 0;
let rootBase = 0;
let skippedBase = 0;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  pendingBase = pendingCount();
  listenerBase = heldListenerCount();
  rootBase = heldRootCount();
  skippedBase = heldSkippedCount();
});

afterEach(() => {
  dispose(host);
  host.remove();
  vi.restoreAllMocks();
});

const flush = async (turns = 8) => {
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

function subscribers(accessor: unknown): number {
  const state = (accessor as { __signal?: object }).__signal;
  return state ? getSubscriberCount(state as never) : 0;
}

/**
 * Work a content factory registers through a captured scope: an effect, a
 * watch and an owned resource on `tick`, a readiness registration and pause /
 * resume listeners.
 */
function scopedWork() {
  const [tick, setTick] = signal(0);
  const rec = {
    scope: null as LifecycleScope | null,
    effectRuns: 0,
    watchRuns: 0,
    cleanup: vi.fn(),
    paused: vi.fn(),
    resumed: vi.fn(),
  };
  const capture = (): LifecycleScope => {
    const scope = lifecycleScope();
    rec.scope = scope;
    scope.effect(() => {
      tick();
      rec.effectRuns++;
    });
    scope.watch(tick, () => {
      rec.watchRuns++;
    });
    scope.own(() => rec.cleanup);
    scope.onPause(rec.paused);
    scope.onResume(rec.resumed);
    pendingContent(scope);
    return scope;
  };
  /** Ended, reacting no more, released once, with nothing left registered. */
  const expectEnded = async () => {
    expect(rec.scope?.state()).toBe("ended");
    const effects = rec.effectRuns;
    const watches = rec.watchRuns;
    setTick((n) => n + 1);
    await flush();
    expect(rec.effectRuns).toBe(effects);
    expect(rec.watchRuns).toBe(watches);
    expect(rec.cleanup).toHaveBeenCalledTimes(1);
    expect(subscribers(tick)).toBe(0);
  };
  return { capture, rec, setTick, expectEnded };
}

/** Nothing attributable is left: readiness, lifecycle listeners, holds, skipped work. */
function expectNothingRetained() {
  expect(pendingCount()).toBe(pendingBase);
  expect(heldListenerCount()).toBe(listenerBase);
  expect(heldRootCount()).toBe(rootBase);
  expect(heldSkippedCount()).toBe(skippedBase);
}

// ---------------------------------------------------------------------------
// router Suspense
// ---------------------------------------------------------------------------

describe("router Suspense", () => {
  it("a nodes() that throws ends the content's lifecycle; the error view stays", async () => {
    const work = scopedWork();
    const anchor = RouterSuspense({
      nodes: () => {
        work.capture();
        throw new Error("bad content");
      },
    });
    host.appendChild(anchor);
    await flush();
    expect(host.querySelector(".suspense-error")?.textContent).toBe("bad content");
    expect(console.error).toHaveBeenCalledWith("[Suspense] Nodes error:", expect.any(Error));
    await work.expectEnded();
    expectNothingRetained();
    dispose(anchor);
    expect(work.rec.cleanup).toHaveBeenCalledTimes(1);
    expect(host.querySelector(".suspense-error")).toBeNull();
    expectNothingRetained();
  });

  it("an async nodes() that registers work before awaiting, then rejects, ends it", async () => {
    const work = scopedWork();
    const gate = deferred<void>();
    const anchor = RouterSuspense({
      fallback: () => div({ class: "fallback" }, "…"),
      nodes: async () => {
        work.capture();
        await gate.promise;
        throw new Error("rejected");
      },
    });
    host.appendChild(anchor);
    await flush();
    expect(host.querySelector(".fallback")).not.toBeNull();
    // Alive while the content is pending.
    work.setTick(1);
    await flush();
    expect(work.rec.scope?.state()).toBe("active");
    expect(work.rec.effectRuns).toBe(2);
    gate.resolve();
    await flush();
    expect(host.querySelector(".suspense-error")?.textContent).toBe("rejected");
    expect(host.querySelector(".fallback")).toBeNull();
    await work.expectEnded();
    expectNothingRetained();
    dispose(anchor);
    expect(work.rec.cleanup).toHaveBeenCalledTimes(1);
    expectNothingRetained();
  });

  it.each([
    ["", false],
    [" (with a registration waiting for the resume)", true],
  ])("a rejection while the branch is paused ends the content at once: nothing runs on the resume%s", async (_, waiting) => {
    const work = scopedWork();
    const gate = deferred<HTMLElement>();
    const owner = structuralBinding(() => {});
    let late = 0;
    const anchor = owner.run(() =>
      RouterSuspense({
        fallback: () => div({ class: "fallback" }, "…"),
        nodes: () => {
          work.capture();
          return gate.promise;
        },
      }),
    );
    host.appendChild(anchor);
    await flush();
    const runs = work.rec.effectRuns;
    owner.freeze?.();
    expect(work.rec.scope?.state()).toBe("paused");
    // Skipped while paused, owed a catch-up run on the resume.
    work.setTick(1);
    await flush();
    expect(work.rec.effectRuns).toBe(runs);
    expect(heldSkippedCount()).toBeGreaterThan(skippedBase);
    // A registration made while paused waits for the resume.
    if (waiting)
      work.rec.scope?.effect(() => {
        late++;
      });
    expect(late).toBe(0);
    gate.reject(new Error("rejected while paused"));
    await flush();
    // Ended now, not when the error view is shown on the resume.
    expect(work.rec.scope?.state()).toBe("ended");
    expect(work.rec.cleanup).toHaveBeenCalledTimes(1);
    expect(heldSkippedCount()).toBe(skippedBase);
    // The outcome itself waits for the resume.
    expect(host.querySelector(".suspense-error")).toBeNull();
    expect(host.querySelector(".fallback")).not.toBeNull();
    owner.thaw?.();
    await flush();
    expect(host.querySelector(".suspense-error")?.textContent).toBe("rejected while paused");
    expect(work.rec.effectRuns).toBe(runs);
    expect(late).toBe(0);
    expect(work.rec.resumed).not.toHaveBeenCalled();
    // A registration after the end never starts.
    work.rec.scope?.effect(() => {
      late++;
    });
    expect(late).toBe(0);
    await work.expectEnded();
    expectNothingRetained();
    dispose(anchor);
    owner.stop();
    expect(work.rec.cleanup).toHaveBeenCalledTimes(1);
    expectNothingRetained();
  });

  it("content whose insertion fails is released and its lifecycle ended; the error view is shown", async () => {
    const work = scopedWork();
    const contentCleanup = vi.fn();
    const anchor = RouterSuspense({
      nodes: () => {
        work.capture();
        const el = div({ class: "content" }, "content");
        registerDisposer(el, contentCleanup);
        return el;
      },
    });
    host.appendChild(anchor);
    const insertBefore = host.insertBefore.bind(host);
    let failed = false;
    vi.spyOn(host, "insertBefore").mockImplementation(<T extends Node>(node: T, child: Node | null): T => {
      if (!failed && (node as unknown as Element).classList?.contains("content")) {
        failed = true;
        throw new Error("insertion failed");
      }
      return insertBefore(node, child);
    });
    await flush();
    expect(failed).toBe(true);
    expect(host.querySelector(".content")).toBeNull();
    expect(host.querySelector(".suspense-error")?.textContent).toBe("insertion failed");
    expect(contentCleanup).toHaveBeenCalledTimes(1);
    await work.expectEnded();
    expectNothingRetained();
    dispose(anchor);
    expect(work.rec.cleanup).toHaveBeenCalledTimes(1);
    expect(contentCleanup).toHaveBeenCalledTimes(1);
    expectNothingRetained();
  });

  it("a content cleanup that disposes the boundary while the failure ends it runs once", async () => {
    const work = scopedWork();
    let anchor!: Node;
    const ownCleanup = vi.fn(() => dispose(anchor));
    anchor = RouterSuspense({
      nodes: () => {
        work.capture().own(() => ownCleanup);
        throw new Error("bad content");
      },
    });
    host.appendChild(anchor);
    await flush();
    expect(ownCleanup).toHaveBeenCalledTimes(1);
    // The boundary was torn down from inside the failure: no error view.
    expect(host.querySelector(".suspense-error")).toBeNull();
    await work.expectEnded();
    dispose(anchor);
    expect(ownCleanup).toHaveBeenCalledTimes(1);
    expect(work.rec.cleanup).toHaveBeenCalledTimes(1);
    expectNothingRetained();
  });

  it("disposing the boundary before the content settles ends it once; the late rejection repeats nothing", async () => {
    const work = scopedWork();
    const gate = deferred<HTMLElement>();
    const anchor = RouterSuspense({
      nodes: () => {
        work.capture();
        return gate.promise;
      },
    });
    host.appendChild(anchor);
    await flush();
    dispose(anchor);
    expect(work.rec.scope?.state()).toBe("ended");
    gate.reject(new Error("late"));
    await flush();
    expect(host.querySelector(".suspense-error")).toBeNull();
    await work.expectEnded();
    expectNothingRetained();
  });
});

// ---------------------------------------------------------------------------
// core Suspense
// ---------------------------------------------------------------------------

describe("core Suspense", () => {
  it("content whose insertion fails is disposed and its lifecycle ended", async () => {
    const work = scopedWork();
    const contentCleanup = vi.fn();
    const container = CoreSuspense({
      nodes: () => {
        work.capture();
        const el = div({ class: "content" }, "content");
        registerDisposer(el, contentCleanup);
        return el;
      },
      fallback: () => div({ class: "fallback" }, "…"),
    });
    host.appendChild(container);
    const replaceChildren = vi.spyOn(container, "replaceChildren").mockImplementationOnce(() => {
      throw new Error("insertion failed");
    });
    await flush();
    expect(replaceChildren).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".content")).toBeNull();
    expect(contentCleanup).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenCalled();
    await work.expectEnded();
    expectNothingRetained();
    dispose(container);
    expect(work.rec.cleanup).toHaveBeenCalledTimes(1);
    expect(contentCleanup).toHaveBeenCalledTimes(1);
    expectNothingRetained();
  });

  it("a nodes() that throws ends the content's lifecycle; the fallback stays", async () => {
    const work = scopedWork();
    const container = CoreSuspense({
      nodes: () => {
        work.capture();
        throw new Error("bad content");
      },
      fallback: () => div({ class: "fallback" }, "…"),
    });
    host.appendChild(container);
    await flush();
    expect(container.querySelector(".fallback")).not.toBeNull();
    await work.expectEnded();
    expectNothingRetained();
    dispose(container);
    expect(work.rec.cleanup).toHaveBeenCalledTimes(1);
    expectNothingRetained();
  });

  it("a content cleanup that disposes the boundary while the failed insertion ends it runs once", async () => {
    const work = scopedWork();
    let container!: HTMLElement;
    const ownCleanup = vi.fn(() => dispose(container));
    container = CoreSuspense({
      nodes: () => {
        work.capture().own(() => ownCleanup);
        return div({ class: "content" }, "content");
      },
      fallback: () => div({ class: "fallback" }, "…"),
    });
    host.appendChild(container);
    vi.spyOn(container, "replaceChildren").mockImplementationOnce(() => {
      throw new Error("insertion failed");
    });
    await flush();
    expect(ownCleanup).toHaveBeenCalledTimes(1);
    await work.expectEnded();
    dispose(container);
    expect(ownCleanup).toHaveBeenCalledTimes(1);
    expect(work.rec.cleanup).toHaveBeenCalledTimes(1);
    expectNothingRetained();
  });
});
