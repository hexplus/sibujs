import { afterEach, describe, expect, it, vi } from "vitest";
import { reducedMotion } from "../src/ui/reducedMotion";

describe("reducedMotion", () => {
  let changeHandler: ((event: MediaQueryListEvent) => void) | null = null;

  afterEach(() => {
    vi.unstubAllGlobals();
    changeHandler = null;
  });

  it("returns false when window is undefined", () => {
    vi.stubGlobal("window", undefined);
    const { reduced } = reducedMotion();
    expect(reduced()).toBe(false);
  });

  it("returns true when prefers-reduced-motion matches", () => {
    vi.stubGlobal("window", {
      matchMedia: vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });

    const { reduced } = reducedMotion();
    expect(reduced()).toBe(true);
  });

  it("returns false when prefers-reduced-motion does not match", () => {
    vi.stubGlobal("window", {
      matchMedia: vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });

    const { reduced } = reducedMotion();
    expect(reduced()).toBe(false);
  });

  it("reactively updates when preference changes", () => {
    vi.stubGlobal("window", {
      matchMedia: vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn((_event: string, handler: (e: MediaQueryListEvent) => void) => {
          changeHandler = handler;
        }),
        removeEventListener: vi.fn(),
      })),
    });

    const { reduced } = reducedMotion();
    expect(reduced()).toBe(false);

    changeHandler?.({ matches: true } as MediaQueryListEvent);
    expect(reduced()).toBe(true);

    changeHandler?.({ matches: false } as MediaQueryListEvent);
    expect(reduced()).toBe(false);
  });
});
