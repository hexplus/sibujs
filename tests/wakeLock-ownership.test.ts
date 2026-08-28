/**
 * `wakeLock()` request ownership.
 *
 * WHAT WAS WRONG
 * --------------
 * A wake lock is a native handle, and the previous implementation kept exactly
 * one mutable reference to it with no record of which request that reference
 * belonged to:
 *
 *   - two overlapping requests acquired two sentinels; the second to arrive
 *     overwrote the first, and `release()` then released only the survivor. The
 *     other stayed held by the platform with no reference left to release it.
 *   - `release()` nulled the reference but did nothing about a request still in
 *     flight, so a sentinel arriving afterwards installed itself and the screen
 *     stayed awake after the caller had explicitly given the lock up.
 *   - the `release` listener called `setActive(false)` unconditionally, so an
 *     OLD sentinel being released by the platform cleared the state belonging to
 *     the current one.
 *
 * WHY EACH TEST BUILDS ITS OWN SENTINELS
 * --------------------------------------
 * Reusing one shared sentinel object across tests hides exactly this class of
 * bug: with one object there is nothing to confuse. Every test below creates
 * distinct, independently controllable sentinels and asserts, by identity, which
 * one was acquired and which one was released.
 *
 * THE MODEL UNDER TEST
 * --------------------
 * Concurrent `request()` calls share one in-flight acquisition, so the platform
 * is never asked for two sentinels at once. `release()` and `dispose()` revoke
 * the desire before awaiting anything, so a request already in flight is
 * superseded and discards its sentinel on arrival. Every sentinel this module
 * receives is therefore either the current one or released immediately.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { wakeLock } from "../src/browser/wakeLock";
import { setRuntimeErrorHandler } from "../src/core/errors";
import { createDeferred } from "./helpers/mocks";

interface FakeSentinel extends EventTarget {
  released: boolean;
  type: "screen";
  release(): Promise<void>;
  releaseCalls: number;
  label: string;
}

/** A sentinel that records its own release count and dispatches the event. */
function makeSentinel(label: string, options: { releaseRejects?: boolean } = {}): FakeSentinel {
  const s = new EventTarget() as FakeSentinel;
  s.released = false;
  s.type = "screen";
  s.releaseCalls = 0;
  s.label = label;
  s.release = async () => {
    s.releaseCalls++;
    if (options.releaseRejects) throw new Error(`release of ${label} failed`);
    s.released = true;
    s.dispatchEvent(new Event("release"));
  };
  return s;
}

