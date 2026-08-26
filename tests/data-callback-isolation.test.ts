/**
 * Data-layer callback exception semantics.
 *
 * The contract this suite pins (see `docs/hardening/final-rc-findings.md`,
 * DATA-001 / DATA-002):
 *
 *   1. The success/failure status of an async operation is decided by the
 *      operation itself. A user callback throwing NEVER retroactively
 *      reclassifies a request that already succeeded, nor rewrites the error of
 *      one that already failed.
 *
 *   2. Observers sharing a cache entry are isolated from each other. One
 *      observer's `select` or listener throwing may not stop the remaining
 *      observers from receiving the shared result.
 *
 *   3. Callback exceptions are surfaced, never silently swallowed — they are
 *      reported through `console.error` and are decoupled from the operation's
 *      own error channel.
 *
 *   4. No callback path may produce an unhandled promise rejection. Callbacks
 *      run from effects and timers where nothing is awaiting the result.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { infiniteQuery } from "../src/data/infiniteQuery";
import { mutation } from "../src/data/mutation";
import { clearQueryCache, getQueryData, query, setQueryData } from "../src/data/query";
import { resource } from "../src/data/resource";

const settle = async () => {
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 0));
    for (let j = 0; j < 15; j++) await Promise.resolve();
  }
};

/** Captures console.error so tests can assert the exception WAS surfaced. */
function captureErrors() {
  const seen: unknown[][] = [];
  const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    seen.push(args);
  });
  return {
    seen,
    /** Every captured argument flattened to a searchable string. */
    text: () => seen.map((args) => args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ")).join("\n"),
    restore: () => spy.mockRestore(),
  };
}

let keyCounter = 0;
const freshKey = () => `k-${++keyCounter}`;

