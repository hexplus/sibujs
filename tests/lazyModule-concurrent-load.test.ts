import { describe, expect, it } from "vitest";
import { lazyModule } from "../src/plugins/modular";

// ---------------------------------------------------------------------------
// lazyModule().get() shares one in-flight load between concurrent callers.
//
// THE DEFECT: the cache was filled only after `await loader()`, so every caller
// arriving before the first load settled started another one — duplicate
// fetches and side effects, different results per caller, and a cached value
// decided by settlement order.
// ---------------------------------------------------------------------------

interface Controlled<T> {
  loader: () => Promise<T>;
  calls: () => number;
  resolve: (index: number, value: T) => void;
  reject: (index: number, error: Error) => void;
}

function controlled<T>(): Controlled<T> {
  const pending: Array<{ resolve: (v: T) => void; reject: (e: Error) => void }> = [];
  return {
    loader: () =>
      new Promise<T>((resolve, reject) => {
        pending.push({ resolve, reject });
      }),
    calls: () => pending.length,
    resolve: (i, v) => pending[i].resolve(v),
    reject: (i, e) => pending[i].reject(e),
  };
}

describe("lazyModule concurrent get()", () => {
  it("two concurrent calls invoke the loader once and see the same result", async () => {
    const c = controlled<number>();
    const mod = lazyModule(c.loader);

    const first = mod.get();
    const second = mod.get();
    expect(c.calls()).toBe(1);
    expect(mod.loaded).toBe(false);

    c.resolve(0, 1);
    expect(await first).toBe(1);
    expect(await second).toBe(1);
    expect(mod.loaded).toBe(true);
    expect(await mod.get()).toBe(1);
    expect(c.calls()).toBe(1);
  });

  it("ten concurrent calls still invoke the loader once", async () => {
    const c = controlled<string>();
    const mod = lazyModule(c.loader);

    const results = Array.from({ length: 10 }, () => mod.get());
    expect(c.calls()).toBe(1);

    c.resolve(0, "module");
    expect(await Promise.all(results)).toEqual(Array(10).fill("module"));
  });

  it("a rejected shared load clears the slot and a later call retries", async () => {
    const c = controlled<number>();
    const mod = lazyModule(c.loader);

    const a = mod.get();
    const b = mod.get();
    c.reject(0, new Error("network"));
    await expect(a).rejects.toThrow("network");
    await expect(b).rejects.toThrow("network");
    expect(mod.loaded).toBe(false);

    const retry = mod.get();
    expect(c.calls()).toBe(2);
    c.resolve(1, 7);
    expect(await retry).toBe(7);
    expect(mod.loaded).toBe(true);
  });

  it("an older rejection cannot clear a newer attempt", async () => {
    let calls = 0;
    let rejectFirst!: (e: Error) => void;
    let resolveSecond!: (v: number) => void;
    const mod = lazyModule(
      () =>
        new Promise<number>((resolve, reject) => {
          calls++;
          if (calls === 1) rejectFirst = reject;
          else resolveSecond = resolve;
        }),
    );

    const first = mod.get();
    // Let the first attempt fail, then start a second one before anything else.
    rejectFirst(new Error("first failed"));
    await expect(first).rejects.toThrow("first failed");
    const second = mod.get();
    const alsoSecond = mod.get();
    expect(calls).toBe(2);

    resolveSecond(42);
    expect(await second).toBe(42);
    expect(await alsoSecond).toBe(42);
    expect(calls).toBe(2);
  });
});
