import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setRuntimeErrorHandler } from "../src/core/errors";
import { globalStore, type Middleware } from "../src/patterns/globalStore";
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
const flush = async () => {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 0));
    for (let j = 0; j < 10; j++) await Promise.resolve();
  }
};

function storeWith(middleware: Middleware<Count>[]) {
  const store = globalStore({
    state: { count: 0 },
    actions: {
      inc: (state: Count) => ({ count: state.count + 1 }),
    },
    middleware,
  });
  const seen: [number, number][] = [];
  store.subscribe((state) => {
    if (state.count === 1) store.dispatch("inc");
  });
  store.subscribe((state) => seen.push([state.count, store.getState().count]));
  return { store, seen };
}

// Delays only the first continuation it sees.
const delayFirst = (schedule: (next: () => void) => void): Middleware<Count> => {
  let first = true;
  return (_state, _action, _payload, next) => {
    if (first) {
      first = false;
      schedule(next);
    } else {
      next();
    }
  };
};

// ---------------------------------------------------------------------------
// 1. Delayed middleware continuations re-enter the operation queue.
// ---------------------------------------------------------------------------
describe("globalStore delayed middleware next()", () => {
  const schedulers: [string, (next: () => void) => void][] = [
    ["setTimeout(next)", (next) => setTimeout(next, 0)],
    ["queueMicrotask(next)", (next) => queueMicrotask(next)],
    [
      "await Promise.resolve(); next()",
      (next) => {
        void (async () => {
          await Promise.resolve();
          next();
        })();
      },
    ],
  ];

  for (const [label, schedule] of schedulers) {
    it(`${label} keeps callback state equal to getState() and commit order`, async () => {
      const { store, seen } = storeWith([delayFirst(schedule)]);
      store.dispatch("inc");
      expect(store.getState().count).toBe(0);
      await flush();

      expect(seen).toEqual([
        [1, 1],
        [2, 2],
      ]);
      expect(store.getState().count).toBe(2);
    });
  }

  it("multiple middleware where only one continuation is delayed", async () => {
    const order: string[] = [];
    const { store, seen } = storeWith([
      (_s, _a, _p, next) => {
        order.push("outer");
        next();
      },
      delayFirst((next) => setTimeout(next, 0)),
      (_s, _a, _p, next) => {
        order.push("inner");
        next();
      },
    ]);
    store.dispatch("inc");
    expect(order).toEqual(["outer"]);
    await flush();
    expect(order).toEqual(["outer", "inner", "outer", "inner"]);
    expect(seen).toEqual([
      [1, 1],
      [2, 2],
    ]);
  });

  it("a delayed continuation followed by a reentrant reset keeps order", async () => {
    const store = globalStore({
      state: { count: 0 },
      actions: { inc: (state: Count) => ({ count: state.count + 1 }) },
      middleware: [delayFirst((next) => setTimeout(next, 0))],
    });
    const rounds: [number, number][] = [];
    store.subscribe((state) => {
      if (state.count === 1) store.reset();
    });
    store.subscribe((state) => rounds.push([state.count, store.getState().count]));
    store.dispatch("inc");
    await flush();
    expect(rounds).toEqual([
      [1, 1],
      [0, 0],
    ]);
  });

  it("an operation dispatched while a continuation is pending runs when it is dispatched", async () => {
    const store = globalStore({
      state: { count: 0 },
      actions: { inc: (state: Count) => ({ count: state.count + 1 }) },
      middleware: [delayFirst((next) => setTimeout(next, 0))],
    });
    const rounds: number[] = [];
    store.subscribe((state) => {
      expect(state.count).toBe(store.getState().count);
      rounds.push(state.count);
    });
    store.dispatch("inc"); // delayed
    store.dispatch("inc"); // immediate
    expect(rounds).toEqual([1]);
    await flush();
    expect(rounds).toEqual([1, 2]);
  });

  it("a repeated delayed next() is still ignored", async () => {
    const action = vi.fn((state: Count) => ({ count: state.count + 1 }));
    let captured: (() => void) | undefined;
    const store = globalStore({
      state: { count: 0 },
      actions: { inc: action },
      middleware: [
        (_s, _a, _p, next) => {
          captured = next;
          setTimeout(() => {
            next();
            next();
          }, 0);
        },
      ],
    });
    store.dispatch("inc");
    await flush();
    captured?.();
    await flush();
    expect(action).toHaveBeenCalledTimes(1);
    expect(store.getState().count).toBe(1);
  });

  it("an error from a delayed continuation reaches reportError()", async () => {
    const store = globalStore({
      state: { count: 0 },
      actions: {
        boom: (): Partial<Count> => {
          throw new Error("delayed action failed");
        },
      },
      middleware: [
        (_s, _a, _p, next) => {
          setTimeout(next, 0);
        },
      ],
    });
    store.dispatch("boom");
    await flush();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({ message: "delayed action failed" });
  });

  it("a middleware that throws after a synchronous next() rethrows and the queue keeps working", () => {
    const store = globalStore({
      state: { count: 0 },
      actions: { inc: (state: Count) => ({ count: state.count + 1 }) },
      middleware: [
        (_s, _a, _p, next) => {
          next();
          throw new Error("middleware failed");
        },
      ],
    });
    expect(() => store.dispatch("inc")).toThrow("middleware failed");
    expect(store.getState().count).toBe(1);
    expect(() => store.dispatch("inc")).toThrow("middleware failed");
    expect(store.getState().count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 2. A throwing WebSocket constructor is reported and leaves "closed".
// ---------------------------------------------------------------------------
describe("socket constructor failures", () => {
  class MockWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    static instances: MockWebSocket[] = [];
    static constructions = 0;
    static failOn: (url: string, protocols: unknown, attempt: number) => Error | null = () => null;
    readyState = MockWebSocket.CONNECTING;
    onopen: ((ev: Event) => void) | null = null;
    onmessage: ((ev: MessageEvent) => void) | null = null;
    onclose: ((ev: CloseEvent) => void) | null = null;
    onerror: ((ev: Event) => void) | null = null;
    send = vi.fn();
    constructor(
      public url: string,
      protocols?: string | string[],
    ) {
      const failure = MockWebSocket.failOn(url, protocols, ++MockWebSocket.constructions);
      if (failure) throw failure;
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
    MockWebSocket.constructions = 0;
    MockWebSocket.failOn = () => null;
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.useFakeTimers();
  });
  const expectReportedClosed = (client: ReturnType<typeof socket>) => {
    expect(client.status()).toBe("closed");
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][1]).toMatchObject({ phase: "async", name: "socket" });
    expect(vi.getTimerCount()).toBe(0);
  };

  it("a constructor throwing on the initial connection is reported, not thrown", () => {
    MockWebSocket.failOn = () => new DOMException("blocked by policy", "SecurityError");
    let client: ReturnType<typeof socket> | undefined;
    expect(() => {
      client = socket("wss://example.test");
    }).not.toThrow();
    expectReportedClosed(client!);
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it("a constructor throwing during reconnection does not escape the timer", () => {
    MockWebSocket.failOn = (_url, _protocols, attempt) =>
      attempt === 2 ? new DOMException("bad protocols", "SyntaxError") : null;
    const client = socket("wss://example.test", { autoReconnect: true, reconnectDelay: 1 });
    const first = MockWebSocket.instances[0];
    first.readyState = MockWebSocket.OPEN;
    first.onopen?.({} as Event);
    first.readyState = MockWebSocket.CLOSED;
    first.onclose?.({} as CloseEvent);

    expect(() => vi.runAllTimers()).not.toThrow();
    expectReportedClosed(client);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("a dynamic URL that passes the scheme check but is rejected by the browser", () => {
    MockWebSocket.failOn = (url) => (/\s|%zz/.test(url) ? new DOMException("invalid URL", "SyntaxError") : null);
    const client = socket(() => "wss://exa mple.test/%zz");
    expectReportedClosed(client);
  });

  it("invalid or duplicate protocols are reported", () => {
    MockWebSocket.failOn = (_url, protocols) =>
      Array.isArray(protocols) && new Set(protocols).size !== protocols.length
        ? new DOMException("duplicate protocols", "SyntaxError")
        : null;
    const client = socket("wss://example.test", { protocols: ["chat", "chat"] });
    expectReportedClosed(client);
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it("disposal after a construction failure stays closed with nothing scheduled", () => {
    MockWebSocket.failOn = () => new DOMException("blocked", "SecurityError");
    const client = socket("wss://example.test", { autoReconnect: true, reconnectDelay: 1 });
    client.dispose();
    vi.runAllTimers();
    expect(client.status()).toBe("closed");
    expect(MockWebSocket.instances).toHaveLength(0);
  });
});
