import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { colorScheme } from "../src/browser/colorScheme";

describe("colorScheme", () => {
  let changeHandler: ((event: MediaQueryListEvent) => void) | null;
  let initialMatches: boolean;

  beforeEach(() => {
    changeHandler = null;
    initialMatches = false;

    vi.stubGlobal("window", {
      matchMedia: vi.fn((query: string) => ({
        matches: initialMatches,
        media: query,
        addEventListener: vi.fn((event: string, handler: (e: MediaQueryListEvent) => void) => {
          if (event === "change") changeHandler = handler;
        }),
        removeEventListener: vi.fn(),
      })),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns light when prefers-color-scheme is not dark", () => {
    initialMatches = false;
    const { scheme } = colorScheme();
    expect(scheme()).toBe("light");
  });

  it("returns dark when prefers-color-scheme is dark", () => {
    initialMatches = true;
    const { scheme } = colorScheme();
    expect(scheme()).toBe("dark");
  });

  it("updates reactively when color scheme preference changes", () => {
    initialMatches = false;
    const { scheme } = colorScheme();
    expect(scheme()).toBe("light");

    changeHandler?.({ matches: true } as MediaQueryListEvent);
    expect(scheme()).toBe("dark");

    changeHandler?.({ matches: false } as MediaQueryListEvent);
    expect(scheme()).toBe("light");
  });

  it("defaults to light when window is undefined", () => {
    vi.stubGlobal("window", undefined);
    const { scheme } = colorScheme();
    expect(scheme()).toBe("light");
  });
});
