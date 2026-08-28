/**
 * `optimisticList()` at scale — broad operations must not be quadratic.
 *
 * WHAT WAS WRONG
 * --------------
 * Membership was tested by scanning the visible array:
 *
 *     if (visible.includes(id)) …        // inside a loop over matched rows
 *
 * so every broad operation was O(n·k), and bulk restoration was worse again
 * because rows were reinserted one at a time — scan, slice, insert, repeat.
 * On this machine with 20,000 rows a failed remove took **8.3 seconds**.
 *
 * Membership is now a boolean on the row (O(1)), and restoration merges two
 * already-sorted runs in a single pass. For `n` visible rows and `k` affected
 * rows: membership O(1), reference release O(k), broad update O(n + k), bulk
 * restoration O(n + k), publication O(n).
 *
 * HOW THIS IS ASSERTED
 * --------------------
 * Correctness first — every case checks the complete resulting list, so a fast
 * but wrong implementation fails here. The timing bound is deliberately loose:
 * it is set far above the observed cost and far below the quadratic cost, so it
 * catches a reintroduced O(n·k) path without being a wall-clock test that a
 * loaded CI machine can fail by accident. Measured timings are logged so the
 * real numbers are visible in the run output.
 */

import { describe, expect, it } from "vitest";
import { optimisticList } from "../src/patterns/optimistic";

interface Row {
  id: number;
  v: number;
}

const N = 20_000;

/**
 * Generous. The quadratic implementation took 306 ms for a broad update and
 * 8,300 ms for a bulk restore at this size; the linear one takes ~10 ms. Any
 * value in between separates them, and 2,000 ms leaves ~150× headroom over the
 * real cost while still failing a reintroduced quadratic path by a wide margin.
 */
const CEILING_MS = 2_000;

const seed = (): Row[] => Array.from({ length: N }, (_, i) => ({ id: i, v: 0 }));

async function measure(label: string, run: () => Promise<void>): Promise<number> {
  const started = performance.now();
  await run();
  const elapsed = performance.now() - started;
  console.log(`[optimisticList] ${label}: ${elapsed.toFixed(2)} ms (${N} rows)`);
  return elapsed;
}

describe(`optimisticList broad operations over ${N} rows`, () => {
  it("broad successful update stays linear and correct", async () => {
    const list = optimisticList(seed());
    const elapsed = await measure("broad update (success)", async () => {
      await list.update(
        () => true,
        { v: 1 },
        async () => ({ id: -1, v: 9 }),
      );
    });

    const items = list.items();
    expect(items).toHaveLength(N);
    // Every row was confirmed with the server value.
    expect(items[0]).toEqual({ id: -1, v: 9 });
    expect(items[N - 1]).toEqual({ id: -1, v: 9 });
    expect(items.every((r) => r.id === -1 && r.v === 9)).toBe(true);
    expect(list.pending()).toBe(false);
    expect(elapsed).toBeLessThan(CEILING_MS);
  });

  it("broad failed update rolls every row back and stays linear", async () => {
    const list = optimisticList(seed());
    const elapsed = await measure("broad update (failure)", async () => {
      await list.update(
        () => true,
        { v: 1 },
        async () => {
          throw new Error("broad update failed");
        },
      );
    });

    const items = list.items();
    expect(items).toHaveLength(N);
    // Rolled back to the pre-update values, not left holding the optimistic patch.
    expect(items[0]).toEqual({ id: 0, v: 0 });
    expect(items[N - 1]).toEqual({ id: N - 1, v: 0 });
    expect(items.every((r) => r.v === 0)).toBe(true);
    expect(list.pending()).toBe(false);
    expect(elapsed).toBeLessThan(CEILING_MS);
  });

  it("bulk failed remove restores every row in order and stays linear", async () => {
    // The worst of the quadratic paths: 8,300 ms before, because each row was
    // reinserted with its own scan-and-splice.
    const list = optimisticList(seed());
    const elapsed = await measure("bulk remove + restore", async () => {
      await list.remove(
        () => true,
        async () => {
          throw new Error("bulk remove failed");
        },
      );
    });

    const items = list.items();
    expect(items).toHaveLength(N);
    // Restored in their original relative order, by ordering key.
    expect(items[0]).toEqual({ id: 0, v: 0 });
    expect(items[1]).toEqual({ id: 1, v: 0 });
    expect(items[N - 1]).toEqual({ id: N - 1, v: 0 });
    expect(items.every((r, i) => r.id === i)).toBe(true);
    expect(list.pending()).toBe(false);
    expect(elapsed).toBeLessThan(CEILING_MS);
  });

  it("partial bulk restore interleaves correctly with a successful removal", async () => {
    // Half the rows are removed successfully while the other half's removal
    // fails, so the merge has to interleave two large sorted runs.
    const list = optimisticList(seed());
    const failing = list.remove(
      (r) => r.id % 2 === 0,
      async () => {
        throw new Error("evens stay");
      },
    );
    const succeeding = list.remove(
      (r) => r.id % 4 === 1,
      async () => {},
    );

    const elapsed = await measure("interleaved bulk restore", async () => {
      await succeeding;
      await failing;
    });

    const items = list.items();
    // Evens restored; ids ≡ 1 (mod 4) genuinely gone; ids ≡ 3 (mod 4) untouched.
    const expected = Array.from({ length: N }, (_, i) => i).filter((i) => i % 2 === 0 || i % 4 === 3);
    expect(items.map((r) => r.id)).toEqual(expected);
    expect(list.pending()).toBe(false);
    expect(elapsed).toBeLessThan(CEILING_MS);
  });

  it("reference cleanup after broad operations stays linear", async () => {
    const list = optimisticList(seed());
    const elapsed = await measure("broad update then broad remove", async () => {
      await list.update(
        () => true,
        { v: 1 },
        async () => ({ id: -1, v: 9 }),
      );
      await list.remove(
        (r) => r.v === 9,
        async () => {},
      );
    });

    expect(list.items()).toEqual([]);
    expect(list.pending()).toBe(false);
    expect(elapsed).toBeLessThan(CEILING_MS);
  });

  it("scales sub-quadratically as the row count grows", async () => {
    // A structural check rather than an absolute one: quadrupling the rows must
    // not multiply the cost by anything like 16. The bound is loose enough to
    // absorb timer noise and a busy host, and still far below quadratic growth.
    const run = async (rows: number) => {
      const list = optimisticList(Array.from({ length: rows }, (_, i) => ({ id: i, v: 0 })));
      const started = performance.now();
      await list.remove(
        () => true,
        async () => {
          throw new Error("restore them all");
        },
      );
      const elapsed = performance.now() - started;
      expect(list.items()).toHaveLength(rows);
      return elapsed;
    };

    // Warm up so JIT compilation is not attributed to the smaller size.
    await run(2_000);

    const small = Math.min(await run(5_000), await run(5_000));
    const large = Math.min(await run(20_000), await run(20_000));
    const ratio = large / Math.max(small, 0.05);
    console.log(`[optimisticList] 4× rows → ${ratio.toFixed(1)}× time (${small.toFixed(2)} → ${large.toFixed(2)} ms)`);

    // Linear is ~4×; quadratic is ~16×. Anything under 10 is decisively not the
    // latter, and the generous gap keeps this stable on a shared machine.
    expect(ratio).toBeLessThan(10);
  });
});