describe("data layer: user callback exception semantics", () => {
  let errors: ReturnType<typeof captureErrors>;

  beforeEach(() => {
    clearQueryCache();
    errors = captureErrors();
  });

  afterEach(() => {
    errors.restore();
    clearQueryCache();
    vi.restoreAllMocks();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // DATA-001 — shared observer isolation
  // ─────────────────────────────────────────────────────────────────────────

  describe("shared observer isolation", () => {
    it("a throwing select in one observer does not starve another", async () => {
      const key = freshKey();
      let calls = 0;
      const fetcher = async () => {
        calls++;
        return "payload";
      };

      // A subscribes first, so it is first in the listener Set — an unguarded
      // `for (const l of listeners) l()` would abort before ever reaching B.
      const a = query(key, fetcher, {
        select: () => {
          throw new Error("selector failed");
        },
      });
      const b = query(key, fetcher, { select: (v) => v });

      await settle();

      // The shared request ran once and succeeded.
      expect(calls).toBe(1);
      expect(getQueryData(key)).toBe("payload");

      // B is not collateral damage.
      expect(b.data()).toBe("payload");
      expect(b.error()).toBeUndefined();
      expect(b.fetching()).toBe(false);

      // A's own failure is surfaced, and it is NOT the request's error.
      expect(errors.text()).toContain("selector failed");

      // The shared cache is not poisoned by A's selector.
      expect(getQueryData(key)).toBe("payload");

      a.dispose();
      b.dispose();
    });

    it("a throwing select does not mark the shared request as failed", async () => {
      const key = freshKey();
      const a = query(key, async () => "ok", {
        select: () => {
          throw new Error("selector failed");
        },
      });
      await settle();

      // The fetch succeeded; the selector is the observer's own transform.
      expect(getQueryData(key)).toBe("ok");
      expect(a.fetching()).toBe(false);

      a.dispose();
    });

    it("setQueryData reaches every observer even if one throws", async () => {
      const key = freshKey();
      const a = query(key, async () => "first", {
        select: (v) => {
          if (v === "pushed") throw new Error("A rejects pushed data");
          return v;
        },
      });
      const b = query(key, async () => "first");
      await settle();
      expect(b.data()).toBe("first");

      setQueryData(key, "pushed");
      await settle();

      expect(b.data()).toBe("pushed");
      expect(errors.text()).toContain("A rejects pushed data");

      a.dispose();
      b.dispose();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // DATA-002 — query lifecycle callbacks
  // ─────────────────────────────────────────────────────────────────────────

  describe("query lifecycle callbacks", () => {
    it("onSuccess throwing leaves the query successful", async () => {
      const key = freshKey();
      const q = query(key, async () => "value", {
        onSuccess: () => {
          throw new Error("onSuccess exploded");
        },
      });
      await settle();

      expect(q.data()).toBe("value");
      expect(q.error()).toBeUndefined();
      expect(q.fetching()).toBe(false);
      expect(q.loading()).toBe(false);
      expect(getQueryData(key)).toBe("value");
      expect(errors.text()).toContain("onSuccess exploded");

      q.dispose();
    });

    it("onSuccess throwing does not trigger onError", async () => {
      const key = freshKey();
      const onError = vi.fn();
      const q = query(key, async () => "value", {
        onSuccess: () => {
          throw new Error("onSuccess exploded");
        },
        onError,
      });
      await settle();

      // The request never failed, so the error channel must stay quiet.
      expect(onError).not.toHaveBeenCalled();

      q.dispose();
    });

    it("onError throwing preserves the original request error", async () => {
      const key = freshKey();
      const q = query(
        key,
        async () => {
          throw new Error("network down");
        },
        {
          retry: { maxRetries: 0 },
          onError: () => {
            throw new Error("onError exploded");
          },
        },
      );
      await settle();

      expect(q.error()?.message).toBe("network down");
      expect(q.fetching()).toBe(false);
      expect(errors.text()).toContain("onError exploded");

      q.dispose();
    });

    it("onSettled still runs when onError throws", async () => {
      const key = freshKey();
      const onSettled = vi.fn();
      const q = query(
        key,
        async () => {
          throw new Error("network down");
        },
        {
          retry: { maxRetries: 0 },
          onError: () => {
            throw new Error("onError exploded");
          },
          onSettled,
        },
      );
      await settle();

      expect(onSettled).toHaveBeenCalledTimes(1);
      q.dispose();
    });

    it("onSettled throwing leaves the terminal state terminal", async () => {
      const key = freshKey();
      const q = query(key, async () => "value", {
        onSettled: () => {
          throw new Error("onSettled exploded");
        },
      });
      await settle();

      expect(q.data()).toBe("value");
      expect(q.error()).toBeUndefined();
      expect(q.fetching()).toBe(false);
      expect(errors.text()).toContain("onSettled exploded");

      q.dispose();
    });

    it("a refetch after a throwing callback still works", async () => {
      const key = freshKey();
      let n = 0;
      const q = query(
        key,
        async () => {
          n++;
          return `v${n}`;
        },
        {
          onSuccess: () => {
            throw new Error("always throws");
          },
        },
      );
      await settle();
      expect(q.data()).toBe("v1");

      await q.refetch();
      await settle();

      // Request ownership was never corrupted by the throwing callback.
      expect(q.data()).toBe("v2");
      expect(q.error()).toBeUndefined();
      expect(q.fetching()).toBe(false);

      q.dispose();
    });

    it("a throwing callback in a deduplicated waiter does not break the waiter", async () => {
      const key = freshKey();
      const fetcher = async () => {
        await new Promise((r) => setTimeout(r, 5));
        return "shared";
      };
      const owner = query(key, fetcher);
      const waiter = query(key, fetcher, {
        onSuccess: () => {
          throw new Error("waiter onSuccess exploded");
        },
      });
      await settle();

      expect(owner.data()).toBe("shared");
      expect(waiter.data()).toBe("shared");
      expect(waiter.error()).toBeUndefined();
      expect(waiter.fetching()).toBe(false);

      owner.dispose();
      waiter.dispose();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // resource()
  // ─────────────────────────────────────────────────────────────────────────

  describe("resource lifecycle callbacks", () => {
    it("onSuccess throwing leaves the resource successful", async () => {
      const r = resource(async () => "data", {
        onSuccess: () => {
          throw new Error("res onSuccess exploded");
        },
      });
      await settle();

      expect(r.data()).toBe("data");
      expect(r.error()).toBeUndefined();
      expect(r.loading()).toBe(false);
      expect(errors.text()).toContain("res onSuccess exploded");

      r.dispose();
    });

    it("onError throwing preserves the original error and clears loading", async () => {
      const r = resource(
        async () => {
          throw new Error("res network down");
        },
        {
          retry: { maxRetries: 0 },
          onError: () => {
            throw new Error("res onError exploded");
          },
        },
      );
      await settle();

      expect(r.error()?.message).toBe("res network down");
      expect(r.loading()).toBe(false);
      expect(r.data()).toBeUndefined();

      r.dispose();
    });

    it("onSettled throwing leaves the terminal state terminal", async () => {
      const r = resource(async () => "data", {
        onSettled: () => {
          throw new Error("res onSettled exploded");
        },
      });
      await settle();

      expect(r.data()).toBe("data");
      expect(r.error()).toBeUndefined();
      expect(r.loading()).toBe(false);

      r.dispose();
    });

    it("onStart throwing does not prevent the fetch", async () => {
      let fetched = false;
      const r = resource(
        async () => {
          fetched = true;
          return "data";
        },
        {
          onStart: () => {
            throw new Error("res onStart exploded");
          },
        },
      );
      await settle();

      expect(fetched).toBe(true);
      expect(r.data()).toBe("data");
      expect(r.error()).toBeUndefined();
      expect(errors.text()).toContain("res onStart exploded");

      r.dispose();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // infiniteQuery()
  // ─────────────────────────────────────────────────────────────────────────

  describe("infiniteQuery lifecycle callbacks", () => {
    it("onSuccess throwing keeps the page appended and clears the flags", async () => {
      const iq = infiniteQuery(freshKey(), async ({ pageParam }) => `page-${pageParam}`, {
        initialPageParam: 0,
        getNextPageParam: (_last, all) => (all.length < 3 ? all.length : undefined),
        onSuccess: () => {
          throw new Error("iq onSuccess exploded");
        },
      });
      await settle();

      expect(iq.pages()).toEqual(["page-0"]);
      expect(iq.error()).toBeUndefined();
      expect(iq.fetching()).toBe(false);
      expect(iq.fetchingNextPage()).toBe(false);
      expect(errors.text()).toContain("iq onSuccess exploded");

      iq.dispose();
    });

    it("a second page still appends after onSuccess threw on the first", async () => {
      const iq = infiniteQuery(freshKey(), async ({ pageParam }) => `page-${pageParam}`, {
        initialPageParam: 0,
        getNextPageParam: (_last, all) => (all.length < 3 ? all.length : undefined),
        onSuccess: () => {
          throw new Error("iq onSuccess exploded");
        },
      });
      await settle();

      await iq.fetchNextPage();
      await settle();

      expect(iq.pages()).toEqual(["page-0", "page-1"]);
      expect(iq.error()).toBeUndefined();
      expect(iq.fetching()).toBe(false);

      iq.dispose();
    });

    it("onError throwing preserves the original error", async () => {
      const iq = infiniteQuery<string, number>(
        freshKey(),
        async () => {
          throw new Error("iq network down");
        },
        {
          initialPageParam: 0,
          getNextPageParam: () => undefined,
          retry: { maxRetries: 0 },
          onError: () => {
            throw new Error("iq onError exploded");
          },
        },
      );
      await settle();

      expect(iq.error()?.message).toBe("iq network down");
      expect(iq.fetching()).toBe(false);
      expect(iq.fetchingNextPage()).toBe(false);

      iq.dispose();
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // mutation()
  // ─────────────────────────────────────────────────────────────────────────

  describe("mutation lifecycle callbacks", () => {
    it("onSuccess throwing leaves the mutation successful", async () => {
      const m = mutation(async (n: number) => n * 2, {
        onSuccess: () => {
          throw new Error("mut onSuccess exploded");
        },
      });

      const result = await m.mutateAsync(21);
      await settle();

      // The mutation itself succeeded — that is what decides the status.
      expect(result).toBe(42);
      expect(m.data()).toBe(42);
      expect(m.isSuccess()).toBe(true);
      expect(m.error()).toBeUndefined();
      expect(m.loading()).toBe(false);
      expect(errors.text()).toContain("mut onSuccess exploded");
    });

    it("onSuccess throwing does not trigger onError", async () => {
      const onError = vi.fn();
      const m = mutation(async (n: number) => n, {
        onSuccess: () => {
          throw new Error("mut onSuccess exploded");
        },
        onError,
      });

      await m.mutateAsync(1);
      await settle();

      expect(onError).not.toHaveBeenCalled();
      expect(m.isSuccess()).toBe(true);
    });

    it("onSettled throwing does not convert success into failure", async () => {
      const m = mutation(async (n: number) => n, {
        onSettled: () => {
          throw new Error("mut onSettled exploded");
        },
      });

      await m.mutateAsync(7);
      await settle();

      expect(m.data()).toBe(7);
      expect(m.isSuccess()).toBe(true);
      expect(m.error()).toBeUndefined();
    });

    it("onError throwing preserves the original mutation error", async () => {
      const m = mutation(
        async () => {
          throw new Error("mut network down");
        },
        {
          retry: { maxRetries: 0 },
          onError: () => {
            throw new Error("mut onError exploded");
          },
        },
      );

      await expect(m.mutateAsync(undefined as never)).rejects.toThrow("mut network down");
      await settle();

      expect(m.error()?.message).toBe("mut network down");
      expect(m.isSuccess()).toBe(false);
      expect(m.loading()).toBe(false);
    });

    it("onSettled still runs when onError throws", async () => {
      const onSettled = vi.fn();
      const m = mutation(
        async () => {
          throw new Error("mut network down");
        },
        {
          retry: { maxRetries: 0 },
          onError: () => {
            throw new Error("mut onError exploded");
          },
          onSettled,
        },
      );

      await m.mutateAsync(undefined as never).catch(() => {});
      await settle();

      expect(onSettled).toHaveBeenCalledTimes(1);
    });

    it("pins the success callback order: state commit, then onSuccess, then onSettled", async () => {
      const order: string[] = [];
      const m = mutation(async (n: number) => n, {
        onMutate: () => {
          order.push("onMutate");
          return { ctx: 1 };
        },
        onSuccess: () => {
          order.push("onSuccess");
          throw new Error("mut onSuccess exploded");
        },
        onSettled: () => {
          order.push("onSettled");
        },
      });

      await m.mutateAsync(3);
      await settle();

      // A throwing onSuccess must not skip onSettled.
      expect(order).toEqual(["onMutate", "onSuccess", "onSettled"]);
      expect(m.isSuccess()).toBe(true);
    });

    it("pins the failure callback order: onError, then onSettled", async () => {
      const order: string[] = [];
      const m = mutation(
        async () => {
          throw new Error("boom");
        },
        {
          retry: { maxRetries: 0 },
          onError: () => {
            order.push("onError");
            throw new Error("mut onError exploded");
          },
          onSettled: () => {
            order.push("onSettled");
          },
        },
      );

      await m.mutateAsync(undefined as never).catch(() => {});
      await settle();

      expect(order).toEqual(["onError", "onSettled"]);
    });

    it("optimistic rollback context still reaches onError when callbacks throw", async () => {
      // Rollback behavior itself is unchanged by this pass; this only proves the
      // isolation work did not sever the onMutate → onError context handoff.
      let seenContext: unknown;
      const m = mutation(
        async () => {
          throw new Error("boom");
        },
        {
          retry: { maxRetries: 0 },
          onMutate: () => ({ snapshot: "before" }),
          onError: (_e, _v, ctx) => {
            seenContext = ctx;
            throw new Error("mut onError exploded");
          },
        },
      );

      await m.mutateAsync(undefined as never).catch(() => {});
      await settle();

      expect(seenContext).toEqual({ snapshot: "before" });
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // §50 — no callback path may create an unhandled rejection
  // ─────────────────────────────────────────────────────────────────────────

  describe("unhandled rejection gate", () => {
    it("throwing callbacks across every primitive produce no unhandled rejection", async () => {
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown) => unhandled.push(reason);
      process.on("unhandledRejection", onUnhandled);

      try {
        const boom = () => {
          throw new Error("callback exploded");
        };

        // query — success and failure paths, both fired from an effect where
        // nothing is awaiting doFetch().
        const q1 = query(freshKey(), async () => "v", { onSuccess: boom, onSettled: boom });
        const q2 = query(
          freshKey(),
          async () => {
            throw new Error("fail");
          },
          { retry: { maxRetries: 0 }, onError: boom, onSettled: boom },
        );
        const q3 = query(freshKey(), async () => "v", { select: boom });

        // resource — doFetch() is invoked unawaited from an effect.
        const r1 = resource(async () => "v", { onStart: boom, onSuccess: boom, onSettled: boom });
        const r2 = resource(
          async () => {
            throw new Error("fail");
          },
          { retry: { maxRetries: 0 }, onError: boom, onSettled: boom },
        );

        // infiniteQuery — fetchPage() is invoked unawaited from an effect, and
        // its promise is additionally `void promise.finally(...)`-ed.
        const iq1 = infiniteQuery(freshKey(), async () => "page", {
          initialPageParam: 0,
          getNextPageParam: () => undefined,
          onSuccess: boom,
        });
        const iq2 = infiniteQuery<string, number>(
          freshKey(),
          async () => {
            throw new Error("fail");
          },
          {
            initialPageParam: 0,
            getNextPageParam: () => undefined,
            retry: { maxRetries: 0 },
            onError: boom,
          },
        );

        // mutation — fire-and-forget mutate(), the path with no awaiter at all.
        const m1 = mutation(async (n: number) => n, { onSuccess: boom, onSettled: boom });
        m1.mutate(1);
        const m2 = mutation(
          async () => {
            throw new Error("fail");
          },
          { retry: { maxRetries: 0 }, onError: boom, onSettled: boom },
        );
        m2.mutate(undefined as never);

        await settle();
        await new Promise((r) => setTimeout(r, 20));

        expect(unhandled).toEqual([]);

        q1.dispose();
        q2.dispose();
        q3.dispose();
        r1.dispose();
        r2.dispose();
        iq1.dispose();
        iq2.dispose();
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
    });
  });
});
