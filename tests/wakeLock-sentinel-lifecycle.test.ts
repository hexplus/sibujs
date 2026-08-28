/**
 * `wakeLock()` — a sentinel that is already dead, or dies while being wired up.
 *
 * WHAT WAS WRONG
 * --------------
 * After `navigator.wakeLock.request()` resolved, the sentinel was installed and
 * `active(true)` published unconditionally. Neither `sentinel.released` nor the
 * window between checking it and attaching the release listener was considered,
 * so a sentinel the platform had already released was reported as a held lock:
 *
 *     request() resolves with { released: true, … }
 *       →  active() === true
 *
 * which directly contradicts the invariant the controller documents — `active()`
 * is true exactly when a current, UNRELEASED sentinel is held. Retaining it is
 * worse than the wrong flag: `request()` treats a held sentinel as idempotent,
 * so the controller would refuse to acquire a live replacement and the screen
 * would never actually stay awake.
 *
 * The acquisition now checks `released`, attaches the listener, re-checks
 * `released` (a release in that gap fires with nobody subscribed, so nothing
 * would ever arrive to correct the state), and only then assigns `current` and
 * publishes.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { wakeLock } from "../src/browser/wakeLock";
import { setRuntimeErrorHandler } from "../src/core/errors";
import { createDeferred, type Deferred } from "./helpers/mocks";

interface FakeSentinel extends EventTarget {
  released: boolean;
  type: "screen";
  release(): Promise<void>;
  releaseCalls: number;
  label: string;
}

interface SentinelOptions {
  /** Already released when the request resolves. */
  bornDead?: boolean;
  /** Flip `released` the moment `addEventListener` is called. */
  dieOnListen?: boolean;
  /** Dispatch a `release` event the moment `addEventListener` is called. */
  fireOnListen?: boolean;
  /** Make `addEventListener` throw. */
  listenThrows?: boolean;
}

function makeSentinel(label: string, options: SentinelOptions = {}): FakeSentinel {
  const s = new EventTarget() as FakeSentinel;
  s.released = options.bornDead === true;
  s.type = "screen";
  s.releaseCalls = 0;
  s.label = label;
  s.release = async () => {
    s.releaseCalls++;
    s.released = true;
    s.dispatchEvent(new Event("release"));
  };

  if (options.dieOnListen || options.fireOnListen || options.listenThrows) {
    const nativeAdd = s.addEventListener.bind(s);
    s.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject) => {
      if (options.listenThrows) throw new Error(`addEventListener failed for ${label}`);
      nativeAdd(type, listener);
      if (options.fireOnListen) {
        s.released = true;
        s.dispatchEvent(new Event("release"));
      } else if (options.dieOnListen) {
        // Released with NO event — the worst case, because nothing will ever
        // arrive later to correct the state.
        s.released = true;
      }
    }) as typeof s.addEventListener;
  }
  return s;
}

