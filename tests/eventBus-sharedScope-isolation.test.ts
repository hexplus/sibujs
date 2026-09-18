import { afterEach, describe, expect, it, vi } from "vitest";
import { type RuntimeErrorContext, setRuntimeErrorHandler } from "../src/core/errors";
import { createSharedScope } from "../src/platform/microfrontend";
import { eventBus } from "../src/ui/eventBus";

// ---------------------------------------------------------------------------
// eventBus().emit() and createSharedScope().set() isolate subscribers.
//
// THE DEFECT: both iterated the live listener Set and called user callbacks with
// no containment. One throwing listener aborted delivery for every later
// listener (and escaped to the caller), listeners added during delivery ran in
// the same dispatch, and a listener that kept adding listeners never let the
// dispatch finish.
//
// SNAPSHOT SEMANTICS: delivery walks the listeners registered when the dispatch
// starts. Listeners added during it wait for the next dispatch; listeners
// removed (or cleared) during it are skipped for the rest of it. A dispatch
// started from inside a listener completes before the outer one continues.
// Delivery tracks SUBSCRIPTIONS, not callbacks: the same function unsubscribed
// and re-subscribed mid-dispatch is a new subscription that waits for the next
// dispatch, and a stale unsubscribe handle cannot remove the newer one.
// ---------------------------------------------------------------------------

type Report = { error: unknown; context: RuntimeErrorContext };

function captureReports(): Report[] {
  const reports: Report[] = [];
  setRuntimeErrorHandler((error, context) => reports.push({ error, context }));
  return reports;
}

afterEach(() => {
  setRuntimeErrorHandler(null);
});

/** Adapts both APIs to one shape so every case runs against each. */
interface Channel {
  on: (cb: (value: number) => void) => () => void;
  send: (value: number) => void;
  clear?: () => void;
}

const CHANNELS: Array<{ name: string; make: () => Channel }> = [
  {
    name: "eventBus",
    make: () => {
      const bus = eventBus<{ update: number }>();
      return { on: (cb) => bus.on("update", cb), send: (v) => bus.emit("update", v), clear: () => bus.clear() };
    },
  },
  {
    name: "createSharedScope",
    make: () => {
      const scope = createSharedScope<{ count: number }>({ count: 0 });
      return { on: (cb) => scope.subscribe("count", cb), send: (v) => scope.set("count", v) };
    },
  },
];

for (const { name, make } of CHANNELS) {
  describe(`${name} subscriber isolation`, () => {
    it("a throwing listener does not block later listeners and is reported", () => {
      const reports = captureReports();
      const channel = make();
      const boom = new Error("broken subscriber");
      const before = vi.fn();
      const after = vi.fn();
      channel.on(before);
      channel.on(() => {
        throw boom;
      });
      channel.on(after);

      expect(() => channel.send(1)).not.toThrow();

      expect(before).toHaveBeenCalledWith(1);
      expect(after).toHaveBeenCalledWith(1);
      expect(reports).toHaveLength(1);
      expect(reports[0].error).toBe(boom);
      expect(reports[0].context.phase).toBe("event");
    });

    it("a listener added during delivery waits for the next event", () => {
      const channel = make();
      const later = vi.fn();
      let added = false;
      channel.on(() => {
        if (!added) {
          added = true;
          channel.on(later);
        }
      });

      channel.send(1);
      expect(later).not.toHaveBeenCalled();

      channel.send(2);
      expect(later).toHaveBeenCalledTimes(1);
      expect(later).toHaveBeenCalledWith(2);
    });

    it("a listener that adds listeners on every call cannot stall delivery", () => {
      const channel = make();
      let added = 0;
      const spawn = () => {
        if (added >= 1000) return;
        added++;
        channel.on(() => spawn());
      };
      channel.on(spawn);

      channel.send(1);

      expect(added).toBe(1);
    });

    it("a listener removed during delivery is skipped for the rest of it", () => {
      const channel = make();
      const removed = vi.fn();
      let unsubscribe: () => void = () => {};
      channel.on(() => unsubscribe());
      unsubscribe = channel.on(removed);

      channel.send(1);
      channel.send(2);

      expect(removed).not.toHaveBeenCalled();
    });

    it("the same callback removed and re-added during delivery waits for the next event", () => {
      const channel = make();
      const target = vi.fn();
      let unsubscribe: () => void = () => {};
      let swapped = false;
      channel.on(() => {
        if (swapped) return;
        swapped = true;
        unsubscribe();
        channel.on(target);
      });
      unsubscribe = channel.on(target);

      channel.send(1);
      expect(target).not.toHaveBeenCalled();

      channel.send(2);
      expect(target).toHaveBeenCalledTimes(1);
      expect(target).toHaveBeenCalledWith(2);
    });

    it("a stale unsubscribe handle does not remove a later subscription of the same callback", () => {
      const channel = make();
      const target = vi.fn();
      const oldUnsubscribe = channel.on(target);
      oldUnsubscribe();
      channel.on(target);

      oldUnsubscribe();
      channel.send(1);

      expect(target).toHaveBeenCalledTimes(1);
      expect(target).toHaveBeenCalledWith(1);
    });

    it("subscribing the same callback twice delivers once", () => {
      const channel = make();
      const target = vi.fn();
      channel.on(target);
      channel.on(target);

      channel.send(1);

      expect(target).toHaveBeenCalledTimes(1);
    });

    it("recursive dispatch completes before the outer dispatch continues", () => {
      const channel = make();
      const order: string[] = [];
      channel.on((v) => {
        order.push(`first:${v}`);
        if (v === 1) channel.send(2);
      });
      channel.on((v) => order.push(`second:${v}`));

      channel.send(1);

      expect(order).toEqual(["first:1", "first:2", "second:2", "second:1"]);
    });
  });
}

describe("eventBus clear() during delivery", () => {
  it("skips the remaining listeners of the current dispatch", () => {
    const bus = eventBus<{ update: number }>();
    const after = vi.fn();
    bus.on("update", () => bus.clear());
    bus.on("update", after);

    bus.emit("update", 1);

    expect(after).not.toHaveBeenCalled();
  });
});
