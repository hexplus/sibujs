import { describe, expect, it } from "vitest";
import { nextTick } from "../src/reactivity/nextTick";

describe("nextTick", () => {
  it("resolves asynchronously", async () => {
    let resolved = false;
    const p = nextTick().then(() => {
      resolved = true;
    });
    expect(resolved).toBe(false);
    await p;
    expect(resolved).toBe(true);
  });

  it("can be awaited in sequence", async () => {
    const order: number[] = [];
    order.push(1);
    await nextTick();
    order.push(2);
    await nextTick();
    order.push(3);
    expect(order).toEqual([1, 2, 3]);
  });
});