function gate<T = void>(): Deferred<T> {
  const d = createDeferred<T>();
  d.promise.catch(() => {});
  return d;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

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

describe("wakeLock — a sentinel that is already released", () => {
  it("never reports active for a sentinel released before the promise resolves", async () => {
    const dead = makeSentinel("dead", { bornDead: true });
    stubWakeLock([Promise.resolve(dead)]);
    const lock = wakeLock();

    await lock.request();

    expect(lock.active()).toBe(false);
    // Nothing to give back — it is already released, so no orphan and no
    // pointless native call.
    expect(dead.releaseCalls).toBe(0);
    lock.dispose();
  });

  it("does not retain a dead sentinel, so the next request acquires a live one", async () => {
    const dead = makeSentinel("dead", { bornDead: true });
    const live = makeSentinel("live");
    const request = stubWakeLock([Promise.resolve(dead), Promise.resolve(live)]);
    const lock = wakeLock();

    await lock.request();
    expect(lock.active()).toBe(false);

    // If the dead sentinel had been retained, `request()` would treat the
    // controller as already holding a lock and refuse to try again.
    await lock.request();
    expect(request).toHaveBeenCalledTimes(2);
    expect(lock.active()).toBe(true);

    await lock.release();
    expect(live.releaseCalls).toBe(1);
    lock.dispose();
  });

  it("never reports active when the sentinel dies during listener installation", async () => {
    const s = makeSentinel("dies-on-listen", { dieOnListen: true });
    stubWakeLock([Promise.resolve(s)]);
    const lock = wakeLock();

    await lock.request();

    // The release happened with nobody subscribed, so only the re-check after
    // attaching can notice it.
    expect(lock.active()).toBe(false);
    lock.dispose();
  });

  it("never reports active when the release EVENT fires during listener installation", async () => {
    const s = makeSentinel("fires-on-listen", { fireOnListen: true });
    stubWakeLock([Promise.resolve(s)]);
    const lock = wakeLock();

    await lock.request();

    // The event fired before `current` was assigned, so the listener no-opped;
    // the re-check is what catches it.
    expect(lock.active()).toBe(false);
    lock.dispose();
  });

  it("a sentinel released immediately AFTER acquisition still clears active", async () => {
    const s = makeSentinel("s");
    stubWakeLock([Promise.resolve(s)]);
    const lock = wakeLock();

    await lock.request();
    expect(lock.active()).toBe(true);

    await s.release();
    await tick();
    expect(lock.active()).toBe(false);
    lock.dispose();
  });

  it("a stale dead sentinel's event cannot disturb a newer live one", async () => {
    const dead = makeSentinel("dead", { bornDead: true });
    const live = makeSentinel("live");
    stubWakeLock([Promise.resolve(dead), Promise.resolve(live)]);
    const lock = wakeLock();

    await lock.request();
    await lock.request();
    expect(lock.active()).toBe(true);

    dead.dispatchEvent(new Event("release"));
    await tick();
    expect(lock.active(), "a sentinel that was never held cleared the current state").toBe(true);

    await lock.release();
    expect(live.releaseCalls).toBe(1);
    lock.dispose();
  });

  it("dispose during the acquisition still supersedes a dead sentinel", async () => {
    const dead = makeSentinel("dead", { bornDead: true });
    const d = gate<FakeSentinel>();
    stubWakeLock([d.promise]);
    const lock = wakeLock();

    const p = lock.request();
    lock.dispose();
    d.resolve(dead);
    await p;
    await tick();

    expect(lock.active()).toBe(false);
  });

  it("release during the acquisition still supersedes a dead sentinel", async () => {
    const dead = makeSentinel("dead", { bornDead: true });
    const d = gate<FakeSentinel>();
    stubWakeLock([d.promise]);
    const lock = wakeLock();

    const p = lock.request();
    await lock.release();
    d.resolve(dead);
    await p;
    await tick();

    expect(lock.active()).toBe(false);
    lock.dispose();
  });
});

describe("wakeLock — listener registration failure", () => {
  it("releases the live sentinel, reports, and leaves consistent state", async () => {
    const reported: Array<{ phase: string; name?: string }> = [];
    setRuntimeErrorHandler((_e, ctx) => reported.push({ phase: ctx.phase, name: ctx.name }));

    const s = makeSentinel("unlistenable", { listenThrows: true });
    stubWakeLock([Promise.resolve(s)]);
    const lock = wakeLock();

    await lock.request();
    await tick();

    expect(lock.active()).toBe(false);
    // We could never learn when it died, so it is given back rather than held.
    expect(s.releaseCalls, "an untrackable sentinel was retained").toBe(1);
    expect(reported).toEqual([{ phase: "async", name: "wakeLock(listener registration)" }]);
    lock.dispose();
  });

  it("a later request can still acquire after a registration failure", async () => {
    setRuntimeErrorHandler(() => {});
    const bad = makeSentinel("bad", { listenThrows: true });
    const good = makeSentinel("good");
    const request = stubWakeLock([Promise.resolve(bad), Promise.resolve(good)]);
    const lock = wakeLock();

    await lock.request();
    expect(lock.active()).toBe(false);

    await lock.request();
    expect(request).toHaveBeenCalledTimes(2);
    expect(lock.active()).toBe(true);

    await lock.release();
    expect(good.releaseCalls).toBe(1);
    lock.dispose();
  });

  it("no unhandled rejection escapes any of these paths", async () => {
    setRuntimeErrorHandler(() => {});
    const seen: unknown[] = [];
    const onUnhandled = (e: unknown) => seen.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const dead = makeSentinel("dead", { bornDead: true });
      const unlistenable = makeSentinel("unlistenable", { listenThrows: true });
      const live = makeSentinel("live");
      stubWakeLock([Promise.resolve(dead), Promise.resolve(unlistenable), Promise.resolve(live)]);
      const lock = wakeLock();

      await lock.request();
      await lock.request();
      await lock.request();
      lock.dispose();
      await tick();
      await tick();

      expect(seen).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
