import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { transition } from "../src/reactivity/concurrent";

// ---------------------------------------------------------------------------
// Overlapping transition.start() calls keep pending() true until ALL settle.
//
// THE DEFECT: every start() set pending to true, and each body independently
// reset it to false when that one operation finished. With two transitions in
// flight, the first to settle cleared pending() while the second was still
// running; a synchronous first body could clear it before the second body had
// even started, and nothing restored it.
// ---------------------------------------------------------------------------

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Rejections are asserted through pending(); keep them from surfacing as unhandled.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

/** Run scheduled bodies, then let promise reactions settle. */
async function runScheduled(): Promise<void> {
  vi.advanceTimersByTime(100);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("transition() with overlapping starts", () => {
  it("two deferred transitions: first settles first", async () => {
    const t = transition();
    const a = deferred();
    const b = deferred();
    t.start(() => a.promise);
    t.start(() => b.promise);
    await runScheduled();
    expect(t.pending()).toBe(true);

    a.resolve();
    await settle();
    expect(t.pending()).toBe(true);

    b.resolve();
    await settle();
    expect(t.pending()).toBe(false);
  });

  it("two deferred transitions: second settles first", async () => {
    const t = transition();
    const a = deferred();
    const b = deferred();
    t.start(() => a.promise);
    t.start(() => b.promise);
    await runScheduled();

    b.resolve();
    await settle();
    expect(t.pending()).toBe(true);

    a.resolve();
    await settle();
    expect(t.pending()).toBe(false);
  });

  it("a synchronous first body does not clear pending() for a deferred second", async () => {
    const t = transition();
    const b = deferred();
    t.start(() => {});
    t.start(() => b.promise);

    await runScheduled();
    expect(t.pending()).toBe(true);

    b.resolve();
    await settle();
    expect(t.pending()).toBe(false);
  });

  it("a synchronous first body leaves pending() true until the second body has run", () => {
    const t = transition();
    const seenBySecond: boolean[] = [];
    t.start(() => {});
    t.start(() => {
      // Recorded rather than asserted: a throw here would be swallowed by start().
      seenBySecond.push(t.pending());
    });

    vi.advanceTimersByTime(100);
    expect(seenBySecond).toEqual([true]);
    expect(t.pending()).toBe(false);
  });

  it("a rejection does not clear pending() while another transition is in flight", async () => {
    const t = transition();
    const a = deferred();
    const b = deferred();
    t.start(() => a.promise);
    t.start(() => b.promise);
    await runScheduled();

    a.reject(new Error("first failed"));
    await settle();
    expect(t.pending()).toBe(true);

    b.resolve();
    await settle();
    expect(t.pending()).toBe(false);
  });

  it("a resolved transition does not clear pending() while a rejecting one is in flight", async () => {
    const t = transition();
    const a = deferred();
    const b = deferred();
    t.start(() => a.promise);
    t.start(() => b.promise);
    await runScheduled();

    a.resolve();
    await settle();
    expect(t.pending()).toBe(true);

    b.reject(new Error("second failed"));
    await settle();
    expect(t.pending()).toBe(false);
  });

  it("a throwing body does not clear pending() for a deferred one", async () => {
    const t = transition();
    const b = deferred();
    t.start(() => {
      throw new Error("sync failure");
    });
    t.start(() => b.promise);
    await runScheduled();
    expect(t.pending()).toBe(true);

    b.resolve();
    await settle();
    expect(t.pending()).toBe(false);
  });

  it("pending() stays accurate across a later round of transitions", async () => {
    const t = transition();
    t.start(() => {});
    t.start(() => {});
    await runScheduled();
    expect(t.pending()).toBe(false);

    const c = deferred();
    t.start(() => c.promise);
    expect(t.pending()).toBe(true);
    await runScheduled();
    expect(t.pending()).toBe(true);
    c.resolve();
    await settle();
    expect(t.pending()).toBe(false);
  });
});