function gate<T = void>() {
  const d = createDeferred<T>();
  d.promise.catch(() => {});
  return d;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Stub `navigator.wakeLock.request` to hand out the given promises in order. */
function stubWakeLock(queue: Promise<FakeSentinel>[]) {
  const request = vi.fn(() => {
    const next = queue.shift();
    if (!next) throw new Error("wakeLock.request called more times than the test provided sentinels");
    return next;
  });
  vi.stubGlobal("navigator", { wakeLock: { request } });
  return request;
}

afterEach(() => {
  vi.unstubAllGlobals();
  setRuntimeErrorHandler(null);
});

describe("wakeLock — concurrent acquisition", () => {
  it("1/2. overlapping requests share ONE native acquisition, so nothing can be orphaned", async () => {
    const s1 = makeSentinel("s1");
    const d1 = gate<FakeSentinel>();
    // A second sentinel is deliberately made available; the test asserts it is
    // never asked for, which is what makes an orphan structurally impossible.
    const request = stubWakeLock([d1.promise, Promise.resolve(makeSentinel("s2"))]);
    const lock = wakeLock();

    const pa = lock.request();
    const pb = lock.request();
    expect(request).toHaveBeenCalledTimes(1);

    d1.resolve(s1);
    await pa;
    await pb;

    expect(lock.active()).toBe(true);
    expect(request).toHaveBeenCalledTimes(1);

    await lock.release();
    expect(s1.releaseCalls).toBe(1);
    expect(lock.active()).toBe(false);
    lock.dispose();
  });

  it("a request while an unreleased sentinel is held is idempotent", async () => {
    const s1 = makeSentinel("s1");
    const request = stubWakeLock([Promise.resolve(s1), Promise.resolve(makeSentinel("s2"))]);
    const lock = wakeLock();

    await lock.request();
    expect(lock.active()).toBe(true);
    await lock.request();
    await lock.request();

    expect(request).toHaveBeenCalledTimes(1);
    expect(lock.active()).toBe(true);

    await lock.release();
    expect(s1.releaseCalls).toBe(1);
    lock.dispose();
  });

  it("request → release → request acquires a genuinely new sentinel", async () => {
    const s1 = makeSentinel("s1");
    const s2 = makeSentinel("s2");
    const request = stubWakeLock([Promise.resolve(s1), Promise.resolve(s2)]);
    const lock = wakeLock();

    await lock.request();
    await lock.release();
    await lock.request();

    expect(request).toHaveBeenCalledTimes(2);
    expect(lock.active()).toBe(true);
    expect(s1.releaseCalls).toBe(1);

    await lock.release();
    expect(s2.releaseCalls).toBe(1);
    lock.dispose();
  });
});

describe("wakeLock — release and dispose supersede a pending request", () => {
  it("3. pending request → release() → the arriving sentinel is discarded", async () => {
    const s = makeSentinel("s");
    const d = gate<FakeSentinel>();
    stubWakeLock([d.promise]);
    const lock = wakeLock();

    const p = lock.request();
    await lock.release();
    d.resolve(s);
    await p;
    await tick();

    expect(lock.active(), "a superseded request re-activated the lock").toBe(false);
    expect(s.releaseCalls, "the superseded sentinel was orphaned").toBe(1);
    lock.dispose();
  });

  it("4. pending request → dispose() → the arriving sentinel is discarded", async () => {
    const s = makeSentinel("s");
    const d = gate<FakeSentinel>();
    stubWakeLock([d.promise]);
    const lock = wakeLock();

    const p = lock.request();
    lock.dispose();
    d.resolve(s);
    await p;
    await tick();

    expect(lock.active()).toBe(false);
    expect(s.releaseCalls).toBe(1);
  });

  it("13. no state is published after disposal", async () => {
    const s = makeSentinel("s");
    const d = gate<FakeSentinel>();
    stubWakeLock([d.promise]);
    const lock = wakeLock();

    const writes: boolean[] = [];
    // Sampling `active()` after every await is enough: the only way a post-
    // disposal publication could be observed is as a change here.
    const p = lock.request();
    lock.dispose();
    writes.push(lock.active());
    d.resolve(s);
    await p;
    writes.push(lock.active());
    await tick();
    writes.push(lock.active());
    // A stale sentinel dispatching its own release event must publish nothing.
    s.dispatchEvent(new Event("release"));
    writes.push(lock.active());

    expect(writes).toEqual([false, false, false, false]);
  });

  it("11. repeated release() and dispose() calls are safe and idempotent", async () => {
    const s = makeSentinel("s");
    stubWakeLock([Promise.resolve(s)]);
    const lock = wakeLock();

    await lock.request();
    await lock.release();
    await lock.release();
    await lock.release();
    expect(s.releaseCalls, "release() released the sentinel more than once").toBe(1);

    lock.dispose();
    lock.dispose();
    lock.dispose();
    expect(s.releaseCalls).toBe(1);
    expect(lock.active()).toBe(false);
  });

  it("dispose() releases a currently held sentinel exactly once", async () => {
    const s = makeSentinel("s");
    stubWakeLock([Promise.resolve(s)]);
    const lock = wakeLock();

    await lock.request();
    expect(lock.active()).toBe(true);
    lock.dispose();
    await tick();

    expect(s.releaseCalls).toBe(1);
    expect(lock.active()).toBe(false);
  });

  it("request() after dispose() does nothing at all", async () => {
    const request = stubWakeLock([Promise.resolve(makeSentinel("s"))]);
    const lock = wakeLock();
    lock.dispose();

    await lock.request();
    expect(request).not.toHaveBeenCalled();
    expect(lock.active()).toBe(false);
  });
});

describe("wakeLock — sentinel events", () => {
  it("6. the current sentinel releasing itself clears active()", async () => {
    const s = makeSentinel("s");
    stubWakeLock([Promise.resolve(s)]);
    const lock = wakeLock();

    await lock.request();
    expect(lock.active()).toBe(true);

    // The platform releases it (tab hidden, power policy, …).
    await s.release();
    await tick();
    expect(lock.active()).toBe(false);
    lock.dispose();
  });

  it("7. a stale sentinel's release event cannot clear the current one's state", async () => {
    const s1 = makeSentinel("s1");
    const s2 = makeSentinel("s2");
    stubWakeLock([Promise.resolve(s1), Promise.resolve(s2)]);
    const lock = wakeLock();

    await lock.request();
    await lock.release();
    await lock.request();
    expect(lock.active(), "the second acquisition did not take effect").toBe(true);

    // s1 is long gone. A late or duplicated release event from it says nothing
    // about s2, which is the sentinel actually held.
    s1.dispatchEvent(new Event("release"));
    await tick();

    expect(lock.active(), "a stale sentinel's event cleared the current state").toBe(true);
    await lock.release();
    expect(s2.releaseCalls).toBe(1);
    lock.dispose();
  });

  it("12b. an overlapping release→request accounts for BOTH sentinels", async () => {
    // The strongest anti-orphan case: a superseded acquisition and its
    // replacement are in flight at the same time, so two native sentinels really
    // do exist simultaneously. Neither may be left held.
    const s1 = makeSentinel("s1");
    const s2 = makeSentinel("s2");
    const d1 = gate<FakeSentinel>();
    const d2 = gate<FakeSentinel>();
    const request = stubWakeLock([d1.promise, d2.promise]);
    const lock = wakeLock();

    const p1 = lock.request();
    await lock.release(); // supersedes p1 before it has a sentinel
    const p2 = lock.request(); // starts genuinely new work
    expect(request).toHaveBeenCalledTimes(2);

    // The superseded one arrives LAST, so it cannot rely on ordering to be safe.
    d2.resolve(s2);
    await p2;
    d1.resolve(s1);
    await p1;
    await tick();

    expect(s1.releaseCalls, "the superseded sentinel was orphaned").toBe(1);
    expect(lock.active(), "the superseded sentinel displaced the current one").toBe(true);

    await lock.release();
    expect(s2.releaseCalls).toBe(1);
    lock.dispose();
  });

  it("12. every acquired sentinel ends released", async () => {
    const acquired: FakeSentinel[] = [];
    const make = (label: string) => {
      const s = makeSentinel(label);
      acquired.push(s);
      return Promise.resolve(s);
    };
    stubWakeLock([make("s1"), make("s2"), make("s3")]);
    const lock = wakeLock();

    await lock.request();
    await lock.release();
    await lock.request();
    await lock.release();
    await lock.request();
    lock.dispose();
    await tick();

    expect(acquired).toHaveLength(3);
    for (const s of acquired) {
      expect(s.releaseCalls, `${s.label} was not released exactly once`).toBe(1);
    }
  });
});

describe("wakeLock — visibility re-acquisition", () => {
  it("8. re-acquires after the platform releases while the desire stands", async () => {
    const s1 = makeSentinel("s1");
    const s2 = makeSentinel("s2");
    const request = stubWakeLock([Promise.resolve(s1), Promise.resolve(s2)]);
    const lock = wakeLock();

    await lock.request();
    await s1.release(); // platform auto-release
    await tick();
    expect(lock.active()).toBe(false);

    document.dispatchEvent(new Event("visibilitychange"));
    await tick();
    await tick();

    expect(request).toHaveBeenCalledTimes(2);
    expect(lock.active()).toBe(true);
    await lock.release();
    lock.dispose();
  });

  it("8b. does NOT re-acquire after an explicit release()", async () => {
    const s1 = makeSentinel("s1");
    const request = stubWakeLock([Promise.resolve(s1)]);
    const lock = wakeLock();

    await lock.request();
    await lock.release();

    document.dispatchEvent(new Event("visibilitychange"));
    await tick();
    await tick();

    // The user gave the lock up; a tab switch must not undo that.
    expect(request).toHaveBeenCalledTimes(1);
    expect(lock.active()).toBe(false);
    lock.dispose();
  });

  it("8c. visibility re-acquisition overlapping a manual request shares one acquisition", async () => {
    const s1 = makeSentinel("s1");
    const s2 = makeSentinel("s2");
    const d2 = gate<FakeSentinel>();
    const request = stubWakeLock([Promise.resolve(s1), d2.promise, Promise.resolve(makeSentinel("s3"))]);
    const lock = wakeLock();

    await lock.request();
    await s1.release();
    await tick();

    // A manual request and a visibility re-acquire race each other.
    const manual = lock.request();
    document.dispatchEvent(new Event("visibilitychange"));
    await tick();

    expect(request, "the two racing requests acquired two sentinels").toHaveBeenCalledTimes(2);

    d2.resolve(s2);
    await manual;
    await tick();

    expect(lock.active()).toBe(true);
    await lock.release();
    expect(s2.releaseCalls).toBe(1);
    lock.dispose();
  });

  it("removes its visibility listener on dispose", async () => {
    const s1 = makeSentinel("s1");
    const request = stubWakeLock([Promise.resolve(s1)]);
    const lock = wakeLock();

    await lock.request();
    lock.dispose();
    await tick();

    document.dispatchEvent(new Event("visibilitychange"));
    await tick();
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe("wakeLock — failure paths", () => {
  it("10. a rejecting request leaves consistent state and reports once", async () => {
    const reported: Array<{ phase: string; name?: string }> = [];
    setRuntimeErrorHandler((_e, ctx) => reported.push({ phase: ctx.phase, name: ctx.name }));

    const boom = new Error("request denied");
    stubWakeLock([Promise.reject(boom)]);
    const lock = wakeLock();

    await lock.request();
    await tick();

    expect(lock.active()).toBe(false);
    expect(reported).toEqual([{ phase: "async", name: "wakeLock(request)" }]);
    lock.dispose();
  });

  it("a rejecting request can be retried", async () => {
    setRuntimeErrorHandler(() => {});
    const s = makeSentinel("s");
    const request = stubWakeLock([Promise.reject(new Error("denied")), Promise.resolve(s)]);
    const lock = wakeLock();

    await lock.request();
    expect(lock.active()).toBe(false);

    await lock.request();
    expect(request).toHaveBeenCalledTimes(2);
    expect(lock.active()).toBe(true);
    await lock.release();
    lock.dispose();
  });

  it("9. a rejecting release propagates to the caller and still clears state", async () => {
    const s = makeSentinel("s", { releaseRejects: true });
    stubWakeLock([Promise.resolve(s)]);
    const lock = wakeLock();

    await lock.request();
    expect(lock.active()).toBe(true);

    await expect(lock.release()).rejects.toThrow("release of s failed");
    // State is cleared BEFORE awaiting the native release, so a rejecting
    // release cannot leave the controller believing it still holds a lock.
    expect(lock.active()).toBe(false);
    lock.dispose();
  });

  it("9b. a rejecting release during dispose is reported, not thrown", async () => {
    const reported: Array<{ name?: string }> = [];
    setRuntimeErrorHandler((_e, ctx) => reported.push({ name: ctx.name }));

    const s = makeSentinel("s", { releaseRejects: true });
    stubWakeLock([Promise.resolve(s)]);
    const lock = wakeLock();

    await lock.request();
    expect(() => lock.dispose()).not.toThrow();
    await tick();

    expect(lock.active()).toBe(false);
    expect(reported).toEqual([{ name: "wakeLock(dispose release)" }]);
  });

  it("9c. a rejecting release of a discarded sentinel is reported, not thrown", async () => {
    const reported: Array<{ name?: string }> = [];
    setRuntimeErrorHandler((_e, ctx) => reported.push({ name: ctx.name }));

    const s = makeSentinel("s", { releaseRejects: true });
    const d = gate<FakeSentinel>();
    stubWakeLock([d.promise]);
    const lock = wakeLock();

    const p = lock.request();
    await lock.release();
    d.resolve(s);
    await p;
    await tick();

    expect(s.releaseCalls).toBe(1);
    expect(reported).toEqual([{ name: "wakeLock(discard)" }]);
    lock.dispose();
  });

  it("14. no unhandled rejection escapes any path", async () => {
    setRuntimeErrorHandler(() => {});
    const seen: unknown[] = [];
    const onUnhandled = (e: unknown) => seen.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const s = makeSentinel("s", { releaseRejects: true });
      const d = gate<FakeSentinel>();
      stubWakeLock([Promise.reject(new Error("denied")), d.promise]);
      const lock = wakeLock();

      await lock.request(); // rejects internally
      const p = lock.request();
      await lock.release(); // supersedes it
      d.resolve(s); // …and the discarded sentinel's release rejects
      await p;
      lock.dispose();
      await tick();
      await tick();

      expect(seen).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("degrades gracefully without the API", async () => {
    vi.stubGlobal("navigator", {});
    const lock = wakeLock();
    await lock.request();
    expect(lock.active()).toBe(false);
    await lock.release();
    expect(() => lock.dispose()).not.toThrow();
  });
});
