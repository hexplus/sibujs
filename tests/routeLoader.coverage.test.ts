import { afterEach, describe, expect, it, vi } from "vitest";
import { executeLoader, loaderData, preloadRoute } from "../src/data/routeLoader";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("routeLoader (coverage)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("executeLoader", () => {
    it("creates a reactive resource that resolves loader data", async () => {
      const loader = vi.fn().mockResolvedValue({ items: [1, 2, 3] });
      const res = executeLoader(loader, { params: {}, path: "/list" });

      expect(res.loading()).toBe(true);
      await tick();

      expect(res.data()).toEqual({ items: [1, 2, 3] });
      expect(res.loading()).toBe(false);
      expect(res.error()).toBe(undefined);
      res.dispose();
    });

    it("passes route context (params, path) to the loader", async () => {
      const loader = vi.fn().mockResolvedValue("ok");
      const ctx = { params: { id: "42" }, path: "/users/42" };
      const res = executeLoader(loader, ctx);

      await tick();
      expect(loader).toHaveBeenCalledTimes(1);
      // first arg is the route context
      expect(loader.mock.calls[0][0]).toEqual(ctx);
      // second arg carries the AbortSignal
      expect(loader.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
      res.dispose();
    });

    it("surfaces loader errors on the resource error signal", async () => {
      const loader = vi.fn().mockRejectedValue(new Error("load failed"));
      const res = executeLoader(loader, { params: {}, path: "/x" }, { retry: { maxRetries: 0 } });

      await tick();
      expect(res.error()?.message).toBe("load failed");
      expect(res.loading()).toBe(false);
      res.dispose();
    });

    it("makes the resource available via loaderData after execution", async () => {
      const loader = vi.fn().mockResolvedValue({ name: "alice" });
      const res = executeLoader<{ name: string }>(loader, { params: {}, path: "/me" });

      const ld = loaderData<{ name: string }>();
      await tick();

      expect(ld.data()).toEqual({ name: "alice" });
      expect(ld.loading()).toBe(false);
      expect(ld.error()).toBe(undefined);
      res.dispose();
    });
  });

  describe("loaderData", () => {
    it("reflects loading then data transitions from the provided resource", async () => {
      const loader = vi.fn().mockResolvedValue("payload");
      const res = executeLoader(loader, { params: {}, path: "/p" });

      const ld = loaderData();
      expect(ld.loading()).toBe(true);
      expect(ld.data()).toBe(undefined);

      await tick();
      expect(ld.loading()).toBe(false);
      expect(ld.data()).toBe("payload");
      res.dispose();
    });

    // Note: LoaderContext is a global reactive store; once a loader runs it
    // stays provided. This test only asserts the "happy path" provider exists.
    it("returns getters backed by the most recently provided resource", async () => {
      const first = executeLoader(vi.fn().mockResolvedValue("first"), { params: {}, path: "/a" });
      await tick();
      const second = executeLoader(vi.fn().mockResolvedValue("second"), { params: {}, path: "/b" });
      await tick();

      const ld = loaderData();
      expect(ld.data()).toBe("second");
      first.dispose();
      second.dispose();
    });
  });

  describe("preloadRoute", () => {
    it("returns undefined when the route has no loader", async () => {
      const result = await preloadRoute({ path: "/no-loader" }, { params: {}, path: "/no-loader" });
      expect(result).toBe(undefined);
    });

    it("invokes the loader and returns its resolved value", async () => {
      const loader = vi.fn().mockResolvedValue({ preloaded: true });
      const result = await preloadRoute({ path: "/p", loader }, { params: { k: "v" }, path: "/p" });

      expect(result).toEqual({ preloaded: true });
      expect(loader).toHaveBeenCalledTimes(1);
      expect(loader.mock.calls[0][0]).toEqual({ params: { k: "v" }, path: "/p" });
      expect(loader.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    });

    it("propagates loader rejection", async () => {
      const loader = vi.fn().mockRejectedValue(new Error("preload boom"));
      await expect(preloadRoute({ path: "/p", loader }, { params: {}, path: "/p" })).rejects.toThrow("preload boom");
    });

    it("aborts the loader signal when the caller signal aborts", async () => {
      const callerController = new AbortController();
      let loaderSignal: AbortSignal | undefined;

      const loader = vi.fn(
        (_ctx, info: { signal: AbortSignal }) =>
          new Promise<string>((resolve) => {
            loaderSignal = info.signal;
            info.signal.addEventListener("abort", () => resolve("aborted"));
          }),
      );

      const promise = preloadRoute({ path: "/p", loader }, { params: {}, path: "/p" }, callerController.signal);
      await tick();
      expect(loaderSignal?.aborted).toBe(false);

      callerController.abort();
      const result = await promise;
      expect(loaderSignal?.aborted).toBe(true);
      expect(result).toBe("aborted");
    });

    it("aborts immediately when the caller signal is already aborted", async () => {
      const callerController = new AbortController();
      callerController.abort();
      let loaderSignal: AbortSignal | undefined;

      const loader = vi.fn((_ctx, info: { signal: AbortSignal }) => {
        loaderSignal = info.signal;
        return Promise.resolve("done");
      });

      const result = await preloadRoute({ path: "/p", loader }, { params: {}, path: "/p" }, callerController.signal);

      expect(result).toBe("done");
      expect(loaderSignal?.aborted).toBe(true);
    });
  });
});
