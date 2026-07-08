import { afterEach, describe, expect, it, vi } from "vitest";
import { createISR } from "../src/platform/incrementalRegeneration";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("incrementalRegeneration", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("initializes with initialData when provided", () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValue("new-data");

    const isr = createISR({
      revalidateAfter: 5000,
      fetcher,
      initialData: "initial",
    });

    expect(isr.data()).toBe("initial");
    expect(isr.isStale()).toBe(false);

    isr.dispose();
  });

  it("fetches data immediately when no initialData is provided", async () => {
    const fetcher = vi.fn().mockResolvedValue("fetched-data");

    const isr = createISR({
      revalidateAfter: 5000,
      fetcher,
    });

    expect(isr.data()).toBe(undefined);
    await tick();

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(isr.data()).toBe("fetched-data");

    isr.dispose();
  });

  it("isStale returns true when revalidateAfter time has elapsed", () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValue("data");

    const isr = createISR({
      revalidateAfter: 1000,
      fetcher,
      initialData: "initial",
    });

    expect(isr.isStale()).toBe(false);

    vi.advanceTimersByTime(1000);
    expect(isr.isStale()).toBe(true);

    isr.dispose();
  });

  it("revalidate manually fetches new data", async () => {
    let callCount = 0;
    const fetcher = vi.fn().mockImplementation(async () => {
      callCount++;
      return `data-${callCount}`;
    });

    const isr = createISR({
      revalidateAfter: 60000,
      fetcher,
      initialData: "initial",
    });

    expect(isr.data()).toBe("initial");

    await isr.revalidate();
    expect(isr.data()).toBe("data-1");

    await isr.revalidate();
    expect(isr.data()).toBe("data-2");

    isr.dispose();
  });

  it("automatically revalidates after the interval", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValue("auto-revalidated");

    const isr = createISR({
      revalidateAfter: 2000,
      fetcher,
      initialData: "initial",
    });

    // No fetch should have happened yet (we had initialData)
    expect(fetcher).not.toHaveBeenCalled();

    // Advance past the revalidation interval
    vi.advanceTimersByTime(2000);

    // The interval fires and calls fetcher
    expect(fetcher).toHaveBeenCalledTimes(1);

    isr.dispose();
  });

  it("dispose stops the automatic revalidation interval", () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockResolvedValue("data");

    const isr = createISR({
      revalidateAfter: 1000,
      fetcher,
      initialData: "initial",
    });

    isr.dispose();

    vi.advanceTimersByTime(5000);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
