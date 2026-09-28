/**
 * `onMount()` accepts any callback shape a typed consumer would naturally write.
 *
 * The callback was typed `() => undefined | CleanupFn`. TypeScript infers a
 * block body with no `return` as `void`, not `undefined`, so the most common
 * form — `onMount(() => { el.focus(); })` — failed to compile (TS2345) even
 * though the runtime handles it: only a returned FUNCTION is treated as a
 * cleanup, anything else is ignored.
 *
 * The compile half of this file is enforced by `npm run typecheck:tests`; the
 * runtime half pins that the widened type describes what already happens.
 */
import { afterEach, describe, expect, expectTypeOf, it } from "vitest";
import { dispose, onMount } from "../index";

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

afterEach(() => {
  document.body.innerHTML = "";
});

describe("onMount() callback typing", () => {
  it("accepts every callback form the runtime supports (compile-time)", () => {
    const el = document.createElement("div");

    // A block body with no return — inferred as `() => void`.
    onMount(() => {
      el.textContent = "mounted";
    }, el);
    // A block body that returns nothing explicitly.
    onMount(() => {
      return;
    }, el);
    onMount(() => undefined, el);
    // A returned cleanup.
    onMount(() => () => {}, el);
    onMount(() => {
      const id = setInterval(() => {}, 1000);
      return () => clearInterval(id);
    }, el);
    // No element.
    onMount(() => {});
    // A callback declared elsewhere with an explicit `void` return.
    const setup = (): void => {};
    onMount(setup, el);

    // biome-ignore lint/suspicious/noConfusingVoidType: the exact public callback type under test.
    expectTypeOf(onMount).parameter(0).toEqualTypeOf<() => void | (() => void)>();
    expectTypeOf(onMount).returns.toEqualTypeOf<void>();
  });

  it("still rejects callbacks that take arguments or return a non-cleanup value", () => {
    const el = document.createElement("div");
    // @ts-expect-error — the callback receives no arguments
    onMount((node: Element) => node, el);
    // @ts-expect-error — a number is neither nothing nor a cleanup function
    onMount(() => 42, el);
  });

  it("a block-body callback with no return runs, and registers nothing to clean up", async () => {
    const el = document.createElement("div");
    const calls: string[] = [];
    document.body.appendChild(el);
    onMount(() => {
      calls.push("mount");
    }, el);
    await flush();
    expect(calls).toEqual(["mount"]);
    expect(() => dispose(el)).not.toThrow();
  });

  it("a returned cleanup still runs exactly once on dispose", async () => {
    const el = document.createElement("div");
    const calls: string[] = [];
    document.body.appendChild(el);
    onMount(() => {
      calls.push("mount");
      return () => calls.push("cleanup");
    }, el);
    await flush();
    dispose(el);
    dispose(el);
    expect(calls).toEqual(["mount", "cleanup"]);
  });

  it("a non-function return value is ignored, not called", async () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    // An async callback returns a promise, which is not a cleanup.
    const asyncSetup = async (): Promise<void> => {};
    onMount(asyncSetup as unknown as () => void, el);
    onMount(() => 42 as unknown as undefined, el);
    await flush();
    expect(() => dispose(el)).not.toThrow();
  });
});
