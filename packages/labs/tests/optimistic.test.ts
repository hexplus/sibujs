import { describe, expect, it } from "vitest";
import { optimistic, optimisticList } from "../src/patterns/optimistic";

// Helpers
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ============================================================================
// optimistic (single value)
// ============================================================================

describe("optimistic", () => {
  it("initializes with value", () => {
    const o = optimistic("hello");
    expect(o.value()).toBe("hello");
    expect(o.pending()).toBe(false);
  });

  it("applies optimistic value immediately", async () => {
    const o = optimistic("initial");
    const p = o.update("optimistic", async () => "confirmed");
    expect(o.value()).toBe("optimistic");
    expect(o.pending()).toBe(true);
    await p;
    expect(o.value()).toBe("confirmed");
    expect(o.pending()).toBe(false);
  });

  it("reverts on failure", async () => {
    const o = optimistic("initial");
    const p = o.update("optimistic", async () => {
      throw new Error("fail");
    });
    expect(o.value()).toBe("optimistic");
    await p;
    expect(o.value()).toBe("initial");
    expect(o.pending()).toBe(false);
  });

  it("pending is true while any operation is in flight", async () => {
    const o = optimistic(0);
    const p1 = o.update(1, () => delay(50).then(() => 1));
    const p2 = o.update(2, () => delay(100).then(() => 2));
    expect(o.pending()).toBe(true);
    await p1;
    expect(o.pending()).toBe(true);
    await p2;
    expect(o.pending()).toBe(false);
  });

  it("concurrent: stale revert is suppressed when a newer operation exists", async () => {
    const o = optimistic(0);
    // First op: will fail after 50ms
    const p1 = o.update(10, async () => {
      await delay(50);
      throw new Error("fail");
    });
    // Second op: starts immediately, captures prev=10, succeeds after 100ms
    const p2 = o.update(20, () => delay(100).then(() => 25));

    expect(o.value()).toBe(20);

    await p1;
    // First op failed — but second op is newer, so revert is suppressed
    expect(o.value()).toBe(20);

    await p2;
    expect(o.value()).toBe(25);
    expect(o.pending()).toBe(false);
  });

  it("concurrent: stale success is suppressed when a newer operation exists", async () => {
    const o = optimistic(0);
    const p1 = o.update(10, () => delay(100).then(() => 10));
    const p2 = o.update(20, () => delay(50).then(() => 20));

    await p2;
    expect(o.value()).toBe(20);

    await p1;
    // First op succeeded — but second op was newer, so result is ignored
    expect(o.value()).toBe(20);
  });
});

// ============================================================================
// optimisticList
// ============================================================================

describe("optimisticList", () => {
  it("initializes with items", () => {
    const o = optimisticList([1, 2, 3]);
    expect(o.items()).toEqual([1, 2, 3]);
    expect(o.pending()).toBe(false);
  });

  // ---- add ----------------------------------------------------------------

  it("add: applies item immediately and replaces with result on success", async () => {
    const o = optimisticList([1, 2]);
    await o.add(3, async () => 30);
    expect(o.items()).toEqual([1, 2, 30]);
  });

  it("add: reverts on failure", async () => {
    const o = optimisticList([1, 2]);
    await o.add(3, async () => {
      throw new Error("fail");
    });
    expect(o.items()).toEqual([1, 2]);
  });

  it("add: pending tracks in-flight state", async () => {
    const o = optimisticList<number>([]);
    const p = o.add(1, () => delay(20).then(() => 1));
    expect(o.pending()).toBe(true);
    await p;
    expect(o.pending()).toBe(false);
  });

  // ---- remove -------------------------------------------------------------

  it("remove: filters immediately and keeps on success", async () => {
    const o = optimisticList([1, 2, 3]);
    await o.remove(
      (i) => i === 2,
      async () => {},
    );
    expect(o.items()).toEqual([1, 3]);
  });

  it("remove: reverts on failure", async () => {
    const o = optimisticList([1, 2, 3]);
    await o.remove(
      (i) => i === 2,
      async () => {
        throw new Error("fail");
      },
    );
    expect(o.items()).toEqual([1, 2, 3]);
  });

  // ---- update -------------------------------------------------------------

  it("update: patches immediately and replaces with result on success", async () => {
    type Item = { id: number; name: string };
    const o = optimisticList<Item>([
      { id: 1, name: "Alice" },
      { id: 2, name: "Bob" },
    ]);

    await o.update(
      (i) => i.id === 2,
      { name: "Bobby" },
      async () => ({ id: 2, name: "Robert" }),
    );

    expect(o.items()).toEqual([
      { id: 1, name: "Alice" },
      { id: 2, name: "Robert" },
    ]);
  });

  it("update: reverts on failure", async () => {
    type Item = { id: number; name: string };
    const o = optimisticList<Item>([
      { id: 1, name: "Alice" },
      { id: 2, name: "Bob" },
    ]);

    await o.update(
      (i) => i.id === 2,
      { name: "Bobby" },
      async () => {
        throw new Error("fail");
      },
    );

    expect(o.items()).toEqual([
      { id: 1, name: "Alice" },
      { id: 2, name: "Bob" },
    ]);
  });

  it("update: predicate that changes the matched property still resolves (Bug #3 regression)", async () => {
    type Item = { id: number; status: string };
    const o = optimisticList<Item>([{ id: 1, status: "draft" }]);

    await o.update(
      (i) => i.id === 1,
      { status: "published" },
      async () => ({ id: 1, status: "published" }),
    );

    expect(o.items()).toEqual([{ id: 1, status: "published" }]);
  });

  // ---- concurrent version guard -------------------------------------------

  it("concurrent: stale revert suppressed when newer op exists", async () => {
    const o = optimisticList([1, 2, 3]);

    const p1 = o.add(4, async () => {
      await delay(50);
      throw new Error("fail");
    });
    const p2 = o.add(5, () => delay(100).then(() => 50));

    expect(o.items()).toEqual([1, 2, 3, 4, 5]);

    await p1;
    // First op failed but second is newer — revert suppressed, 5 stays
    expect(o.items()).toContain(5);

    await p2;
    expect(o.items()).toContain(50);
  });
});
