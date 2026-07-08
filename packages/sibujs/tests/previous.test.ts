import { describe, expect, it } from "vitest";
import { derived } from "@sibujs/core";
import { signal } from "@sibujs/core";
import { previous } from "../src/data/previous";

describe("previous", () => {
  it("returns undefined on first read", () => {
    const [count] = signal(0);
    const prev = previous(count);
    expect(prev()).toBe(undefined);
  });

  it("returns the previous value after a state change", async () => {
    const [count, setCount] = signal(0);
    const prev = previous(count);

    setCount(5);
    await Promise.resolve();

    expect(prev()).toBe(0);
    expect(count()).toBe(5);
  });

  it("tracks multiple successive changes", async () => {
    const [count, setCount] = signal(0);
    const prev = previous(count);

    setCount(1);
    await Promise.resolve();
    expect(prev()).toBe(0);

    setCount(2);
    await Promise.resolve();
    expect(prev()).toBe(1);

    setCount(3);
    await Promise.resolve();
    expect(prev()).toBe(2);
  });

  it("does not update when value is set to the same value", async () => {
    const [count, setCount] = signal(5);
    const prev = previous(count);

    setCount(5); // same value
    await Promise.resolve();

    expect(prev()).toBe(undefined); // still undefined, no change occurred
  });

  it("works with derived as source", async () => {
    const [count, setCount] = signal(1);
    const doubled = derived(() => count() * 2);
    const prev = previous(doubled);

    expect(prev()).toBe(undefined);

    setCount(2);
    await Promise.resolve();

    expect(doubled()).toBe(4);
    expect(prev()).toBe(2);

    setCount(3);
    await Promise.resolve();

    expect(doubled()).toBe(6);
    expect(prev()).toBe(4);
  });

  it("works with string values", async () => {
    const [name, setName] = signal("alice");
    const prev = previous(name);

    expect(prev()).toBe(undefined);

    setName("bob");
    await Promise.resolve();
    expect(prev()).toBe("alice");

    setName("charlie");
    await Promise.resolve();
    expect(prev()).toBe("bob");
  });

  it("dispose() stops tracking the source", async () => {
    const [count, setCount] = signal(0);
    const prev = previous(count) as (() => number | undefined) & { dispose: () => void };
    expect(typeof prev.dispose).toBe("function");

    setCount(1);
    await Promise.resolve();
    expect(prev()).toBe(0);

    prev.dispose();
    setCount(2);
    await Promise.resolve();
    // No longer tracking — previous stays at the last tracked value.
    expect(prev()).toBe(0);
  });
});
