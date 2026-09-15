import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { broadcast } from "../src/browser/broadcast";

// ---------------------------------------------------------------------------
// broadcast() is inert after dispose().
//
// THE DEFECT: dispose() closed the native channel, but the returned `post()`
// kept calling it, so a retained callback started throwing the browser's
// InvalidStateError after its owner was disposed.
//
// CONTRACT: after dispose(), post() is a no-op, `last()` no longer changes, and
// dispose() may be called any number of times. Before disposal, post() errors
// (e.g. a DataCloneError) still propagate and do not end the channel's life.
// ---------------------------------------------------------------------------

/** A BroadcastChannel stub that behaves like the native one once closed. */
class StrictChannel extends EventTarget {
  static registry = new Map<string, Set<StrictChannel>>();
  closed = false;
  closeCalls = 0;
  posted: unknown[] = [];

  constructor(readonly name: string) {
    super();
    let peers = StrictChannel.registry.get(name);
    if (!peers) {
      peers = new Set();
      StrictChannel.registry.set(name, peers);
    }
    peers.add(this);
  }

  postMessage(data: unknown): void {
    if (this.closed) throw new DOMException("Channel is closed", "InvalidStateError");
    if (typeof data === "function") throw new DOMException("could not be cloned", "DataCloneError");
    this.posted.push(data);
    for (const peer of StrictChannel.registry.get(this.name) ?? []) {
      if (peer !== this && !peer.closed) peer.dispatchEvent(new MessageEvent("message", { data }));
    }
  }

  close(): void {
    this.closeCalls++;
    this.closed = true;
    StrictChannel.registry.get(this.name)?.delete(this);
  }
}

let original: typeof BroadcastChannel | undefined;
const created: StrictChannel[] = [];

beforeEach(() => {
  original = globalThis.BroadcastChannel;
  created.length = 0;
  (globalThis as { BroadcastChannel: unknown }).BroadcastChannel = class extends StrictChannel {
    constructor(name: string) {
      super(name);
      created.push(this);
    }
  } as unknown as typeof BroadcastChannel;
});

afterEach(() => {
  StrictChannel.registry.clear();
  (globalThis as { BroadcastChannel: unknown }).BroadcastChannel = original;
});

describe("broadcast after dispose()", () => {
  it("post() is a no-op instead of throwing", () => {
    const channel = broadcast<{ id: number }>("updates");
    channel.dispose();

    expect(() => channel.post({ id: 1 })).not.toThrow();
    expect(created[0].posted).toEqual([]);
  });

  it("dispose() can be called repeatedly and closes the channel once", () => {
    const channel = broadcast("updates");
    channel.dispose();
    channel.dispose();
    channel.dispose();

    expect(created[0].closeCalls).toBe(1);
  });

  it("no messages arrive and last() does not change after disposal", () => {
    const receiver = broadcast<number>("updates");
    const sender = broadcast<number>("updates");
    sender.post(1);
    expect(receiver.last()).toBe(1);

    receiver.dispose();
    sender.post(2);

    expect(receiver.last()).toBe(1);
    sender.dispose();
  });

  it("a structured-clone error before disposal still propagates and leaves the channel usable", () => {
    const receiver = broadcast<unknown>("updates");
    const sender = broadcast<unknown>("updates");

    expect(() => sender.post(() => {})).toThrow("could not be cloned");

    sender.post("after");
    expect(receiver.last()).toBe("after");

    sender.dispose();
    expect(() => sender.post("late")).not.toThrow();
    receiver.dispose();
  });
});
