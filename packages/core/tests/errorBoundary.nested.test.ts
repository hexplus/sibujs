import { describe, expect, it } from "vitest";
import { ErrorBoundary } from "../src/components/ErrorBoundary";

// Helper to mount and extract container
function mountComponent(component: () => HTMLElement) {
  const container = document.createElement("div");
  const el = component();
  container.appendChild(el);
  return { container, el };
}

describe("ErrorBoundary nested behavior", () => {
  it("should catch errors thrown by nested ErrorBoundary nodes", async () => {
    // Innermost component that always throws
    function BadChild(): HTMLElement {
      throw new Error("Inner failure");
    }

    // Fallbacks
    const innerFallback = () => {
      const div = document.createElement("div");
      div.textContent = "Inner Fallback";
      return div;
    };
    const outerFallback = () => {
      const div = document.createElement("div");
      div.textContent = "Outer Fallback";
      return div;
    };

    // Compose nested boundaries
    const tree = () => {
      return ErrorBoundary({ fallback: outerFallback }, () => ErrorBoundary({ fallback: innerFallback }, BadChild));
    };

    const { container } = mountComponent(tree);
    // Allow microtask-based reactive nodes to render
    await Promise.resolve();
    await Promise.resolve();
    // Expect that inner boundary caught first, so shows inner fallback
    expect(container.textContent).toContain("Inner Fallback");
  });

  it("should propagate to outer fallback if inner fallback throws", async () => {
    // Innermost component that always throws
    function BadChild(): HTMLElement {
      throw new Error("Inner failure");
    }
    // Inner fallback that also throws
    function BadFallback(): HTMLElement {
      throw new Error("Fallback failure");
    }

    const outerFallback = () => {
      const div = document.createElement("div");
      div.textContent = "Outer Only Fallback";
      return div;
    };

    const tree = () => {
      return ErrorBoundary({ fallback: outerFallback }, () => ErrorBoundary({ fallback: BadFallback }, BadChild));
    };

    const { container } = mountComponent(tree);
    // Allow microtask-based reactive nodes to render
    await Promise.resolve();
    await Promise.resolve();
    // Inner boundary fails to render fallback, outer should catch
    expect(container.textContent).toContain("Outer Only Fallback");
  });
});
