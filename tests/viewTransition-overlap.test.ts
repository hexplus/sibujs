/**
 * `viewTransition()` overlapping-run state.
 *
 * WHAT WAS WRONG
 * --------------
 * `isTransitioning` was a plain boolean set true on entry and false in a
 * `finally`, which makes it a claim owned by whichever run settled LAST rather
 * than a description of the controller:
 *
 *     start A → pending
 *     start B → pending
 *     B finishes  →  isTransitioning() === false, while A is still running
 *
 * so any UI gated on the flag — a spinner, a pointer-events guard, a disabled
 * button — was dropped in the middle of a transition that was still going.
 *
 * The flag now aggregates: true from the first run's start, true while any run
 * is in flight, false exactly when the last one settles, in any order. Each
 * caller keeps its own promise semantics.
 *
 * Both modes are exercised: native (`document.startViewTransition`) and the
 * fallback that calls the callback directly.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { viewTransition } from "../src/ui/viewTransition";
import { createDeferred, type Deferred } from "./helpers/mocks";

function gate<T = void>(): Deferred<T> {
  const d = createDeferred<T>();
  d.promise.catch(() => {});
  return d;
}

function settle<T>(p: Promise<T>) {
  return p.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  );
}

/**
 * Install the requested mode.
 *
 * In native mode each `start()` gets its OWN `finished` deferred, so the test
 * controls which run settles first — the whole point of the exercise.
 */
