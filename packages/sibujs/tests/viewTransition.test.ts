import { afterEach, describe, expect, it, vi } from "vitest";
import { viewTransition } from "../src/ui/viewTransition";

const _tick = () => new Promise((r) => setTimeout(r, 0));

describe("viewTransition", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls callback directly when startViewTransition is not available", async () => {
    vi.stubGlobal("document", {});
    const callback = vi.fn();
    const { start, isTransitioning } = viewTransition(callback);

    expect(isTransitioning()).toBe(false);
    await start();
    expect(callback).toHaveBeenCalledOnce();
    expect(isTransitioning()).toBe(false);
  });

  it("uses document.startViewTransition when available", async () => {
    const callback = vi.fn();
    let resolveFinished: () => void;
    const finished = new Promise<void>((r) => {
      resolveFinished = r;
    });

    vi.stubGlobal("document", {
      startViewTransition: vi.fn((cb: () => void) => {
        cb();
        return { finished };
      }),
    });

    const { start, isTransitioning } = viewTransition(callback);
    const startPromise = start();
    expect(isTransitioning()).toBe(true);

    resolveFinished?.();
    await startPromise;
    expect(isTransitioning()).toBe(false);
    expect(callback).toHaveBeenCalledOnce();
  });

  it("sets isTransitioning to false even if callback throws", async () => {
    vi.stubGlobal("document", {});
    const callback = vi.fn(() => {
      throw new Error("fail");
    });
    const { start, isTransitioning } = viewTransition(callback);

    await expect(start()).rejects.toThrow("fail");
    expect(isTransitioning()).toBe(false);
  });

  it("handles async callback in fallback mode", async () => {
    vi.stubGlobal("document", {});
    const callback = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    const { start, isTransitioning } = viewTransition(callback);

    await start();
    expect(callback).toHaveBeenCalledOnce();
    expect(isTransitioning()).toBe(false);
  });
});
