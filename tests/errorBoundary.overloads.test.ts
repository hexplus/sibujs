import { describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "../src/components/ErrorBoundary";
import { signal } from "../src/core/signals/signal";

describe("ErrorBoundary / positional overloads", () => {
  it("accepts a single children argument (no options)", async () => {
    const boundary = ErrorBoundary(() => {
      const el = document.createElement("span");
      el.textContent = "hello";
      return el;
    });

    document.body.appendChild(boundary);
    await Promise.resolve();
    await Promise.resolve();

    expect(boundary.textContent).toContain("hello");
    boundary.remove();
  });

  it("renders the default ErrorDisplay fallback when children throw and no fallback is provided", async () => {
    const boundary = ErrorBoundary(() => {
      throw new Error("default fallback path");
    });

    document.body.appendChild(boundary);
    await new Promise<void>((r) => queueMicrotask(r));
    await new Promise<void>((r) => queueMicrotask(r));

    // Default fallback delegates to ErrorDisplay, which applies this class.
    expect(boundary.querySelector(".sibu-error-display")).not.toBeNull();
    expect(boundary.textContent).toContain("default fallback path");
    boundary.remove();
  });

  it("routes options and children correctly when both are passed", async () => {
    const onError = vi.fn();
    const boundary = ErrorBoundary(
      {
        fallback: (err) => {
          const d = document.createElement("div");
          d.textContent = `caught: ${err.message}`;
          return d;
        },
        onError,
      },
      () => {
        throw new Error("two-arg form");
      },
    );

    document.body.appendChild(boundary);
    await new Promise<void>((r) => queueMicrotask(r));
    await new Promise<void>((r) => queueMicrotask(r));

    expect(boundary.textContent).toContain("caught: two-arg form");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
    expect((onError.mock.calls[0][0] as Error).message).toBe("two-arg form");
    boundary.remove();
  });

  it("does not misinterpret a function options argument — function is always the children slot", async () => {
    // Passing a function alone must be treated as children, not as an options bag.
    // If the overload mis-dispatched, `children` would be undefined and calling it
    // inside the boundary would throw "children is not a function".
    const boundary = ErrorBoundary(() => {
      const el = document.createElement("em");
      el.textContent = "ok";
      return el;
    });

    document.body.appendChild(boundary);
    await Promise.resolve();
    await Promise.resolve();

    expect(boundary.textContent).toBe("ok");
    expect(boundary.querySelector(".sibu-error-display")).toBeNull();
    boundary.remove();
  });

  it("accepts an empty options object with explicit children", async () => {
    const boundary = ErrorBoundary({}, () => {
      const el = document.createElement("strong");
      el.textContent = "empty-opts";
      return el;
    });

    document.body.appendChild(boundary);
    await Promise.resolve();
    await Promise.resolve();

    expect(boundary.textContent).toBe("empty-opts");
    boundary.remove();
  });

  it("resetKeys still works through the new overload", async () => {
    const [route, setRoute] = signal("/a");
    let throwIt = true;

    const boundary = ErrorBoundary({ resetKeys: [route] }, () => {
      if (throwIt) throw new Error("first render failed");
      const d = document.createElement("div");
      d.textContent = "ok";
      return d;
    });

    document.body.appendChild(boundary);
    await new Promise<void>((r) => queueMicrotask(r));

    expect(boundary.querySelector(".sibu-error-display")).not.toBeNull();

    throwIt = false;
    setRoute("/b");
    await new Promise<void>((r) => queueMicrotask(r));
    await new Promise<void>((r) => queueMicrotask(r));

    expect(boundary.textContent).toContain("ok");
    boundary.remove();
  });

  it("nests cleanly with the positional form", async () => {
    function BadChild(): HTMLElement {
      throw new Error("inner boom");
    }

    const innerFallback = () => {
      const d = document.createElement("div");
      d.textContent = "Inner caught";
      return d;
    };
    const outerFallback = () => {
      const d = document.createElement("div");
      d.textContent = "Outer caught";
      return d;
    };

    const boundary = ErrorBoundary({ fallback: outerFallback }, () =>
      ErrorBoundary({ fallback: innerFallback }, BadChild),
    );

    document.body.appendChild(boundary);
    await Promise.resolve();
    await Promise.resolve();

    expect(boundary.textContent).toContain("Inner caught");
    expect(boundary.textContent).not.toContain("Outer caught");
    boundary.remove();
  });
});
