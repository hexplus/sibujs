import { signal } from "@sibujs/core";
import { describe, expect, it, vi } from "vitest";
import { resource } from "../src/data/resource";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("resource", () => {
  describe("basic lifecycle", () => {
    it("starts in loading state and resolves with data", async () => {
      const res = resource(async () => "hello");

      expect(res.loading()).toBe(true);
      expect(res.data()).toBe(undefined);
      expect(res.error()).toBe(undefined);

      await tick();

      expect(res.loading()).toBe(false);
      expect(res.data()).toBe("hello");
      expect(res.error()).toBe(undefined);
    });

    it("sets error on fetch failure", async () => {
      const res = resource(
        async () => {
          throw new Error("failed");
        },
        { retry: { maxRetries: 0 } },
      );

      await tick();

      expect(res.loading()).toBe(false);
      expect(res.data()).toBe(undefined);
      expect(res.error()?.message).toBe("failed");
    });

    it("uses initialValue before first fetch", async () => {
      const res = resource(async () => "loaded", {
        initialValue: "initial",
      });

      expect(res.data()).toBe("initial");
      await tick();
      expect(res.data()).toBe("loaded");
    });

    it("does not fetch when immediate is false", async () => {
      const fn = vi.fn().mockResolvedValue("data");
      const res = resource(fn, { immediate: false });

      await tick();
      expect(fn).not.toHaveBeenCalled();
      expect(res.loading()).toBe(false);
    });
  });

  describe("refetch and mutate", () => {
    it("refetches on demand", async () => {
      let count = 0;
      const res = resource(async () => ++count);

      await tick();
      expect(res.data()).toBe(1);

      await res.refetch();
      expect(res.data()).toBe(2);
    });

    it("mutates data without refetching", async () => {
      const fn = vi.fn().mockResolvedValue("original");
      const res = resource(fn);

      await tick();
      expect(res.data()).toBe("original");

      res.mutate("modified");
      expect(res.data()).toBe("modified");
      expect(fn).toHaveBeenCalledOnce(); // no extra fetch
    });

    it("mutate accepts updater function", async () => {
      const res = resource(async () => 10);
      await tick();

      res.mutate((prev) => (prev ?? 0) + 5);
      expect(res.data()).toBe(15);
    });
  });

  describe("abort", () => {
    it("aborts the current request", async () => {
      const fn = vi.fn().mockImplementation(async ({ signal }: { signal: AbortSignal }) => {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve("data"), 1000);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      });

      const res = resource(fn);
      res.abort();
      await tick();

      // After abort, error should not be set (abort errors are silently ignored)
      expect(res.error()).toBe(undefined);
    });
  });

  describe("dispose", () => {
    it("prevents further updates after disposal", async () => {
      let resolvePromise: (v: string) => void;
      const res = resource(async () => {
        return new Promise<string>((resolve) => {
          resolvePromise = resolve;
        });
      });

      res.dispose();
      resolvePromise?.("data");
      await tick();

      expect(res.data()).toBe(undefined); // did not set
    });
  });

  describe("reactive source", () => {
    it("auto-refetches when source changes", async () => {
      const [id, setId] = signal(1);
      const fn = vi.fn().mockImplementation(async (sourceId: number) => `item-${sourceId}`);

      const res = resource(id, fn);
      await tick();
      expect(res.data()).toBe("item-1");

      setId(2);
      await tick();
      expect(res.data()).toBe("item-2");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("discards stale responses (race condition)", async () => {
      const [id, setId] = signal(1);
      const resolvers: Array<(v: string) => void> = [];

      const res = resource(id, async (_sourceId: number) => {
        return new Promise<string>((resolve) => {
          resolvers.push(resolve);
        });
      });

      // First fetch starts
      await Promise.resolve();

      // Change source before first resolves
      setId(2);
      await Promise.resolve();

      // Resolve second request first (fast), then first (slow)
      resolvers[1]("item-2");
      await tick();
      expect(res.data()).toBe("item-2");

      // Resolve first request (stale) — should be ignored
      resolvers[0]("item-1");
      await tick();
      expect(res.data()).toBe("item-2"); // still item-2
    });
  });

  describe("callbacks", () => {
    it("calls onStart, onSuccess, onSettled on success", async () => {
      const onStart = vi.fn();
      const onSuccess = vi.fn();
      const onSettled = vi.fn();

      resource(async () => "data", { onStart, onSuccess, onSettled });
      await tick();

      expect(onStart).toHaveBeenCalledOnce();
      expect(onSuccess).toHaveBeenCalledWith("data");
      expect(onSettled).toHaveBeenCalledOnce();
    });

    it("calls onStart, onError, onSettled on failure", async () => {
      const onStart = vi.fn();
      const onError = vi.fn();
      const onSettled = vi.fn();

      resource(
        async () => {
          throw new Error("err");
        },
        { onStart, onError, onSettled, retry: { maxRetries: 0 } },
      );
      await tick();

      expect(onStart).toHaveBeenCalledOnce();
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "err" }));
      expect(onSettled).toHaveBeenCalledOnce();
    });
  });

  describe("retry integration", () => {
    it("retries on failure with configured options", async () => {
      vi.useFakeTimers();
      let attempts = 0;
      const res = resource(
        async () => {
          attempts++;
          if (attempts < 3) throw new Error("fail");
          return "success";
        },
        { retry: { maxRetries: 3, baseDelay: 100, jitter: 0 } },
      );

      // First attempt fails
      await vi.advanceTimersByTimeAsync(0);
      // Retry 1 after 100ms
      await vi.advanceTimersByTimeAsync(100);
      // Retry 2 after 200ms
      await vi.advanceTimersByTimeAsync(200);

      expect(res.data()).toBe("success");
      expect(attempts).toBe(3);

      vi.useRealTimers();
    });
  });
});
