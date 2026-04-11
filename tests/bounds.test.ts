import { describe, expect, it, vi } from "vitest";
import { bounds } from "../src/browser/bounds";

describe("bounds", () => {
  it("reads initial rect from getBoundingClientRect", () => {
    const el = document.createElement("div");
    el.getBoundingClientRect = vi.fn(
      () =>
        ({
          x: 10,
          y: 20,
          width: 100,
          height: 50,
          top: 20,
          left: 10,
          right: 110,
          bottom: 70,
        }) as DOMRect,
    );
    document.body.appendChild(el);

    const b = bounds(el);
    const r = b.rect();
    expect(r.x).toBe(10);
    expect(r.width).toBe(100);
    expect(r.bottom).toBe(70);

    b.dispose();
    document.body.removeChild(el);
  });

  it("refresh() re-reads the rect", () => {
    const el = document.createElement("div");
    const ref = { x: 0, y: 0, width: 100, height: 100, top: 0, left: 0, right: 100, bottom: 100 };
    el.getBoundingClientRect = () => ref as DOMRect;
    document.body.appendChild(el);

    const b = bounds(el);
    ref.x = 50;
    ref.left = 50;
    ref.right = 150;
    b.refresh();
    expect(b.rect().x).toBe(50);

    b.dispose();
    document.body.removeChild(el);
  });

  it("dispose does not throw", () => {
    const el = document.createElement("div");
    el.getBoundingClientRect = () =>
      ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }) as DOMRect;
    const b = bounds(el);
    expect(() => b.dispose()).not.toThrow();
  });
});
