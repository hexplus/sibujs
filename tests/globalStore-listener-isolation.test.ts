import { afterEach, describe, expect, it, vi } from "vitest";
import { type RuntimeErrorContext, setRuntimeErrorHandler } from "../src/core/errors";
import { globalStore } from "../src/patterns/globalStore";

// ---------------------------------------------------------------------------
// globalStore listener notification is isolated and snapshot-based.
//
// THE DEFECT: dispatch() and reset() committed state and then iterated the live
// listener Set with no exception isolation. One throwing listener made the call
// throw after the mutation had already landed, and every later listener missed
// the update. A listener subscribed during notification ran for the current
// update too — or, by subscribing repeatedly, kept iteration from terminating.
// ---------------------------------------------------------------------------

type Report = { error: unknown; context: RuntimeErrorContext };

function captureReports(): Report[] {
  const reports: Report[] = [];
  setRuntimeErrorHandler((error, context) => reports.push({ error, context }));
  return reports;
}

function makeStore() {
  return globalStore({
    state: { count: 0 },
    actions: {
      increment: (s: { count: number }) => ({ count: s.count + 1 }),
    },
  });
}

afterEach(() => {
  setRuntimeErrorHandler(null);
});

type Trigger = "dispatch" | "reset";
const run = (store: ReturnType<typeof makeStore>, trigger: Trigger) =>
  trigger === "dispatch" ? store.dispatch("increment") : store.reset();

for (const trigger of ["dispatch", "reset"] as Trigger[]) {
  describe(`${trigger}() listener notification`, () => {
    it("a throwing listener is reported and later listeners still receive the update", () => {
      const reports = captureReports();
      const store = makeStore();
      if (trigger === "reset") store.dispatch("increment");
      const boom = new Error("listener failed");
      const before = vi.fn();
      const after = vi.fn();
      store.subscribe(before);
      store.subscribe(() => {
        throw boom;
      });
      store.subscribe(after);

      expect(() => run(store, trigger)).not.toThrow();

      const expected = trigger === "dispatch" ? 1 : 0;
      expect(store.getState().count).toBe(expected);
      expect(before).toHaveBeenCalledTimes(1);
      expect(after).toHaveBeenCalledTimes(1);
      expect(after.mock.calls[0][0].count).toBe(expected);
      expect(reports).toHaveLength(1);
      expect(reports[0].error).toBe(boom);
    });

    it("a listener subscribed during notification waits for the next update", () => {
      const store = makeStore();
      const late = vi.fn();
      let added = false;
      store.subscribe(() => {
        if (!added) {
          added = true;
          store.subscribe(late);
        }
      });

      run(store, trigger);
      expect(late).not.toHaveBeenCalled();

      run(store, trigger);
      expect(late).toHaveBeenCalledTimes(1);
    });

    it("a listener that subscribes on every notification cannot stall delivery", () => {
      const store = makeStore();
      let added = 0;
      // Each listener subscribes another like itself. Capped so the pre-fix
      // behaviour (delivering to every newly added listener) fails instead of
      // hanging the run.
      const spawn = () => {
        if (added >= 1000) return;
        added++;
        // A fresh closure each time — the listener Set would dedupe `spawn`.
        store.subscribe(() => spawn());
      };
      store.subscribe(spawn);

      run(store, trigger);

      expect(added).toBe(1);
    });

    it("a listener unsubscribed by an earlier listener is not notified", () => {
      const store = makeStore();
      const removed = vi.fn();
      let unsubscribeRemoved: () => void = () => {};
      store.subscribe(() => unsubscribeRemoved());
      unsubscribeRemoved = store.subscribe(removed) as () => void;

      run(store, trigger);

      expect(removed).not.toHaveBeenCalled();
    });
  });
}
