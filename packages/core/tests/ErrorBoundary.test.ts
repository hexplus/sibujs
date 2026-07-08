import { describe, expect, it } from "vitest";
import { ErrorBoundary } from "../src/components/ErrorBoundary";
import { signal } from "../src/core/signals/signal";

describe("ErrorBoundary", () => {
  it("should render fallback when nodes throw", async () => {
    const [toggle, setToggle] = signal(false);
    const parent = document.createElement("div");

    const boundary = ErrorBoundary(
      {
        fallback: (err) => {
          const fallbackEl = document.createElement("div");
          fallbackEl.textContent = `Fallback: ${err.message}`;
          return fallbackEl;
        },
      },
      () => {
        if (toggle()) throw new Error("Oops");
        const el = document.createElement("span");
        el.textContent = "OK";
        return el;
      },
    );

    parent.appendChild(boundary);

    await Promise.resolve(); // allow initial render
    expect(parent.textContent).toBe("OK");

    setToggle(true);
    await Promise.resolve();
    await Promise.resolve(); // allow microtask and re-render

    expect(parent.textContent).toBe("Fallback: Oops");
  });
});
