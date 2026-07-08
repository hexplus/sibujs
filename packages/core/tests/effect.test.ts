import { describe, expect, it, vi } from "vitest";
import { effect } from "../src/core/signals/effect";
import { signal } from "../src/core/signals/signal";

describe("effect", () => {
  it("should run effect on initial call and when dependency changes", () => {
    const [count, setCount] = signal(0);
    const effectSpy = vi.fn(() => {
      count(); // dependency
    });

    effect(effectSpy);

    expect(effectSpy).toHaveBeenCalledTimes(1);
    setCount(1);
    expect(effectSpy).toHaveBeenCalledTimes(2);
    setCount(2);
    expect(effectSpy).toHaveBeenCalledTimes(3);
  });
});
