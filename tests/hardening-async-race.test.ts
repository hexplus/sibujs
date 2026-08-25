import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "../src/components/ErrorBoundary";
import { dispose } from "../src/core/rendering/dispose";
import { div } from "../src/core/rendering/html";
import { lazy, Suspense } from "../src/core/rendering/lazy";
import { onCleanup } from "../src/core/rendering/lifecycle";

const tick = () => new Promise<void>((r) => queueMicrotask(() => r()));
const flush = async () => {
  for (let i = 0; i < 6; i++) await tick();
};

/** A promise whose settlement the test controls, so orderings are exact. */
function createDeferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("hardening: async completion after disposal", () => {
  let host: HTMLElement;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  it("ErrorBoundary does not attach async children into a disposed boundary", async () => {
    const deferred = createDeferred<Element>();
    const childCleanup = vi.fn();

    const boundary = ErrorBoundary(
      { fallback: () => div("failed") as unknown as Element },
      () => deferred.promise as unknown as Element,
    ) as unknown as HTMLElement;
    host.appendChild(boundary);
    await flush();

    const asyncContainer = boundary.querySelector(".sibu-error-async");
    expect(asyncContainer).not.toBeNull();

    // Tear the boundary down while the promise is still pending.
    dispose(boundary);
    boundary.remove();

    const late = div({ id: "late" }, "late") as HTMLElement;
    onCleanup(childCleanup, late);
    deferred.resolve(late);
    await flush();

    // The stale resolution must not build DOM inside the dead boundary.
    expect(asyncContainer?.contains(late)).toBe(false);
    expect(document.getElementById("late")).toBeNull();
  });

  it("ErrorBoundary does not render a fallback into a disposed boundary", async () => {
    const deferred = createDeferred<Element>();

    const boundary = ErrorBoundary(
      { fallback: () => div({ id: "fb" }, "failed") as unknown as Element },
      () => deferred.promise as unknown as Element,
    ) as unknown as HTMLElement;
    host.appendChild(boundary);
    await flush();

    const asyncContainer = boundary.querySelector(".sibu-error-async");

    dispose(boundary);
    boundary.remove();

    deferred.reject(new Error("boom"));
    await flush();

    expect(asyncContainer?.querySelector("#fb")).toBeNull();
  });

  it("does not throw an unhandled rejection when a disposed boundary's promise rejects", async () => {
    const deferred = createDeferred<Element>();
    const onUnhandled = vi.fn();
    process.on("unhandledRejection", onUnhandled);

    const boundary = ErrorBoundary(
      { fallback: () => div("failed") as unknown as Element },
      () => deferred.promise as unknown as Element,
    ) as unknown as HTMLElement;
    host.appendChild(boundary);
    await flush();

    dispose(boundary);
    deferred.reject(new Error("boom"));
    await flush();

    process.off("unhandledRejection", onUnhandled);
    expect(onUnhandled).not.toHaveBeenCalled();
  });

  it("lazy() abandoned before its import resolves never builds DOM", async () => {
    const deferred = createDeferred<{ default: () => HTMLElement }>();
    const factory = vi.fn(() => div({ id: "lazy-content" }, "content") as HTMLElement);

    const LazyThing = lazy(() => deferred.promise);
    const el = LazyThing();
    host.appendChild(el);

    dispose(el);
    el.remove();

    deferred.resolve({ default: factory });
    await flush();

    expect(factory).not.toHaveBeenCalled();
    expect(document.getElementById("lazy-content")).toBeNull();
  });

  it("Suspense disposed while pending never swaps in late content", async () => {
    const deferred = createDeferred<{ default: () => HTMLElement }>();
    const LazyThing = lazy(() => deferred.promise);

    const container = Suspense({
      nodes: () => LazyThing(),
      fallback: () => div("loading") as HTMLElement,
    });
    host.appendChild(container);
    await flush();

    dispose(container);
    container.remove();

    deferred.resolve({ default: () => div({ id: "late-content" }, "late") as HTMLElement });
    await flush();

    expect(document.getElementById("late-content")).toBeNull();
  });

  it("a stale resolution does not overwrite a newer one (latest-wins)", async () => {
    const slow = createDeferred<Element>();
    const fast = createDeferred<Element>();

    // Two independent boundaries standing in for two in-flight requests.
    const a = ErrorBoundary(
      { fallback: () => div("failed") as unknown as Element },
      () => slow.promise as unknown as Element,
    ) as unknown as HTMLElement;
    const b = ErrorBoundary(
      { fallback: () => div("failed") as unknown as Element },
      () => fast.promise as unknown as Element,
    ) as unknown as HTMLElement;
    host.append(a, b);
    await flush();

    // B (started second) settles first; A settles afterwards.
    fast.resolve(div({ id: "b-content" }, "B") as HTMLElement);
    await flush();
    slow.resolve(div({ id: "a-content" }, "A") as HTMLElement);
    await flush();

    // Each boundary commits only its own result — no cross-contamination.
    expect(a.querySelector("#a-content")).not.toBeNull();
    expect(a.querySelector("#b-content")).toBeNull();
    expect(b.querySelector("#b-content")).not.toBeNull();
    expect(b.querySelector("#a-content")).toBeNull();
  });
});
