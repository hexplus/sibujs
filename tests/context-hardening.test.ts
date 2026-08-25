/**
 * Context semantics — pinned, not accidental.
 *
 * SibuJS `context()` is an **application-global reactive value**. It is not
 * subtree-scoped and not SSR request-scoped. The name carries strong
 * expectations from React/Vue/Solid, so these tests document what it actually
 * does, including the cases where it must NOT be used.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { context } from "../src/core/rendering/context";
import { runInSSRContext } from "../src/core/ssr-context";

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe("context: core semantics", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the default value before anything is provided", () => {
    const Theme = context("light");
    expect(Theme.get()).toBe("light");
  });

  it("provide() sets the value and returns a restore handle", () => {
    const Theme = context("light");
    const restore = Theme.provide("dark");

    expect(Theme.get()).toBe("dark");
    restore();
    expect(Theme.get()).toBe("light");
  });

  it("exposes a reactive getter through use()", () => {
    const Theme = context("light");
    const read = Theme.use();

    expect(read()).toBe("light");
    Theme.set("dark");
    expect(read()).toBe("dark");
  });

  it("withContext scopes a synchronous callback and restores afterwards", () => {
    const Theme = context("light");
    const seen = Theme.withContext("dark", () => Theme.get());

    expect(seen).toBe("dark");
    expect(Theme.get()).toBe("light");
  });

  it("withContext restores even when the callback throws", () => {
    const Theme = context("light");

    expect(() =>
      Theme.withContext("dark", () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");

    expect(Theme.get()).toBe("light");
  });

  it("nests withContext calls and unwinds in order", () => {
    const Theme = context("default");
    const order: string[] = [];

    Theme.withContext("A", () => {
      order.push(Theme.get());
      Theme.withContext("B", () => {
        order.push(Theme.get());
      });
      order.push(Theme.get());
    });
    order.push(Theme.get());

    expect(order).toEqual(["A", "B", "A", "default"]);
  });
});

describe("context: documented limitations", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("CTX-002 — withContext does NOT scope across an await", async () => {
    const Theme = context("light");
    let seenAfterAwait: string | undefined;

    const done = Theme.withContext("dark", async () => {
      // Synchronous portion is scoped.
      expect(Theme.get()).toBe("dark");
      await Promise.resolve();
      // The `finally` restore already ran when the callback returned its
      // promise — the continuation is NOT scoped.
      seenAfterAwait = Theme.get();
    });

    await done;
    await settle();

    // DOCUMENTED: withContext is synchronous-only.
    expect(seenAfterAwait).toBe("light");
    expect(Theme.get()).toBe("light");
  });

  it("CTX-002 — concurrent async withContext calls interleave, not isolate", async () => {
    const Theme = context("none");
    const gateA = createDeferred<void>();
    const observed: Record<string, string> = {};

    const a = Theme.withContext("A", async () => {
      await gateA.promise;
      observed.a = Theme.get();
    });
    const b = Theme.withContext("B", async () => {
      observed.b = Theme.get();
    });

    await b;
    gateA.resolve();
    await a;

    // B's SYNCHRONOUS portion is correctly scoped...
    expect(observed.b).toBe("B");
    // ...but A's continuation, resumed after both scopes unwound, sees the
    // restored global value rather than "A". Async scopes do not nest or
    // isolate — the value is global.
    expect(observed.a).toBe("none");
  });

  it("CTX-001 — context is NOT isolated across concurrent SSR requests", async () => {
    const User = context("anonymous");
    const gateA = createDeferred<void>();
    const observed: Record<string, string> = {};

    const requestA = runInSSRContext(async () => {
      User.provide("Alice");
      observed.aBeforePark = User.get();
      await gateA.promise;
      observed.aAfterResume = User.get();
    });

    const requestB = runInSSRContext(async () => {
      User.provide("Bob");
      observed.b = User.get();
    });

    await requestB;
    gateA.resolve();
    await requestA;

    expect(observed.aBeforePark).toBe("Alice");
    expect(observed.b).toBe("Bob");
    // DOCUMENTED LIMITATION: request A observes request B's value. `context()`
    // lives outside AsyncLocalStorage, so it must never hold request-specific
    // SSR data. Use `runInSSRContext`-backed storage (e.g. the query cache) or
    // pass values explicitly instead. See docs/architecture/context.md.
    expect(observed.aAfterResume).toBe("Bob");
  });

  it("warns in development when context is provided during SSR", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const User = context("anonymous");

    await runInSSRContext(async () => {
      User.provide("Alice");
    });

    const messages = warn.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes("context"))).toBe(true);
  });

  it("does not warn for client-side use", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const Theme = context("light");

    Theme.provide("dark");
    Theme.set("system");
    Theme.withContext("dark", () => Theme.get());

    expect(warn).not.toHaveBeenCalled();
  });

  it("warns in development when withContext receives an async callback", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const Theme = context("light");

    const result = Theme.withContext("dark", async () => "done");

    const messages = warn.mock.calls.map((c) => String(c[0]));
    expect(messages.some((m) => m.includes("synchronous"))).toBe(true);
    return result;
  });
});
