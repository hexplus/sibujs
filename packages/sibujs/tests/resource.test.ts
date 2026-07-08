import { afterEach, describe, expect, it, vi } from "vitest";
import { signal } from "@sibujs/core";
import { resource } from "../src/data/resource";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("resource", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("basic lifecycle (no source)", () => {
    it("fetches immediately and updates data/loading", async () => {
      const r = resource(async () => "hello");

      expect(r.loading()).toBe(true);
      expect(r.data()).toBe(undefined);
      expect(r.error()).toBe(undefined);

      await tick();

      expect(r.loading()).toBe(false);
      expect(r.data()).toBe("hello");
      expect(r.error()).toBe(undefined);
      r.dispose();
    });

    it("uses initialValue before the first fetch resolves", async () => {
      const r = resource(async () => "fetched", { initialValue: "initial" });

      expect(r.data()).toBe("initial");
      expect(r.loading()).toBe(true);

      await tick();
      expect(r.data()).toBe("fetched");
      r.dispose();
    });

    it("does not fetch when immediate is false", async () => {
      const fetcher = vi.fn(async () => "value");
      const r = resource(fetcher, { immediate: false });

      expect(r.loading()).toBe(false);
      expect(fetcher).not.toHaveBeenCalled();

      await tick();
      expect(fetcher).not.toHaveBeenCalled();

      await r.refetch();
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(r.data()).toBe("value");
      r.dispose();
    });

    it("passes an AbortSignal to the fetcher", async () => {
      let received: AbortSignal | undefined;
      const r = resource(async ({ signal }) => {
        received = signal;
        return "ok";
      });

      await tick();
      expect(received).toBeInstanceOf(AbortSignal);
      expect(received?.aborted).toBe(false);
      r.dispose();
    });
  });

  describe("error handling", () => {
    it("captures fetch errors and sets the error signal", async () => {
      const r = resource(
        async () => {
          throw new Error("boom");
        },
        { retry: { maxRetries: 0 } },
      );

      await tick();

      expect(r.error()?.message).toBe("boom");
      expect(r.loading()).toBe(false);
      expect(r.data()).toBe(undefined);
      r.dispose();
    });

    it("wraps non-Error throws in an Error", async () => {
      const r = resource(
        async () => {
          throw "string failure";
        },
        { retry: { maxRetries: 0 } },
      );

      await tick();
      expect(r.error()).toBeInstanceOf(Error);
      expect(r.error()?.message).toBe("string failure");
      r.dispose();
    });

    it("clears a previous error on successful refetch", async () => {
      let fail = true;
      const r = resource(
        async () => {
          if (fail) throw new Error("first");
          return "recovered";
        },
        { retry: { maxRetries: 0 } },
      );

      await tick();
      expect(r.error()?.message).toBe("first");

      fail = false;
      await r.refetch();
      expect(r.error()).toBe(undefined);
      expect(r.data()).toBe("recovered");
      r.dispose();
    });
  });

  describe("retry integration", () => {
    it("retries failed fetches and eventually succeeds", async () => {
      let calls = 0;
      const r = resource(
        async () => {
          calls++;
          if (calls < 3) throw new Error("transient");
          return "ok";
        },
        { retry: { maxRetries: 3, baseDelay: 0, jitter: 0 } },
      );

      // Allow retry loop microtasks/timers to flush (retries use setTimeout(0)).
      for (let i = 0; i < 10 && calls < 3; i++) {
        await new Promise((res) => setTimeout(res, 5));
      }

      expect(calls).toBe(3);
      expect(r.data()).toBe("ok");
      expect(r.error()).toBe(undefined);
      r.dispose();
    });
  });

  describe("lifecycle callbacks", () => {
    it("invokes onStart, onSuccess, and onSettled on success", async () => {
      const onStart = vi.fn();
      const onSuccess = vi.fn();
      const onError = vi.fn();
      const onSettled = vi.fn();

      const r = resource(async () => "done", { onStart, onSuccess, onError, onSettled });

      expect(onStart).toHaveBeenCalledTimes(1);
      await tick();

      expect(onSuccess).toHaveBeenCalledWith("done");
      expect(onSettled).toHaveBeenCalledTimes(1);
      expect(onError).not.toHaveBeenCalled();
      r.dispose();
    });

    it("invokes onError and onSettled on failure", async () => {
      const onSuccess = vi.fn();
      const onError = vi.fn();
      const onSettled = vi.fn();

      const r = resource(
        async () => {
          throw new Error("fail");
        },
        { retry: { maxRetries: 0 }, onSuccess, onError, onSettled },
      );

      await tick();

      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError.mock.calls[0][0].message).toBe("fail");
      expect(onSettled).toHaveBeenCalledTimes(1);
      expect(onSuccess).not.toHaveBeenCalled();
      r.dispose();
    });
  });

  describe("mutate", () => {
    it("mutates cached data with a direct value", async () => {
      const r = resource(async () => "server");
      await tick();

      r.mutate("local");
      expect(r.data()).toBe("local");
      r.dispose();
    });

    it("mutates cached data with an updater function receiving prev", async () => {
      const r = resource(async () => 10);
      await tick();
      expect(r.data()).toBe(10);

      r.mutate((prev) => (prev ?? 0) + 5);
      expect(r.data()).toBe(15);
      r.dispose();
    });

    it("updater receives initialValue before any fetch (immediate:false)", () => {
      const r = resource(async () => 99, { immediate: false, initialValue: 1 });
      r.mutate((prev) => (prev ?? 0) + 1);
      expect(r.data()).toBe(2);
      r.dispose();
    });
  });

  describe("source-driven refetch", () => {
    it("refetches when the reactive source changes", async () => {
      const [id, setId] = signal(1);
      const fetcher = vi.fn(async (currentId: number) => `data-${currentId}`);

      const r = resource(id, fetcher);

      await tick();
      expect(r.data()).toBe("data-1");
      expect(fetcher).toHaveBeenCalledTimes(1);

      setId(2);
      await tick();
      expect(r.data()).toBe("data-2");
      expect(fetcher).toHaveBeenCalledTimes(2);
      r.dispose();
    });

    it("passes prev value to the fetcher on subsequent fetches", async () => {
      const [id, setId] = signal(1);
      const seenPrev: unknown[] = [];
      const r = resource(id, async (currentId: number, { prev }) => {
        seenPrev.push(prev);
        return currentId * 10;
      });

      await tick();
      expect(r.data()).toBe(10);

      setId(2);
      await tick();
      expect(r.data()).toBe(20);
      // first call prev is initialValue (undefined), second is 10
      expect(seenPrev[0]).toBe(undefined);
      expect(seenPrev[1]).toBe(10);
      r.dispose();
    });
  });

  describe("stale-response / race handling", () => {
    it("ignores a stale (superseded) response", async () => {
      const [id, setId] = signal(1);
      const resolvers: Array<(v: string) => void> = [];

      const r = resource(id, (_currentId: number) => {
        return new Promise<string>((resolve) => {
          resolvers.push((v) => resolve(v));
        });
      });

      // First fetch is pending.
      await tick();
      expect(resolvers).toHaveLength(1);

      // Change source -> second fetch starts, aborts the first.
      setId(2);
      await tick();
      expect(resolvers).toHaveLength(2);

      // Resolve the FIRST (stale) request last — it must be ignored.
      resolvers[1]("second");
      await tick();
      resolvers[0]("first");
      await tick();

      expect(r.data()).toBe("second");
      r.dispose();
    });

    it("aborts the previous in-flight request when source changes", async () => {
      const [id, setId] = signal(1);
      const signals: AbortSignal[] = [];

      const r = resource(id, (_currentId: number, { signal }) => {
        signals.push(signal);
        return new Promise<string>(() => {}); // never resolves
      });

      await tick();
      setId(2);
      await tick();

      expect(signals).toHaveLength(2);
      expect(signals[0].aborted).toBe(true);
      expect(signals[1].aborted).toBe(false);
      r.dispose();
    });
  });

  describe("abort", () => {
    it("abort() aborts the in-flight request signal", async () => {
      let captured: AbortSignal | undefined;
      const r = resource(({ signal }) => {
        captured = signal;
        return new Promise<string>(() => {});
      });

      await tick();
      expect(captured?.aborted).toBe(false);

      r.abort();
      expect(captured?.aborted).toBe(true);
      r.dispose();
    });

    it("aborted fetch clears loading and does not set data or error", async () => {
      const r = resource(
        ({ signal }) => {
          return new Promise<string>((_, reject) => {
            signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
          });
        },
        { retry: { maxRetries: 0 } },
      );

      await tick();
      expect(r.loading()).toBe(true);

      r.abort();
      await tick();

      expect(r.loading()).toBe(false);
      expect(r.data()).toBe(undefined);
      expect(r.error()).toBe(undefined);
      r.dispose();
    });
  });

  describe("disposal", () => {
    it("dispose() aborts pending request and ignores its result", async () => {
      let captured: AbortSignal | undefined;
      const onSuccess = vi.fn();
      const resolvers: Array<(v: string) => void> = [];

      const r = resource(
        ({ signal }) => {
          captured = signal;
          return new Promise<string>((resolve) => resolvers.push(resolve));
        },
        { onSuccess },
      );

      await tick();
      r.dispose();
      expect(captured?.aborted).toBe(true);

      // Late resolution after dispose must be ignored.
      resolvers[0]("late");
      await tick();
      expect(onSuccess).not.toHaveBeenCalled();
      expect(r.data()).toBe(undefined);
    });

    it("dispose() stops source-driven refetches", async () => {
      const [id, setId] = signal(1);
      const fetcher = vi.fn(async (currentId: number) => `v${currentId}`);
      const r = resource(id, fetcher);

      await tick();
      expect(fetcher).toHaveBeenCalledTimes(1);

      r.dispose();
      setId(2);
      await tick();

      // No additional fetch after dispose.
      expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it("refetch after dispose is a no-op", async () => {
      const fetcher = vi.fn(async () => "x");
      const r = resource(fetcher, { immediate: false });
      r.dispose();

      await r.refetch();
      expect(fetcher).not.toHaveBeenCalled();
    });
  });
});
