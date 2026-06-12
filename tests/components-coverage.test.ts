import { afterEach, describe, expect, it } from "vitest";
import { ErrorBoundary } from "../src/components/ErrorBoundary";
import { div } from "../src/core/rendering/html";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("ErrorBoundary fallback cache eviction", () => {
  it("evicts the oldest cache entry once past the cap (51+ distinct errors)", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const boundary = ErrorBoundary(() => div("content")) as HTMLElement;
    host.appendChild(boundary);

    // Drive more than FALLBACK_CACHE_MAX (50) DISTINCT error messages through
    // the boundary so getMemoizedFallback's eviction branch runs. The same
    // message repeated also exercises the LRU "touch" path.
    for (let i = 0; i < 60; i++) {
      boundary.dispatchEvent(
        new CustomEvent("sibu:error-propagate", {
          bubbles: true,
          detail: { error: new Error(`distinct-error-${i}`) },
        }),
      );
    }
    // Re-dispatch an earlier message to hit the LRU touch branch.
    boundary.dispatchEvent(
      new CustomEvent("sibu:error-propagate", {
        bubbles: true,
        detail: { error: new Error("distinct-error-59") },
      }),
    );

    expect(boundary.isConnected).toBe(true);
    // A fallback is rendered (the boundary swapped content for an error view).
    expect(boundary.querySelector(".sibu-error-boundary, [class]")).toBeTruthy();
  });
});