function installMode(mode: "native" | "fallback"): { finished: Deferred<void>[] } {
  const finished: Deferred<void>[] = [];
  if (mode === "native") {
    vi.stubGlobal("document", {
      startViewTransition: (cb: () => void | Promise<void>) => {
        const d = gate();
        finished.push(d);
        // The real API runs the callback as part of starting the transition.
        // Its result feeds `finished`; a throw there rejects it.
        void (async () => {
          try {
            await cb();
            d.resolve();
          } catch (err) {
            d.reject(err);
          }
        })();
        return { finished: d.promise };
      },
    });
  } else {
    vi.stubGlobal("document", {});
  }
  return { finished };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

for (const mode of ["native", "fallback"] as const) {
  describe(`viewTransition (${mode}) — overlapping runs`, () => {
    it("1. A pending → B pending → B succeeds → A succeeds", async () => {
      installMode(mode);
      const a = gate();
      const b = gate();
      const queue = [a, b];
      const vt = viewTransition(() => queue.shift()?.promise);

      const pa = settle(vt.start());
      const pb = settle(vt.start());
      expect(vt.isTransitioning()).toBe(true);

      b.resolve();
      expect(await pb).toEqual({ ok: true, value: undefined });
      expect(vt.isTransitioning(), "the flag dropped while A was still running").toBe(true);

      a.resolve();
      expect(await pa).toEqual({ ok: true, value: undefined });
      expect(vt.isTransitioning()).toBe(false);
    });

    it("2. A pending → B pending → A succeeds → B succeeds", async () => {
      installMode(mode);
      const a = gate();
      const b = gate();
      const queue = [a, b];
      const vt = viewTransition(() => queue.shift()?.promise);

      const pa = settle(vt.start());
      const pb = settle(vt.start());

      a.resolve();
      await pa;
      expect(vt.isTransitioning()).toBe(true);

      b.resolve();
      await pb;
      expect(vt.isTransitioning()).toBe(false);
    });

    it("3. A rejects while B remains pending", async () => {
      installMode(mode);
      const a = gate();
      const b = gate();
      const queue = [a, b];
      const vt = viewTransition(() => queue.shift()?.promise);

      const pa = settle(vt.start());
      const pb = settle(vt.start());

      const boom = new Error("A failed");
      a.reject(boom);
      const ra = await pa;
      expect(ra.ok).toBe(false);
      expect(ra.ok === false && ra.error).toBe(boom);
      // A failure is a settlement, not a reset: B still owns the flag.
      expect(vt.isTransitioning()).toBe(true);

      b.resolve();
      expect((await pb).ok).toBe(true);
      expect(vt.isTransitioning()).toBe(false);
    });

    it("4. B rejects while A remains pending", async () => {
      installMode(mode);
      const a = gate();
      const b = gate();
      const queue = [a, b];
      const vt = viewTransition(() => queue.shift()?.promise);

      const pa = settle(vt.start());
      const pb = settle(vt.start());

      b.reject(new Error("B failed"));
      expect((await pb).ok).toBe(false);
      expect(vt.isTransitioning()).toBe(true);

      a.resolve();
      expect((await pa).ok).toBe(true);
      expect(vt.isTransitioning()).toBe(false);
    });

    it("5. both reject, and each caller gets its OWN error", async () => {
      installMode(mode);
      const a = gate();
      const b = gate();
      const queue = [a, b];
      const vt = viewTransition(() => queue.shift()?.promise);

      const pa = settle(vt.start());
      const pb = settle(vt.start());

      const errA = new Error("A");
      const errB = new Error("B");
      b.reject(errB);
      const rb = await pb;
      expect(vt.isTransitioning()).toBe(true);

      a.reject(errA);
      const ra = await pa;

      expect(ra.ok === false && ra.error).toBe(errA);
      expect(rb.ok === false && rb.error).toBe(errB);
      expect(vt.isTransitioning()).toBe(false);
    });

    it("6. a synchronous callback throw still settles the flag", async () => {
      installMode(mode);
      const boom = new Error("sync throw");
      let calls = 0;
      const gateA = gate();
      const vt = viewTransition(() => {
        calls++;
        if (calls === 1) return gateA.promise;
        throw boom;
      });

      const pa = settle(vt.start());
      const pb = settle(vt.start());

      const rb = await pb;
      expect(rb.ok).toBe(false);
      expect(rb.ok === false && rb.error).toBe(boom);
      expect(vt.isTransitioning(), "a sync throw cleared the flag for the other run").toBe(true);

      gateA.resolve();
      await pa;
      expect(vt.isTransitioning()).toBe(false);
    });

    it("9. state returns to false after every run settles, in either order", async () => {
      installMode(mode);
      for (const order of [
        [0, 1],
        [1, 0],
      ]) {
        const a = gate();
        const b = gate();
        const queue = [a, b];
        const vt = viewTransition(() => queue.shift()?.promise);
        const ps = [settle(vt.start()), settle(vt.start())];
        const gs = [a, b];

        gs[order[0]].resolve();
        await ps[order[0]];
        expect(vt.isTransitioning()).toBe(true);
        gs[order[1]].resolve();
        await ps[order[1]];
        expect(vt.isTransitioning()).toBe(false);
      }
    });

    it("8. the counter never goes below zero across many runs", async () => {
      installMode(mode);
      const gates = Array.from({ length: 6 }, () => gate());
      const queue = [...gates];
      const vt = viewTransition(() => queue.shift()?.promise);

      const promises = gates.map(() => settle(vt.start()));
      expect(vt.isTransitioning()).toBe(true);

      // Settle in a scrambled order, alternating success and failure.
      for (const i of [3, 0, 5, 1, 4]) {
        if (i % 2 === 0) gates[i].resolve();
        else gates[i].reject(new Error(`fail ${i}`));
        await promises[i];
        expect(vt.isTransitioning(), `flag dropped early after settling ${i}`).toBe(true);
      }
      gates[2].resolve();
      await promises[2];
      expect(vt.isTransitioning()).toBe(false);

      // A further run must still be able to turn it back on — which it cannot do
      // if the counter had been driven negative.
      const extra = gate();
      queue.push(extra);
      const p = settle(vt.start());
      expect(vt.isTransitioning()).toBe(true);
      extra.resolve();
      await p;
      expect(vt.isTransitioning()).toBe(false);
    });

    it("10. sequential runs each resolve independently", async () => {
      installMode(mode);
      const values: string[] = [];
      let n = 0;
      const vt = viewTransition(async () => {
        values.push(`run${++n}`);
      });

      await vt.start();
      expect(vt.isTransitioning()).toBe(false);
      await vt.start();
      expect(vt.isTransitioning()).toBe(false);
      expect(values).toEqual(["run1", "run2"]);
    });

    it("every start() invocation executes its own callback", async () => {
      installMode(mode);
      const callback = vi.fn(async () => {});
      const vt = viewTransition(callback);

      await Promise.all([vt.start(), vt.start(), vt.start()]);
      expect(callback).toHaveBeenCalledTimes(3);
      expect(vt.isTransitioning()).toBe(false);
    });

    it("no unhandled rejection escapes an overlapping failure", async () => {
      installMode(mode);
      const seen: unknown[] = [];
      const onUnhandled = (e: unknown) => seen.push(e);
      process.on("unhandledRejection", onUnhandled);
      try {
        const a = gate();
        const b = gate();
        const queue = [a, b];
        const vt = viewTransition(() => queue.shift()?.promise);

        const pa = settle(vt.start());
        const pb = settle(vt.start());
        a.reject(new Error("A"));
        b.reject(new Error("B"));
        await pa;
        await pb;
        await new Promise((r) => setTimeout(r, 0));
        expect(seen).toEqual([]);
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
    });
  });
}

describe("viewTransition (native) — finished rejection", () => {
  it("7. a rejected `finished` reaches the caller and settles the flag", async () => {
    // `finished` can reject independently of the callback — a skipped or
    // aborted transition. The wrapper must surface that, not swallow it.
    const finishedGates: Deferred<void>[] = [];
    vi.stubGlobal("document", {
      startViewTransition: (cb: () => void | Promise<void>) => {
        cb();
        const d = gate();
        finishedGates.push(d);
        return { finished: d.promise };
      },
    });

    const vt = viewTransition(() => {});
    const pa = settle(vt.start());
    const pb = settle(vt.start());
    expect(vt.isTransitioning()).toBe(true);

    const boom = new Error("transition skipped");
    finishedGates[1].reject(boom);
    const rb = await pb;
    expect(rb.ok === false && rb.error).toBe(boom);
    expect(vt.isTransitioning()).toBe(true);

    finishedGates[0].resolve();
    expect((await pa).ok).toBe(true);
    expect(vt.isTransitioning()).toBe(false);
  });
});
