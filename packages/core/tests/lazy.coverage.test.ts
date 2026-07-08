import { afterEach, describe, expect, it, vi } from "vitest";
import { dispose } from "../src/core/rendering/dispose";
import { lazy, Suspense } from "../src/core/rendering/lazy";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

afterEach(() => {
  document.body.innerHTML = "";
});

describe("lazy disposal", () => {
  it("does not render the component if disposed before the import resolves", async () => {
    let resolveImport: (m: { default: () => HTMLElement }) => void = () => {};
    const importFn = () =>
      new Promise<{ default: () => HTMLElement }>((res) => {
        resolveImport = res;
      });
    const LazyComp = lazy(importFn);
    const el = LazyComp();
    document.body.appendChild(el);

    dispose(el);
    resolveImport({
      default: () => {
        const p = document.createElement("p");
        p.textContent = "late";
        return p;
      },
    });
    await tick();
    // disposed=true short-circuits the .then, so loading text stays.
    expect(el.textContent).toContain("Loading...");
  });

  it("does not show the error UI if disposed before a rejected import settles", async () => {
    let rejectImport: (e: unknown) => void = () => {};
    const importFn = () =>
      new Promise<{ default: () => HTMLElement }>((_res, rej) => {
        rejectImport = rej;
      });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const LazyComp = lazy(importFn);
    const el = LazyComp();
    dispose(el);
    rejectImport(new Error("nope"));
    await tick();
    expect(el.querySelector(".sibu-lazy-error")).toBeNull();
    warnSpy.mockRestore();
  });

  it("coerces a non-Error rejection into an Error for the error UI", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const LazyComp = lazy(() => Promise.reject("plain string"));
    const el = LazyComp();
    await tick();
    expect(el.querySelector(".sibu-lazy-error")?.textContent).toContain("plain string");
    warnSpy.mockRestore();
  });
});

describe("Suspense with lazy children", () => {
  it("swaps in an already-loaded lazy child without an observer", async () => {
    // A .sibu-lazy element that has NO .sibu-lazy-loading marker is treated
    // as synchronously loaded — Suspense should swap immediately.
    const child = document.createElement("div");
    child.classList.add("sibu-lazy");
    child.textContent = "ready content";

    const el = Suspense({
      nodes: () => child,
      fallback: () => {
        const fb = document.createElement("div");
        fb.textContent = "Fallback";
        return fb;
      },
    });
    document.body.appendChild(el);
    await tick();
    expect(el.textContent).toContain("ready content");
    expect(el.textContent).not.toContain("Fallback");
  });

  it("observes a still-loading lazy child and swaps when loading marker is removed", async () => {
    const child = document.createElement("div");
    child.classList.add("sibu-lazy");
    const loading = document.createElement("span");
    loading.classList.add("sibu-lazy-loading");
    loading.textContent = "Loading...";
    child.appendChild(loading);

    const el = Suspense({
      nodes: () => child,
      fallback: () => {
        const fb = document.createElement("div");
        fb.textContent = "Fallback";
        return fb;
      },
    });
    document.body.appendChild(el);
    await tick();
    // Still showing fallback because the lazy child is loading.
    expect(el.textContent).toContain("Fallback");

    // Simulate the lazy component finishing: remove the loading marker.
    const loaded = document.createElement("p");
    loaded.textContent = "Now loaded";
    child.replaceChildren(loaded);

    // MutationObserver fires asynchronously.
    await new Promise((r) => setTimeout(r, 20));
    expect(el.textContent).toContain("Now loaded");
  });

  it("cleans up the observer when disposed mid-load", async () => {
    const child = document.createElement("div");
    child.classList.add("sibu-lazy");
    const loading = document.createElement("span");
    loading.classList.add("sibu-lazy-loading");
    child.appendChild(loading);

    const el = Suspense({
      nodes: () => child,
      fallback: () => {
        const fb = document.createElement("div");
        fb.textContent = "Fallback";
        return fb;
      },
    });
    document.body.appendChild(el);
    await tick();
    dispose(el);
    // Removing the marker after disposal should not throw or swap.
    child.replaceChildren(document.createElement("p"));
    await new Promise((r) => setTimeout(r, 20));
    expect(el.textContent).toContain("Fallback");
  });

  it("integrates with real lazy() output", async () => {
    const LazyChild = lazy(() =>
      Promise.resolve({
        default: () => {
          const p = document.createElement("p");
          p.textContent = "Async loaded";
          return p;
        },
      }),
    );

    const el = Suspense({
      nodes: () => LazyChild(),
      fallback: () => {
        const fb = document.createElement("div");
        fb.textContent = "Loading fallback";
        return fb;
      },
    });
    document.body.appendChild(el);
    await new Promise((r) => setTimeout(r, 30));
    expect(el.textContent).toContain("Async loaded");
  });
});
