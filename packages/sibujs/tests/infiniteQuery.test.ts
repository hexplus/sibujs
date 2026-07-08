import { describe, expect, it, vi } from "vitest";
import { infiniteQuery } from "../src/data/infiniteQuery";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("infiniteQuery", () => {
  it("fetches the initial page", async () => {
    const query = infiniteQuery(
      "test",
      async ({ pageParam }) => ({ items: [`item-${pageParam}`], nextCursor: pageParam + 1 }),
      { getNextPageParam: (last) => last.nextCursor, initialPageParam: 0 },
    );

    expect(query.loading()).toBe(true);
    await tick();

    expect(query.loading()).toBe(false);
    expect(query.pages()).toHaveLength(1);
    expect(query.pages()[0].items).toEqual(["item-0"]);
    expect(query.hasNextPage()).toBe(true);

    query.dispose();
  });

  it("fetches next pages sequentially", async () => {
    const query = infiniteQuery(
      "pages",
      async ({ pageParam }: { pageParam: number; signal: AbortSignal }) => ({
        items: [pageParam],
        next: pageParam < 2 ? pageParam + 1 : undefined,
      }),
      {
        getNextPageParam: (last) => last.next,
        initialPageParam: 0,
      },
    );

    await tick();
    expect(query.pages()).toHaveLength(1);

    await query.fetchNextPage();
    expect(query.pages()).toHaveLength(2);
    expect(query.pages()[1].items).toEqual([1]);

    await query.fetchNextPage();
    expect(query.pages()).toHaveLength(3);
    expect(query.hasNextPage()).toBe(false);

    query.dispose();
  });

  it("signals no more pages via hasNextPage", async () => {
    const query = infiniteQuery("end", async () => ({ data: "only-page", next: undefined as number | undefined }), {
      getNextPageParam: (last) => last.next,
      initialPageParam: 0,
    });

    await tick();
    expect(query.hasNextPage()).toBe(false);
    expect(query.pages()).toHaveLength(1);

    query.dispose();
  });

  it("handles errors", async () => {
    const query = infiniteQuery(
      "err",
      async () => {
        throw new Error("fetch failed");
      },
      {
        getNextPageParam: () => undefined,
        initialPageParam: 0,
        retry: { maxRetries: 0 },
      },
    );

    await tick();
    expect(query.error()?.message).toBe("fetch failed");
    expect(query.loading()).toBe(false);

    query.dispose();
  });

  it("refetches from scratch", async () => {
    let fetchCount = 0;
    const query = infiniteQuery(
      "refetch",
      async ({ pageParam }: { pageParam: number; signal: AbortSignal }) => {
        fetchCount++;
        return { data: `page-${pageParam}-v${fetchCount}`, next: undefined as number | undefined };
      },
      { getNextPageParam: (last) => last.next, initialPageParam: 0 },
    );

    await tick();
    expect(query.pages()[0].data).toBe("page-0-v1");

    await query.refetch();
    expect(query.pages()[0].data).toBe("page-0-v2");
    expect(query.pages()).toHaveLength(1);

    query.dispose();
  });

  it("calls onSuccess and onError callbacks", async () => {
    const onSuccess = vi.fn();
    const onError = vi.fn();

    const query = infiniteQuery("callbacks", async () => ({ items: [1] }), {
      getNextPageParam: () => undefined,
      initialPageParam: 0,
      onSuccess,
      onError,
    });

    await tick();
    expect(onSuccess).toHaveBeenCalledWith([{ items: [1] }]);
    expect(onError).not.toHaveBeenCalled();

    query.dispose();
  });

  it("does not fetch when enabled is false", async () => {
    const fn = vi.fn().mockResolvedValue({ items: [] });
    const query = infiniteQuery("disabled", fn, {
      getNextPageParam: () => undefined,
      initialPageParam: 0,
      enabled: false,
    });

    await tick();
    expect(fn).not.toHaveBeenCalled();
    expect(query.loading()).toBe(false);

    query.dispose();
  });

  it("caps retained pages with maxPages (sliding window)", async () => {
    const query = infiniteQuery<number, number>("capped", async ({ pageParam }) => pageParam, {
      getNextPageParam: (_last, all) => all[all.length - 1] + 1,
      initialPageParam: 0,
      maxPages: 2,
    });

    await tick();
    expect(query.pages()).toEqual([0]);

    await query.fetchNextPage();
    expect(query.pages()).toEqual([0, 1]);

    await query.fetchNextPage();
    // Oldest page dropped — window stays at 2 and tracks the leading edge.
    expect(query.pages()).toEqual([1, 2]);
    expect(query.hasNextPage()).toBe(true);

    query.dispose();
  });

  it("fetchNextPage dedups concurrent calls instead of dropping a page", async () => {
    let calls = 0;
    const query = infiniteQuery<number, number>(
      "dedup",
      async ({ pageParam }) => {
        calls++;
        await new Promise((r) => setTimeout(r, 15));
        return pageParam;
      },
      { getNextPageParam: (_last, all) => all[all.length - 1] + 1, initialPageParam: 0 },
    );

    await new Promise((r) => setTimeout(r, 30)); // let the initial page fully settle
    expect(query.pages()).toEqual([0]);
    const callsAfterInitial = calls;

    const p1 = query.fetchNextPage();
    const p2 = query.fetchNextPage(); // concurrent — must return the same in-flight promise
    expect(p2).toBe(p1);

    await Promise.all([p1, p2]);
    // Only one extra fetch happened (no aborted/dropped duplicate).
    expect(calls).toBe(callsAfterInitial + 1);
    expect(query.pages()).toEqual([0, 1]);

    query.dispose();
  });

  it("fetches previous pages and no-ops at the start", async () => {
    const query = infiniteQuery(
      "prev-pages",
      async ({ pageParam }: { pageParam: number; signal: AbortSignal }) => ({
        items: [pageParam],
        prev: pageParam > 0 ? pageParam - 1 : undefined,
      }),
      {
        getNextPageParam: () => undefined,
        getPreviousPageParam: (first) => first.prev,
        initialPageParam: 2,
      },
    );

    await tick();
    expect(query.pages()).toHaveLength(1);

    await query.fetchPreviousPage(); // prev param defined → prepend
    expect(query.pages()).toHaveLength(2);
    await query.fetchPreviousPage();
    expect(query.pages()).toHaveLength(3);

    const len = query.pages().length;
    await query.fetchPreviousPage(); // first page prev is undefined → no-op
    expect(query.pages()).toHaveLength(len);

    query.dispose();
  });
});
