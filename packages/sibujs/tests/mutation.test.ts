import { describe, expect, it, vi } from "vitest";
import { mutation } from "../src/data/mutation";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("mutation", () => {
  it("starts in idle state", () => {
    const m = mutation(async () => "data");
    expect(m.isIdle()).toBe(true);
    expect(m.loading()).toBe(false);
    expect(m.data()).toBe(undefined);
    expect(m.error()).toBe(undefined);
  });

  it("transitions through loading to success", async () => {
    const m = mutation(async (name: string) => `hello ${name}`);

    const promise = m.mutateAsync("world");
    expect(m.loading()).toBe(true);
    expect(m.isIdle()).toBe(false);

    const result = await promise;
    expect(result).toBe("hello world");
    expect(m.data()).toBe("hello world");
    expect(m.loading()).toBe(false);
    expect(m.isSuccess()).toBe(true);
  });

  it("handles errors", async () => {
    const m = mutation(
      async () => {
        throw new Error("fail");
      },
      { retry: { maxRetries: 0 } },
    );

    await expect(m.mutateAsync(undefined)).rejects.toThrow("fail");
    expect(m.error()?.message).toBe("fail");
    expect(m.loading()).toBe(false);
    expect(m.isSuccess()).toBe(false);
  });

  it("fire-and-forget mutate does not throw", async () => {
    const m = mutation(
      async () => {
        throw new Error("fail");
      },
      { retry: { maxRetries: 0 } },
    );

    m.mutate(undefined);
    await tick();
    expect(m.error()?.message).toBe("fail");
  });

  it("calls lifecycle callbacks on success", async () => {
    const onMutate = vi.fn().mockReturnValue("ctx");
    const onSuccess = vi.fn();
    const onSettled = vi.fn();

    const m = mutation(async (x: number) => x * 2, {
      onMutate,
      onSuccess,
      onSettled,
    });

    await m.mutateAsync(5);

    expect(onMutate).toHaveBeenCalledWith(5);
    expect(onSuccess).toHaveBeenCalledWith(10, 5, "ctx");
    expect(onSettled).toHaveBeenCalledWith(10, undefined, 5, "ctx");
  });

  it("calls lifecycle callbacks on error", async () => {
    const onMutate = vi.fn().mockReturnValue("ctx");
    const onError = vi.fn();
    const onSettled = vi.fn();

    const m = mutation(
      async () => {
        throw new Error("oops");
      },
      { onMutate, onError, onSettled, retry: { maxRetries: 0 } },
    );

    await expect(m.mutateAsync(undefined)).rejects.toThrow("oops");
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "oops" }), undefined, "ctx");
    expect(onSettled).toHaveBeenCalledWith(undefined, expect.objectContaining({ message: "oops" }), undefined, "ctx");
  });

  it("resets state", async () => {
    const m = mutation(async () => "data");
    await m.mutateAsync(undefined);
    expect(m.isSuccess()).toBe(true);
    expect(m.data()).toBe("data");

    m.reset();
    expect(m.isIdle()).toBe(true);
    expect(m.data()).toBe(undefined);
    expect(m.error()).toBe(undefined);
  });

  it("reset() aborts the in-flight mutation (signal + retry chain)", async () => {
    let seenSignal: AbortSignal | undefined;
    const m = mutation(async (_n: number, signal?: AbortSignal) => {
      seenSignal = signal;
      await new Promise((r) => setTimeout(r, 50));
      return "done";
    });

    m.mutate(0);
    await tick();
    expect(seenSignal?.aborted).toBe(false);

    m.reset();
    expect(seenSignal?.aborted).toBe(true); // request signal is aborted
    expect(m.isIdle()).toBe(true);
  });

  it("a new mutate() aborts the previous in-flight one", async () => {
    const signals: AbortSignal[] = [];
    const m = mutation(async (n: number, signal?: AbortSignal) => {
      if (signal) signals.push(signal);
      await new Promise((r) => setTimeout(r, 30));
      return n;
    });

    m.mutate(1);
    await tick();
    m.mutate(2);
    await tick();

    expect(signals[0]?.aborted).toBe(true); // first superseded
    expect(signals[1]?.aborted).toBe(false);
  });
});
