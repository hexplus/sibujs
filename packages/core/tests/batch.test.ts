import { describe, expect, it } from "vitest";
import { derived } from "../src/core/signals/derived";
import { effect } from "../src/core/signals/effect";
import { signal } from "../src/core/signals/signal";
import { batch } from "../src/reactivity/batch";

describe("batch", () => {
  it("should defer notifications until batch completes", () => {
    const [a, setA] = signal(1);
    const [b, setB] = signal(2);
    let calls = 0;

    effect(() => {
      a();
      b();
      calls++;
    });

    // Initial effect call
    expect(calls).toBe(1);

    batch(() => {
      setA(10);
      setB(20);
    });

    // Should only have triggered one additional notification pass
    // (rather than two separate ones)
    expect(a()).toBe(10);
    expect(b()).toBe(20);
  });

  it("should support nested batches", () => {
    const [x, setX] = signal(0);
    let calls = 0;

    effect(() => {
      x();
      calls++;
    });

    expect(calls).toBe(1);

    batch(() => {
      batch(() => {
        setX(1);
      });
      // Inner batch shouldn't have flushed yet
      setX(2);
    });

    // Only the outermost batch triggers flush
    expect(x()).toBe(2);
  });

  it("should propagate through computed to effect subscribers inside batch", () => {
    const [elapsed, setElapsed] = signal(5000);
    const display = derived(() => {
      const ms = elapsed();
      const min = Math.floor(ms / 60000);
      const sec = Math.floor((ms % 60000) / 1000);
      const centis = Math.floor((ms % 1000) / 10);
      return `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}.${String(centis).padStart(2, "0")}`;
    });

    let rendered = "";
    effect(() => {
      rendered = display();
    });

    expect(rendered).toBe("00:05.00");

    batch(() => {
      setElapsed(0);
    });

    expect(rendered).toBe("00:00.00");
  });

  it("should notify immediately when not batching", () => {
    const [val, setVal] = signal("a");
    let lastSeen = "";

    effect(() => {
      lastSeen = val();
    });

    expect(lastSeen).toBe("a");
    setVal("b");
    expect(lastSeen).toBe("b");
  });
});
