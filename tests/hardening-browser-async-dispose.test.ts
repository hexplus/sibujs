/**
 * Browser-helper async ownership.
 *
 * INVARIANT: an async completion landing after dispose() must be a no-op —
 * no state mutation, no timer armed, no listener attached.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clipboard } from "../src/browser/clipboard";
import { permissions } from "../src/browser/permissions";

const originalNavigator = globalThis.navigator;

function installNavigator(value: unknown) {
  Object.defineProperty(globalThis, "navigator", { value, configurable: true, writable: true });
}

afterEach(() => {
  installNavigator(originalNavigator);
  // Real timers BEFORE restoring mocks: a `setTimeout` spy installed while fake
  // timers were active otherwise gets "restored" to the fake implementation and
  // leaks into the next test, which then hangs on a timer that never fires.
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("clipboard — completion after dispose", () => {
  let release!: () => void;
  let gate: Promise<void>;

  beforeEach(() => {
    gate = new Promise<void>((r) => {
      release = r;
    });
  });

  it("does not set text/copied when the write resolves after dispose", async () => {
    installNavigator({ clipboard: { writeText: () => gate } });

    const cb = clipboard();
    const pending = cb.copy("secret");
    cb.dispose();

    release();
    await pending;

    expect(cb.text()).toBe("");
    expect(cb.copied()).toBe(false);
  });

  it("does not arm the reset timer when the write resolves after dispose", async () => {
    // Counted through the fake-timer scheduler rather than a spy on the global
    // `setTimeout`: restoring such a spy while fake timers are installed leaks
    // the fake implementation into later tests.
    vi.useFakeTimers();
    installNavigator({ clipboard: { writeText: () => gate } });

    const cb = clipboard();
    const pending = cb.copy("secret");
    cb.dispose();

    release();
    await pending;

    expect(vi.getTimerCount()).toBe(0);
  });

  it("still works normally when alive", async () => {
    vi.useFakeTimers();
    installNavigator({ clipboard: { writeText: async () => {} } });

    const cb = clipboard();
    await cb.copy("hello");

    expect(cb.text()).toBe("hello");
    expect(cb.copied()).toBe(true);

    vi.advanceTimersByTime(2000);
    expect(cb.copied()).toBe(false);
    cb.dispose();
  });

  it("does not mutate state when a rejected write settles after dispose", async () => {
    let rejectGate!: (e: unknown) => void;
    const rejecting = new Promise<void>((_res, rej) => {
      rejectGate = rej;
    });
    installNavigator({ clipboard: { writeText: () => rejecting } });

    const cb = clipboard();
    const pending = cb.copy("secret").catch(() => {});
    cb.dispose();

    rejectGate(new Error("denied"));
    await pending;

    expect(cb.text()).toBe("");
    expect(cb.copied()).toBe(false);
  });

  it("is a no-op after dispose when copy() is called again", async () => {
    installNavigator({ clipboard: { writeText: async () => {} } });

    const cb = clipboard();
    cb.dispose();
    await cb.copy("late");

    expect(cb.text()).toBe("");
    expect(cb.copied()).toBe(false);
  });
});

describe("permissions — completion after dispose", () => {
  it("does not set unsupported when the query rejects after dispose", async () => {
    let rejectGate!: (e: unknown) => void;
    const query = new Promise((_res, rej) => {
      rejectGate = rej;
    });
    installNavigator({ permissions: { query: () => query } });

    const p = permissions("camera");
    expect(p.state()).toBe("prompt");

    p.dispose();
    rejectGate(new Error("nope"));
    await query.catch(() => {});
    await Promise.resolve();

    expect(p.state()).toBe("prompt");
  });

  it("does not set state when the query resolves after dispose", async () => {
    let resolveGate!: (v: unknown) => void;
    const query = new Promise((res) => {
      resolveGate = res;
    });
    installNavigator({ permissions: { query: () => query } });

    const p = permissions("camera");
    p.dispose();

    resolveGate({ state: "granted", addEventListener: () => {}, removeEventListener: () => {} });
    await query;
    await Promise.resolve();

    expect(p.state()).toBe("prompt");
  });

  it("still reports unsupported for a live rejection", async () => {
    installNavigator({ permissions: { query: async () => Promise.reject(new Error("nope")) } });

    const p = permissions("camera");
    await new Promise((r) => setTimeout(r, 0));

    expect(p.state()).toBe("unsupported");
    p.dispose();
  });

  it("still tracks a live query and its change events", async () => {
    const handlers = new Set<() => void>();
    const status = {
      state: "prompt",
      addEventListener: (_t: string, h: () => void) => handlers.add(h),
      removeEventListener: (_t: string, h: () => void) => handlers.delete(h),
    };
    installNavigator({ permissions: { query: async () => status } });

    const p = permissions("camera");
    await Promise.resolve();
    await Promise.resolve();

    expect(p.state()).toBe("prompt");
    status.state = "granted";
    for (const h of handlers) h();
    expect(p.state()).toBe("granted");

    p.dispose();
    expect(handlers.size).toBe(0);
  });
});
