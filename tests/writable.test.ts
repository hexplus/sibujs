import { describe, expect, it, vi } from "vitest";
import { effect } from "../src/core/signals/effect";
import { signal } from "../src/core/signals/signal";
import { writable } from "../src/core/signals/writable";

describe("writable", () => {
  it("returns a [getter, setter] tuple", () => {
    const [first, setFirst] = signal("John");
    const [w, setW] = writable(
      () => first(),
      (v) => setFirst(v),
    );
    expect(typeof w).toBe("function");
    expect(typeof setW).toBe("function");
  });

  it("getter computes from upstream dependencies", () => {
    const [first] = signal("John");
    const [last] = signal("Doe");
    const [full] = writable(
      () => `${first()} ${last()}`,
      () => {},
    );
    expect(full()).toBe("John Doe");
  });

  it("setter routes the new value through the user-provided set fn", () => {
    const [first, setFirst] = signal("John");
    const [last, setLast] = signal("Doe");
    const [full, setFull] = writable(
      () => `${first()} ${last()}`,
      (name) => {
        const [f, ...rest] = name.split(" ");
        setFirst(f);
        setLast(rest.join(" "));
      },
    );

    setFull("Jane Smith");
    expect(first()).toBe("Jane");
    expect(last()).toBe("Smith");
    expect(full()).toBe("Jane Smith");
  });

  it("getter recomputes after upstream changes via the setter", () => {
    const [n, setN] = signal(2);
    const [doubled, setDoubled] = writable(
      () => n() * 2,
      (v) => setN(v / 2),
    );
    expect(doubled()).toBe(4);
    setDoubled(10);
    expect(n()).toBe(5);
    expect(doubled()).toBe(10);
  });

  it("getter reacts to upstream signal changes made directly", () => {
    const [n, setN] = signal(1);
    const [d] = writable(
      () => n() + 100,
      () => {},
    );
    expect(d()).toBe(101);
    setN(5);
    expect(d()).toBe(105);
  });

  it("setter wraps updates in a batch — multiple upstream writes notify once", () => {
    const [a, setA] = signal(1);
    const [b, setB] = signal(2);

    const sumSpy = vi.fn();
    effect(() => {
      // depend on both signals
      a();
      b();
      sumSpy();
    });
    expect(sumSpy).toHaveBeenCalledTimes(1);

    const [, setBoth] = writable(
      () => a() + b(),
      () => {
        setA(10);
        setB(20);
      },
    );

    setBoth(0);
    // Because the setter batches both writes, the effect runs only once more.
    expect(sumSpy).toHaveBeenCalledTimes(2);
    expect(a()).toBe(10);
    expect(b()).toBe(20);
  });

  it("calls the user setter exactly once per setter invocation", () => {
    const [n, setN] = signal(0);
    const setSpy = vi.fn((v: number) => setN(v));
    const [, setW] = writable(() => n(), setSpy);

    setW(1);
    setW(2);
    expect(setSpy).toHaveBeenCalledTimes(2);
    expect(setSpy).toHaveBeenNthCalledWith(1, 1);
    expect(setSpy).toHaveBeenNthCalledWith(2, 2);
  });

  it("passes the value through unchanged to the user setter", () => {
    const received: unknown[] = [];
    const [, setW] = writable(
      () => 0,
      (v) => {
        received.push(v);
      },
    );
    const obj = { a: 1 };
    setW(obj as unknown as number);
    expect(received[0]).toBe(obj);
  });

  it("forwards the name option to the underlying derived (devtools labeling)", () => {
    const [n] = signal(1);
    const [w] = writable(
      () => n(),
      () => {},
      { name: "myWritable" },
    );
    expect((w as unknown as { __name?: string }).__name).toBe("myWritable");
  });

  it("works without options provided", () => {
    const [n, setN] = signal(3);
    const [w, setW] = writable(
      () => n(),
      (v) => setN(v),
    );
    expect(w()).toBe(3);
    setW(7);
    expect(w()).toBe(7);
  });

  it("supports a no-op setter (read-only-ish writable)", () => {
    const [n] = signal(5);
    const [w, setW] = writable(
      () => n(),
      () => {},
    );
    expect(() => setW(99)).not.toThrow();
    // upstream untouched, getter unchanged
    expect(w()).toBe(5);
  });
});
