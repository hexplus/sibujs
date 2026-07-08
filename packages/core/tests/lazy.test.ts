import { describe, expect, it } from "vitest";
import { lazy, Suspense } from "../src/core/rendering/lazy";

describe("lazy", () => {
  it("should return a function", () => {
    const LazyComp = lazy(() => Promise.resolve({ default: () => document.createElement("div") }));
    expect(typeof LazyComp).toBe("function");
  });

  it("should render a loading placeholder initially", () => {
    const LazyComp = lazy(() => new Promise(() => {})); // never resolves
    const el = LazyComp();
    expect(el.querySelector(".sibu-lazy-loading")).not.toBeNull();
    expect(el.textContent).toContain("Loading...");
  });

  it("should render resolved component after import resolves", async () => {
    const LazyComp = lazy(() =>
      Promise.resolve({
        default: () => {
          const el = document.createElement("p");
          el.textContent = "Loaded!";
          return el;
        },
      }),
    );

    const el = LazyComp();
    await new Promise((r) => setTimeout(r, 10));

    expect(el.textContent).toContain("Loaded!");
  });

  it("should cache the component after first load", async () => {
    let loadCount = 0;
    const LazyComp = lazy(() => {
      loadCount++;
      return Promise.resolve({
        default: () => document.createElement("div"),
      });
    });

    LazyComp();
    await new Promise((r) => setTimeout(r, 10));

    LazyComp(); // second call should use cache
    expect(loadCount).toBe(1);
  });

  it("should show error message on import failure", async () => {
    const LazyComp = lazy(() => Promise.reject(new Error("Network error")));
    const el = LazyComp();
    await new Promise((r) => setTimeout(r, 10));

    expect(el.querySelector(".sibu-lazy-error")).not.toBeNull();
    expect(el.textContent).toContain("Network error");
  });
});

describe("Suspense", () => {
  it("should show fallback initially", () => {
    const el = Suspense({
      nodes: () => {
        const child = document.createElement("div");
        child.classList.add("sibu-lazy");
        const loading = document.createElement("span");
        loading.classList.add("sibu-lazy-loading");
        child.appendChild(loading);
        return child;
      },
      fallback: () => {
        const fb = document.createElement("div");
        fb.textContent = "Fallback";
        return fb;
      },
    });

    expect(el.textContent).toContain("Fallback");
  });

  it("should swap to nodes when not a lazy component", async () => {
    const el = Suspense({
      nodes: () => {
        const child = document.createElement("div");
        child.textContent = "Ready";
        return child;
      },
      fallback: () => {
        const fb = document.createElement("div");
        fb.textContent = "Fallback";
        return fb;
      },
    });

    // Wait for queueMicrotask
    await new Promise((r) => setTimeout(r, 0));
    expect(el.textContent).toContain("Ready");
  });

  it("should keep fallback if nodes throws", async () => {
    const el = Suspense({
      nodes: () => {
        throw new Error("Render error");
      },
      fallback: () => {
        const fb = document.createElement("div");
        fb.textContent = "Error fallback";
        return fb;
      },
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(el.textContent).toContain("Error fallback");
  });
});
