import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setRuntimeErrorHandler } from "../src/core/errors";
import { effect } from "../src/core/signals/effect";
import { form } from "../src/ui/form";
import { springSignal } from "../src/ui/springSignal";
import { stream } from "../src/ui/stream";
import { TransitionGroup } from "../src/ui/TransitionGroup";

const macrotask = () => new Promise((r) => setTimeout(r, 0));

let handler: ReturnType<typeof vi.fn>;
let unhandled: ReturnType<typeof vi.fn>;
beforeEach(() => {
  handler = vi.fn();
  setRuntimeErrorHandler(handler);
  unhandled = vi.fn();
  process.on("unhandledRejection", unhandled);
});
afterEach(() => {
  setRuntimeErrorHandler(null);
  process.off("unhandledRejection", unhandled);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 22. springSignal() is terminal after dispose().
// ---------------------------------------------------------------------------
describe("springSignal disposal", () => {
  let queue: Map<number, (now: number) => void>;
  let nextId: number;
  let clock: number;
  beforeEach(() => {
    queue = new Map();
    nextId = 1;
    clock = 0;
    vi.stubGlobal("requestAnimationFrame", (cb: (now: number) => void) => {
      const id = nextId++;
      queue.set(id, cb);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => queue.delete(id));
  });
  const frame = () => {
    const callbacks = [...queue.values()];
    queue.clear();
    clock += 1000 / 60;
    for (const cb of callbacks) cb(clock);
  };

  it("set() after dispose() schedules nothing and writes nothing", () => {
    const [value, set, dispose] = springSignal(0);
    dispose();
    set(200);
    expect(queue.size).toBe(0);
    expect(value()).toBe(0);
  });

  it("dispose() from a subscriber during a frame prevents rescheduling", () => {
    const [value, set, dispose] = springSignal(0);
    const stop = effect(() => {
      if (value() > 0) dispose();
    });
    set(100);
    expect(queue.size).toBe(1);
    frame();
    expect(queue.size).toBe(0);
    set(200);
    expect(queue.size).toBe(0);
    stop();
  });

  it("repeated dispose() is idempotent, including mid-animation", () => {
    const [, set, dispose] = springSignal(0);
    set(50);
    dispose();
    dispose();
    expect(queue.size).toBe(0);
    frame();
    expect(queue.size).toBe(0);
  });

  it("set() from a subscriber during a frame does not queue a second loop", () => {
    const [value, set, dispose] = springSignal(0);
    let redirected = false;
    const stop = effect(() => {
      if (value() > 0 && !redirected) {
        redirected = true;
        set(10);
      }
    });
    set(100);
    frame();
    expect(queue.size).toBe(1);
    dispose();
    stop();
  });
});

// ---------------------------------------------------------------------------
// 23. stream() ignores callbacks from closed, disposed or replaced sources.
// ---------------------------------------------------------------------------
describe("stream stale EventSource callbacks", () => {
  class MockEventSource {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 2;
    static instances: MockEventSource[] = [];
    readyState = MockEventSource.CONNECTING;
    onopen: ((ev: Event) => void) | null = null;
    onmessage: ((ev: MessageEvent) => void) | null = null;
    onerror: ((ev: Event) => void) | null = null;
    // Captured at construction so tests can fire handlers even after detach.
    handlers: { open?: (ev: Event) => void; message?: (ev: MessageEvent) => void; error?: (ev: Event) => void } = {};
    constructor(public url: string) {
      MockEventSource.instances.push(this);
      queueMicrotask(() => {
        this.handlers = {
          open: this.onopen ?? undefined,
          message: this.onmessage ?? undefined,
          error: this.onerror ?? undefined,
        };
      });
    }
    close() {
      this.readyState = MockEventSource.CLOSED;
    }
  }
  beforeEach(() => {
    MockEventSource.instances = [];
    vi.stubGlobal("EventSource", MockEventSource);
  });
  const late = (source: MockEventSource) => {
    source.handlers.open?.(new Event("open"));
    source.handlers.message?.({ data: "late", type: "message" } as MessageEvent);
    source.readyState = MockEventSource.CLOSED;
    source.handlers.error?.(new Event("error"));
  };

  it("callbacks after close() change nothing", async () => {
    const s = stream("/events");
    await Promise.resolve();
    const old = MockEventSource.instances[0];
    s.close();
    expect(old.onmessage).toBeNull();
    late(old);
    expect(s.status()).toBe("closed");
    expect(s.data()).toBeNull();
    s.dispose();
  });

  it("callbacks after dispose() change nothing", async () => {
    const s = stream("/events", { autoReconnect: true, reconnectBaseMs: 1 });
    await Promise.resolve();
    const old = MockEventSource.instances[0];
    s.dispose();
    late(old);
    await new Promise((r) => setTimeout(r, 20));
    expect(s.status()).toBe("closed");
    expect(s.data()).toBeNull();
    expect(MockEventSource.instances).toHaveLength(1);
  });

  it("an old source cannot affect the replacement after reconnection", async () => {
    vi.useFakeTimers();
    const s = stream("/events", { autoReconnect: true, reconnectBaseMs: 10, reconnectMaxMs: 10 });
    await Promise.resolve();
    const first = MockEventSource.instances[0];
    first.readyState = MockEventSource.CLOSED;
    first.onerror?.(new Event("error"));
    vi.advanceTimersByTime(20);
    await Promise.resolve();
    const second = MockEventSource.instances[1];
    expect(second).toBeDefined();
    second.readyState = MockEventSource.OPEN;
    second.onopen?.(new Event("open"));
    expect(s.status()).toBe("open");

    late(first);
    vi.advanceTimersByTime(100);
    expect(s.status()).toBe("open");
    expect(s.data()).toBeNull();
    expect(MockEventSource.instances).toHaveLength(2);

    second.onmessage?.({ data: "fresh", type: "message" } as MessageEvent);
    expect(s.data()).toBe("fresh");
    s.dispose();
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// 24. TransitionGroup routes callback failures through reportError().
// ---------------------------------------------------------------------------
describe("TransitionGroup callback failures", () => {
  const el = (name: string) => {
    const node = document.createElement("div");
    node.dataset.name = name;
    return node;
  };

  it("a rejected enter from add() is reported with the element, not left unhandled", async () => {
    const node = el("a");
    TransitionGroup({
      enter: async () => {
        throw new Error("enter failed");
      },
    }).add(node);
    await macrotask();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({ message: "enter failed" });
    expect(handler.mock.calls[0][1]).toMatchObject({ node });
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("rejected enter and leave from track() are reported, and every element is processed", async () => {
    const a = el("a");
    const b = el("b");
    const c = el("c");
    const d = el("d");
    const entered: string[] = [];
    const group = TransitionGroup({
      enter: async (node) => {
        entered.push(node.dataset.name!);
        if (node === c) throw new Error("enter c");
      },
      leave: (node) => {
        if (node === a) return Promise.reject(new Error("leave a"));
        if (node === b) throw new Error("leave b");
      },
    });
    group.track([a, b]);
    handler.mockClear();
    entered.length = 0;

    group.track([c, d]);
    await macrotask();
    expect(entered).toEqual(["c", "d"]);
    expect(handler.mock.calls.map((call) => call[0].message).sort()).toEqual(["enter c", "leave a", "leave b"]);
    expect(unhandled).not.toHaveBeenCalled();

    // Reconciliation completed despite the failures: d is tracked, a is not.
    handler.mockClear();
    entered.length = 0;
    group.track([d]);
    expect(entered).toEqual([]);
  });

  it("a throwing move is reported and does not stop other moves", () => {
    const a = el("a");
    const b = el("b");
    // Reads 1 (first track's snapshot) and 2 (second track's "before") are at
    // 0; later reads are at 10, so the second track sees both elements move.
    for (const node of [a, b]) {
      let reads = 0;
      node.getBoundingClientRect = () => ({ left: ++reads >= 3 ? 10 : 0, top: 0 }) as DOMRect;
    }
    const moved: HTMLElement[] = [];
    const group = TransitionGroup({
      move: (node) => {
        moved.push(node);
        if (node === a) throw new Error("move a");
      },
    });
    group.track([a, b]);
    group.track([a, b]);
    expect(moved).toEqual([a, b]);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][1]).toMatchObject({ node: a });
  });
});

// ---------------------------------------------------------------------------
// 25. form.handleSubmit() reports failures and always releases submitting.
// ---------------------------------------------------------------------------
describe("form.handleSubmit failures", () => {
  it("an async rejection reaches the runtime handler exactly once and resets submitting", async () => {
    const f = form({ name: { initial: "x" } });
    f.handleSubmit(async () => {
      throw new Error("save failed");
    })();
    expect(f.submitting()).toBe(true);
    await macrotask();
    expect(f.submitting()).toBe(false);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({ message: "save failed" });
    expect(handler.mock.calls[0][1]).toMatchObject({ phase: "async", name: "form.handleSubmit" });
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("a synchronous throw is reported and submitting stays false", () => {
    const f = form({ name: { initial: "x" } });
    expect(() =>
      f.handleSubmit(() => {
        throw new Error("sync failed");
      })(),
    ).not.toThrow();
    expect(f.submitting()).toBe(false);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("a thenable whose then accessor throws cannot strand submitting", async () => {
    const f = form({ name: { initial: "x" } });
    const hostile = {
      // biome-ignore lint/suspicious/noThenProperty: a hostile thenable is the subject under test
      get then() {
        throw new Error("then accessor");
      },
    };
    f.handleSubmit(() => hostile as unknown as Promise<void>)();
    await macrotask();
    expect(f.submitting()).toBe(false);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("a thenable whose then call throws cannot strand submitting", async () => {
    const f = form({ name: { initial: "x" } });
    const hostile = {
      // biome-ignore lint/suspicious/noThenProperty: a hostile thenable is the subject under test
      then() {
        throw new Error("then call");
      },
    };
    f.handleSubmit(() => hostile as unknown as Promise<void>)();
    expect(f.submitting()).toBe(true);
    await macrotask();
    expect(f.submitting()).toBe(false);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({ message: "then call" });
  });

  it("a successful async submit reports nothing", async () => {
    const f = form({ name: { initial: "x" } });
    f.handleSubmit(async () => {})();
    await macrotask();
    expect(f.submitting()).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });
});
