// Production-mode coverage pass.
//
// Most source modules cache `const _isDev = isDev()` at load time. In the
// normal test run that is `true`, so production-only code paths (e.g. the
// no-dev-hook signal setter, `strictEffect`'s `!isDev()` early return) are
// never executed. Vitest isolates each test file's module registry, so by
// setting `__SIBU_DEV__ = false` BEFORE the first dynamic import here, the
// source loads fresh in production mode for this file only — covering those
// branches without affecting any other test.
//
// Source is loaded via dynamic `import()` inside the tests so the global is
// already set when the module evaluates (static imports would hoist above it).
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const g = globalThis as Record<string, unknown>;
let prevDev: unknown;

beforeAll(() => {
  prevDev = g.__SIBU_DEV__;
  g.__SIBU_DEV__ = false;
});

afterAll(() => {
  if (prevDev === undefined) delete g.__SIBU_DEV__;
  else g.__SIBU_DEV__ = prevDev;
});

describe("production-mode signal setter", () => {
  it("uses the no-dev-hook setter and still notifies + supports updater fns", async () => {
    const { signal } = await import("../src/core/signals/signal");
    const { effect } = await import("../src/core/signals/effect");
    const { isDev } = await import("../src/core/dev");
    expect(isDev()).toBe(false); // confirm we are in production mode

    const [v, setV] = signal(0);
    let last = -1;
    effect(() => {
      last = v();
    });
    setV(5); // direct value
    expect(last).toBe(5);
    setV((n) => n + 1); // updater function branch
    expect(last).toBe(6);
    setV(6); // Object.is equal → no-op (early return)
    expect(last).toBe(6);
  });

  it("custom-equals setter works without dev hooks", async () => {
    const { signal } = await import("../src/core/signals/signal");
    const [v, setV] = signal({ n: 1 }, { equals: (a, b) => a.n === b.n });
    setV({ n: 1 }); // equal → suppressed
    expect(v().n).toBe(1);
    setV({ n: 2 });
    expect(v().n).toBe(2);
  });
});

describe("production-mode strict helpers", () => {
  it("strict() runs fn once and does NOT schedule a second run", async () => {
    const { strict } = await import("../src/core/strict");
    let calls = 0;
    strict(() => {
      calls++;
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(1); // no dev double-invoke
  });

  it("strictEffect() returns a plain effect in production", async () => {
    const { strictEffect } = await import("../src/core/strict");
    const { signal } = await import("../src/core/signals/signal");
    const [v, setV] = signal(0);
    let runs = 0;
    const stop = strictEffect(() => {
      v();
      runs++;
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(runs).toBe(1); // single effect, no double-run
    setV(1);
    expect(runs).toBe(2);
    stop();
  });
});

describe("production-mode dev helpers are no-ops", () => {
  it("devAssert does not throw and devWarn does not warn in production", async () => {
    const { devAssert, devWarn } = await import("../src/core/dev");
    expect(() => devAssert(false, "should be ignored in prod")).not.toThrow();
    expect(() => devWarn("ignored")).not.toThrow();
  });
});
