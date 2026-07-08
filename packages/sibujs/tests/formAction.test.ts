import { describe, expect, it } from "vitest";
import { formAction } from "../src/ui/formAction";

function _flush() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("formAction", () => {
  it("starts not pending, no error, no result", () => {
    const a = formAction(async () => "ok");
    expect(a.pending()).toBe(false);
    expect(a.error()).toBe(null);
    expect(a.result()).toBe(null);
  });

  it("resolves into result()", async () => {
    const a = formAction(async (x: number) => x * 2);
    await a.run(21);
    expect(a.result()).toBe(42);
    expect(a.pending()).toBe(false);
    expect(a.error()).toBe(null);
  });

  it("captures thrown errors into error()", async () => {
    const a = formAction(async () => {
      throw new Error("nope");
    });
    await a.run();
    expect(a.error()).toBeInstanceOf(Error);
    expect(a.result()).toBe(null);
  });

  it("pending() is true during an in-flight call", async () => {
    let resolveFn: (v: string) => void = () => {};
    const a = formAction(
      (() =>
        new Promise<string>((r) => {
          resolveFn = r;
        })) as () => Promise<string>,
    );
    const p = a.run();
    expect(a.pending()).toBe(true);
    resolveFn("done");
    await p;
    expect(a.pending()).toBe(false);
    expect(a.result()).toBe("done");
  });

  it("drops stale responses when a newer run starts", async () => {
    let resolveA: (v: string) => void = () => {};
    let resolveB: (v: string) => void = () => {};
    let call = 0;
    const a = formAction(() => {
      call++;
      return new Promise<string>((r) => {
        if (call === 1) resolveA = r;
        else resolveB = r;
      });
    });
    const first = a.run();
    const second = a.run();
    // Resolve the older call LAST — its result should be ignored.
    resolveB("newer");
    await second;
    expect(a.result()).toBe("newer");
    resolveA("older");
    await first;
    expect(a.result()).toBe("newer");
  });

  it("reset() clears result and error without affecting in-flight", async () => {
    const a = formAction(async () => "x");
    await a.run();
    expect(a.result()).toBe("x");
    a.reset();
    expect(a.result()).toBe(null);
    expect(a.error()).toBe(null);
  });
});
