import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { broadcast } from "../src/browser/broadcast";

// Node / jsdom BroadcastChannel implementations don't agree on how
// `addEventListener("message", ...)` is dispatched. Mock a minimal version so
// the test can exercise broadcast() semantics without runtime differences.

interface FakeBC extends EventTarget {
  postMessage: (data: unknown) => void;
  close: () => void;
  __channels: Set<FakeBC>;
}

class FakeBroadcastChannel extends EventTarget implements FakeBC {
  static registry = new Map<string, Set<FakeBroadcastChannel>>();
  readonly name: string;
  __channels: Set<FakeBC>;

  constructor(name: string) {
    super();
    this.name = name;
    let set = FakeBroadcastChannel.registry.get(name);
    if (!set) {
      set = new Set();
      FakeBroadcastChannel.registry.set(name, set);
    }
    set.add(this);
    this.__channels = set as unknown as Set<FakeBC>;
  }

  postMessage(data: unknown): void {
    for (const other of this.__channels) {
      if (other !== this) {
        other.dispatchEvent(new MessageEvent("message", { data }));
      }
    }
  }

  close(): void {
    this.__channels.delete(this);
  }
}

describe("broadcast", () => {
  let original: typeof BroadcastChannel | undefined;

  beforeEach(() => {
    original = globalThis.BroadcastChannel;
    (globalThis as { BroadcastChannel: unknown }).BroadcastChannel =
      FakeBroadcastChannel as unknown as typeof BroadcastChannel;
  });

  afterEach(() => {
    FakeBroadcastChannel.registry.clear();
    (globalThis as { BroadcastChannel: unknown }).BroadcastChannel = original;
  });

  it("sender does not receive its own message; other channel does", () => {
    const a = broadcast<{ n: number }>("bc-test");
    const b = broadcast<{ n: number }>("bc-test");

    a.post({ n: 42 });

    expect(a.last()).toBe(null);
    expect(b.last()).toEqual({ n: 42 });

    a.dispose();
    b.dispose();
  });

  it("dispose closes the channel without throwing", () => {
    const c = broadcast("bc-dispose");
    expect(() => c.dispose()).not.toThrow();
  });

  it("gracefully handles missing BroadcastChannel global", () => {
    const saved = globalThis.BroadcastChannel;
    vi.stubGlobal("BroadcastChannel", undefined);
    try {
      const c = broadcast("bc-missing");
      expect(c.last()).toBe(null);
      c.post("ignored");
      c.dispose();
    } finally {
      (globalThis as { BroadcastChannel: unknown }).BroadcastChannel = saved;
    }
  });
});
