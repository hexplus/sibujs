import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { media } from "../src/browser/media";

describe("media", () => {
  let listeners: Map<string, (event: MediaQueryListEvent) => void>;
  let matchesMap: Map<string, boolean>;

  beforeEach(() => {
    listeners = new Map();
    matchesMap = new Map();

    vi.stubGlobal("window", {
      matchMedia: vi.fn((query: string) => {
        const matches = matchesMap.get(query) ?? false;
        const mql = {
          matches,
          media: query,
          addEventListener: vi.fn((event: string, handler: (e: MediaQueryListEvent) => void) => {
            if (event === "change") {
              listeners.set(query, handler);
            }
          }),
          removeEventListener: vi.fn(),
        };
        return mql;
      }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns false when media query does not match", () => {
    matchesMap.set("(max-width: 768px)", false);
    const { matches } = media("(max-width: 768px)");
    expect(matches()).toBe(false);
  });

  it("returns true when media query matches initially", () => {
    matchesMap.set("(min-width: 1024px)", true);
    const { matches } = media("(min-width: 1024px)");
    expect(matches()).toBe(true);
  });

  it("updates reactively when media query changes", () => {
    matchesMap.set("(max-width: 768px)", false);
    const { matches } = media("(max-width: 768px)");
    expect(matches()).toBe(false);

    // Simulate media query change
    const handler = listeners.get("(max-width: 768px)");
    expect(handler).toBeDefined();
    handler?.({ matches: true } as MediaQueryListEvent);
    expect(matches()).toBe(true);

    handler?.({ matches: false } as MediaQueryListEvent);
    expect(matches()).toBe(false);
  });

  it("returns false when window is undefined", () => {
    vi.stubGlobal("window", undefined);
    const { matches } = media("(max-width: 768px)");
    expect(matches()).toBe(false);
  });
});
