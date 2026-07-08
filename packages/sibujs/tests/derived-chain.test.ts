import { describe, expect, it } from "vitest";
import { derived, effect, signal } from "../index";

describe("derived chain propagation", () => {
  it("derived-of-derived updates when source changes", () => {
    const [a, setA] = signal(10);
    const [b, setB] = signal(20);

    // d1 depends on a
    const d1 = derived(() => a() * 2);
    // d2 depends on b
    const d2 = derived(() => b() * 3);
    // d3 depends on d1 and d2 (derived-of-derived)
    const d3 = derived(() => d1() + d2());

    expect(d3()).toBe(80); // 10*2 + 20*3

    // Track via effect
    let effectValue = 0;
    effect(() => {
      effectValue = d3();
    });
    expect(effectValue).toBe(80);

    // Change source — should propagate through chain
    setA(15);
    expect(d3()).toBe(90); // 15*2 + 20*3
    expect(effectValue).toBe(90);

    setB(10);
    expect(d3()).toBe(60); // 15*2 + 10*3
    expect(effectValue).toBe(60);
  });

  it("multi-level derived chain (3 levels deep)", () => {
    const [raw, setRaw] = signal(5);
    const level1 = derived(() => raw() * 2); // 10
    const level2 = derived(() => level1() + 1); // 11
    const level3 = derived(() => level2() * 10); // 110

    let tracked = 0;
    effect(() => {
      tracked = level3();
    });
    expect(tracked).toBe(110);

    setRaw(10);
    expect(level1()).toBe(20);
    expect(level2()).toBe(21);
    expect(level3()).toBe(210);
    expect(tracked).toBe(210);
  });

  it("formula-like: SUM derived reads other deriveds", () => {
    const [a, setA] = signal(100);
    const [b, setB] = signal(200);
    const [c, setC] = signal(300);

    const da = derived(() => a());
    const db = derived(() => b());
    const dc = derived(() => c());

    // SUM derived reads other deriveds
    const sum = derived(() => da() + db() + dc());

    let effectSum = 0;
    effect(() => {
      effectSum = sum();
    });
    expect(effectSum).toBe(600);

    setA(150);
    expect(effectSum).toBe(650);

    setB(250);
    expect(effectSum).toBe(700);

    setC(350);
    expect(effectSum).toBe(750);
  });
});
