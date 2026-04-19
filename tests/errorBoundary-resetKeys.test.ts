import { describe, expect, it } from "vitest";
import { ErrorBoundary } from "../src/components/ErrorBoundary";
import { signal } from "../src/core/signals/signal";

describe("ErrorBoundary / resetKeys", () => {
  it("clears the caught error when a resetKey changes", async () => {
    const [route, setRoute] = signal("/a");
    let throwIt = true;

    const boundary = ErrorBoundary({ resetKeys: [route] }, () => {
      if (throwIt) {
        throw new Error("first render failed");
      }
      const d = document.createElement("div");
      d.textContent = "ok";
      return d;
    });

    document.body.appendChild(boundary);

    // Allow queueMicrotask-based rendering in bindChildNode to resolve
    await new Promise<void>((r) => queueMicrotask(r));

    // Boundary should be in error state
    expect(boundary.querySelector(".sibu-error-display")).not.toBeNull();

    // Flip the route — resetKeys should clear the error and the boundary re-renders
    throwIt = false;
    setRoute("/b");

    await new Promise<void>((r) => queueMicrotask(r));
    await new Promise<void>((r) => setTimeout(r, 0));

    // The error display should be gone now
    expect(boundary.querySelector(".sibu-error-display")).toBeNull();

    document.body.removeChild(boundary);
  });
});
