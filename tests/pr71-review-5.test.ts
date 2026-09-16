import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setRuntimeErrorHandler } from "../src/core/errors";
import { globalStore } from "../src/patterns/globalStore";
import { socket } from "../src/ui/socket";

let handler: ReturnType<typeof vi.fn>;
beforeEach(() => {
  handler = vi.fn();
  setRuntimeErrorHandler(handler);
});
afterEach(() => {
  setRuntimeErrorHandler(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

type Count = { count: number };
const make = () =>
  globalStore({
    state: { count: 0 },
    actions: {
      inc: (state: Count) => ({ count: state.count + 1 }),
      set: (_state: Count, value: number) => ({ count: value }),
    },
  });

// ---------------------------------------------------------------------------
// 1. Reentrant operations are queued: callback state always equals getState().
// ---------------------------------------------------------------------------
describe("globalStore queued reentrant operations", () => {
  for (const position of [0, 1, 2]) {
    it(`a nested dispatch from listener ${position} keeps every callback consistent with getState()`, () => {
      const store = make();
      const seen: [number, number][] = [];
      for (let i = 0; i < 3; i++) {
        store.subscribe((state) => {
          seen.push([state.count, store.getState().count]);
          if (i === position && state.count === 1) store.dispatch("inc");
        });
      }
      store.dispatch("inc");

      expect(seen.every(([callback, current]) => callback === current)).toBe(true);
      expect(seen.map(([callback]) => callback)).toEqual([1, 1, 1, 2, 2, 2]);
      expect(store.getState().count).toBe(2);
    });
  }

  it("nested reset/dispatch combinations commit in call order", () => {
    const store = make();
    const rounds: number[] = [];
    let fired = false;
    store.subscribe((state) => {
      expect(state.count).toBe(store.getState().count);
      if (!fired) {
        fired = true;
        store.reset();
        store.dispatch("set", 5);
        store.reset();
      }
    });
    store.subscribe((state) => rounds.push(state.count));
    store.dispatch("inc");
    expect(rounds).toEqual([1, 0, 5, 0]);
  });

  it("recursively queued operations preserve commit order", () => {
    const store = make();
    const rounds: number[] = [];
    store.subscribe((state) => {
      expect(state.count).toBe(store.getState().count);
      // Each round queues the next one until 4; FIFO order must stay monotonic.
      if (state.count > 0 && state.count < 4) {
        store.dispatch("inc");
      }
    });
    store.subscribe((state) => rounds.push(state.count));
    store.dispatch("inc");
    expect(rounds).toEqual([1, 2, 3, 4]);
  });

  it("an operation queued from an action or middleware also waits for the current one", () => {
    const seen: [string, number, number][] = [];
    const store = globalStore({
      state: { count: 0 },
      actions: { inc: (state: Count) => ({ count: state.count + 1 }) },
      middleware: [
        (state, action, _payload, next) => {
          next();
          if (state.count === 0) store.dispatch("inc");
          seen.push([action, state.count, store.getState().count]);
        },
      ],
    });
    store.subscribe((state) => expect(state.count).toBe(store.getState().count));
    store.dispatch("inc");
    expect(store.getState().count).toBe(2);
    expect(seen[0]).toEqual(["inc", 0, 1]);
  });

  it("a listener exception does not prevent queued operations", () => {
    const store = make();
    store.subscribe((state) => {
      if (state.count === 1) {
        store.dispatch("inc");
        throw new Error("listener failed");
      }
    });
    store.dispatch("inc");
    expect(store.getState().count).toBe(2);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("the caller's own failing action still throws; a queued failing action is reported", () => {
    const store = globalStore({
      state: { count: 0 },
      actions: {
        inc: (state: Count) => ({ count: state.count + 1 }),
        boom: (): Partial<Count> => {
          throw new Error("action failed");
        },
      },
    });
    expect(() => store.dispatch("boom")).toThrow("action failed");

    store.subscribe((state) => {
      if (state.count === 1) store.dispatch("boom");
    });
    expect(() => store.dispatch("inc")).not.toThrow();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({ message: "action failed" });
  });
});

// ---------------------------------------------------------------------------
// 2. Subscriptions are records: re-subscribing during a round starts next update.
// ---------------------------------------------------------------------------
describe("globalStore subscription records", () => {
  it("removing and re-adding a callback before its turn skips the current round", () => {
    const store = make();
    const seen: number[] = [];
    const listener = (state: Count) => seen.push(state.count);
    let unsubscribe = () => {};
    store.subscribe((state) => {
      if (state.count === 1) {
        unsubscribe();
        unsubscribe = store.subscribe(listener);
      }
    });
    unsubscribe = store.subscribe(listener);
    store.dispatch("inc");
    expect(seen).toEqual([]);
    store.dispatch("inc");
    expect(seen).toEqual([2]);
  });

  it("removing and re-adding a callback after its turn delivers once now and again next update", () => {
    const store = make();
    const seen: number[] = [];
    const listener = (state: Count) => seen.push(state.count);
    let unsubscribe = store.subscribe(listener);
    store.subscribe((state) => {
      if (state.count === 1) {
        unsubscribe();
        unsubscribe = store.subscribe(listener);
      }
    });
    store.dispatch("inc");
    expect(seen).toEqual([1]);
    store.dispatch("inc");
    expect(seen).toEqual([1, 2]);
  });

  it("repeated subscribe/unsubscribe during nested rounds only affects later rounds", () => {
    const store = make();
    const seen: number[] = [];
    const listener = (state: Count) => seen.push(state.count);
    let unsubscribe = store.subscribe(listener);
    store.subscribe((state) => {
      if (state.count < 3) {
        for (let i = 0; i < 3; i++) {
          unsubscribe();
          unsubscribe = store.subscribe(listener);
        }
        store.dispatch("inc");
      }
    });
    store.dispatch("inc");
    // Round 1: the original subscription runs before the controller replaces it.
    // Round 2: the replacement now sits after the controller, which replaces it
    // again before its turn, so round 2 is skipped. Round 3: the controller stops
    // churning, so the subscription that existed when the round began receives it.
    expect(seen).toEqual([1, 3]);
    expect(store.getState().count).toBe(3);
  });

  it("subscribing the same callback twice is one subscription; either unsubscribe removes it", () => {
    const store = make();
    const listener = vi.fn();
    const first = store.subscribe(listener);
    const second = store.subscribe(listener);
    store.dispatch("inc");
    expect(listener).toHaveBeenCalledTimes(1);

    second();
    store.dispatch("inc");
    expect(listener).toHaveBeenCalledTimes(1);

    // A stale handle from an older subscription does not remove a newer one.
    const third = store.subscribe(listener);
    first();
    store.dispatch("inc");
    expect(listener).toHaveBeenCalledTimes(2);
    third();
  });
});

// ---------------------------------------------------------------------------
// 3. socket(): a URL getter that closes, disposes or throws leaves "closed".
// ---------------------------------------------------------------------------
describe("socket URL getter reentrancy", () => {
  class MockWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    static instances: MockWebSocket[] = [];
    readyState = MockWebSocket.CONNECTING;
    onopen: ((ev: Event) => void) | null = null;
    onmessage: ((ev: MessageEvent) => void) | null = null;
    onclose: ((ev: CloseEvent) => void) | null = null;
    onerror: ((ev: Event) => void) | null = null;
    send = vi.fn();
    constructor(public url: string) {
      MockWebSocket.instances.push(this);
    }
    close() {
      if (this.readyState === MockWebSocket.CLOSED) return;
      this.readyState = MockWebSocket.CLOSED;
      this.onclose?.({} as CloseEvent);
    }
  }
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.useFakeTimers();
  });
  const dropFirst = () => {
    const first = MockWebSocket.instances[0];
    first.readyState = MockWebSocket.OPEN;
    first.onopen?.({} as Event);
    first.readyState = MockWebSocket.CLOSED;
    first.onclose?.({} as CloseEvent);
  };

  for (const action of ["dispose", "close"] as const) {
    it(`a URL getter calling ${action}() during reconnect leaves the status closed`, () => {
      let reads = 0;
      const client: ReturnType<typeof socket> = socket(
        () => {
          if (++reads === 2) client[action]();
          return "wss://example.test";
        },
        { autoReconnect: true, reconnectDelay: 1 },
      );
      dropFirst();
      vi.advanceTimersByTime(100);

      expect(client.status()).toBe("closed");
      expect(MockWebSocket.instances).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    });
  }

  it("a throwing URL getter on the initial connection is reported and leaves closed", () => {
    let client: ReturnType<typeof socket> | undefined;
    expect(() => {
      client = socket(() => {
        throw new Error("no url");
      });
    }).not.toThrow();
    expect(client?.status()).toBe("closed");
    expect(MockWebSocket.instances).toHaveLength(0);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][1]).toMatchObject({ phase: "async", name: "socket" });
  });

  it("a throwing URL getter on reconnection is reported and leaves closed", () => {
    let reads = 0;
    const client = socket(
      () => {
        if (++reads === 2) throw new Error("url gone");
        return "wss://example.test";
      },
      { autoReconnect: true, reconnectDelay: 1, maxReconnects: 1 },
    );
    dropFirst();
    expect(() => vi.advanceTimersByTime(100)).not.toThrow();
    expect(client.status()).toBe("closed");
    expect(handler).toHaveBeenCalledTimes(1);
    client.dispose();
  });

  it("terminal disposal always leaves closed, whatever state the handle was in", () => {
    const client = socket("wss://example.test", { autoReconnect: true, reconnectDelay: 1 });
    expect(client.status()).toBe("connecting");
    client.dispose();
    expect(client.status()).toBe("closed");
    vi.advanceTimersByTime(100);
    expect(client.status()).toBe("closed");
  });
});
