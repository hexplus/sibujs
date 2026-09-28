/**
 * `onMount()` accepts any callback shape a typed consumer would naturally write.
 *
 * The callback was typed `() => undefined | CleanupFn`. TypeScript infers a
 * block body with no `return` as `void`, not `undefined`, so the most common
 * form — `onMount(() => { el.focus(); })` — failed to compile (TS2345) even
 * though the runtime handles it.
 *
 * The supported contract: the callback returns nothing, or a cleanup function.
 * Async callbacks are NOT part of it. The runtime ignores any other return value
 * only defensively, for callers that bypass the type system.
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
    // Optional cleanup — inferred as `() => (() => void) | undefined`.
    const enabled = el.isConnected;
    onMount(() => {
      if (enabled) {
        return () => {};
      }
    });
    onMount(() => {
      if (enabled) {
        return () => {
          el.textContent = "";
        };
      }
    }, el);

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
    // @ts-expect-error — async callbacks are not part of the supported onMount contract
    onMount(async () => {
      await Promise.resolve();
    }, el);
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

  it("defensively ignores unsupported non-function return values when the type system is bypassed", async () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    // Async callbacks are not part of the public `onMount()` type. These casts
    // intentionally bypass TypeScript to pin the defensive runtime behaviour:
    // a returned value that is not a function is never called as a cleanup.
    const asyncSetup = async (): Promise<void> => {};
    onMount(asyncSetup as unknown as () => void, el);
    onMount(() => 42 as unknown as undefined, el);
    await flush();
    expect(() => dispose(el)).not.toThrow();
  });
});
