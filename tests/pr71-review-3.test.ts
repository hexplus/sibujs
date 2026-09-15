import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gamepad } from "../src/browser/gamepad";
import { setRuntimeErrorHandler } from "../src/core/errors";
import { effect } from "../src/core/signals/effect";
import { form } from "../src/ui/form";
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
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// gamepad(): disposal during a frame is terminal.
// ---------------------------------------------------------------------------
describe("gamepad reactive disposal", () => {
  let queued: Map<number, (ts: number) => void>;
  let nextId: number;
  let native: Array<Gamepad | null>;
  let handlers: Record<string, EventListener[]>;
  beforeEach(() => {
    queued = new Map();
    nextId = 1;
    handlers = {};
    vi.stubGlobal("requestAnimationFrame", (cb: (ts: number) => void) => {
      const id = nextId++;
      queued.set(id, cb);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => queued.delete(id));
    vi.stubGlobal("navigator", { getGamepads: () => native });
    vi.stubGlobal("window", {
      addEventListener: (type: string, fn: EventListener) => {
        (handlers[type] ||= []).push(fn);
      },
      removeEventListener: (type: string, fn: EventListener) => {
        handlers[type] = (handlers[type] || []).filter((h) => h !== fn);
      },
    });
  });
  const pad = (axis: number) =>
    ({ index: 0, id: "pad", connected: true, buttons: [], axes: [axis] }) as unknown as Gamepad;
  const runFrames = () => {
    const pending = [...queued.values()];
    queued.clear();
    for (const cb of pending) cb(0);
  };

  it("dispose() from a pads() subscriber during a frame leaves no queued frame", () => {
    native = [pad(0)];
    const gp = gamepad();
    const stop = effect(() => {
      if (gp.pads()[0]?.axes[0] === 1) gp.dispose();
    });
    native = [pad(1)];
    runFrames();
    expect(queued.size).toBe(0);
    runFrames();
    expect(queued.size).toBe(0);
    stop();
  });

  it("a captured stale frame invoked after disposal cannot restart polling", () => {
    native = [pad(0)];
    const gp = gamepad();
    const [stale] = [...queued.values()];
    gp.dispose();
    stale(0);
    expect(queued.size).toBe(0);
    for (const fn of handlers.gamepadconnected || []) fn(new Event("gamepadconnected"));
    expect(queued.size).toBe(0);
  });

  it("repeated disposal stays terminal", () => {
    native = [pad(0)];
    const gp = gamepad();
    gp.dispose();
    gp.dispose();
    runFrames();
    expect(queued.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// stream(): reentrant disposal never leaks a connection or a timer.
// ---------------------------------------------------------------------------
describe("stream reentrant disposal", () => {
  class MockEventSource {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 2;
    static instances: MockEventSource[] = [];
    readyState = MockEventSource.CONNECTING;
    closed = false;
    onopen: ((ev: Event) => void) | null = null;
    onmessage: ((ev: MessageEvent) => void) | null = null;
    onerror: ((ev: Event) => void) | null = null;
    constructor(public url: string) {
      MockEventSource.instances.push(this);
    }
    close() {
      this.closed = true;
      this.readyState = MockEventSource.CLOSED;
    }
  }
  beforeEach(() => {
    MockEventSource.instances = [];
    vi.stubGlobal("EventSource", MockEventSource);
    vi.useFakeTimers();
  });
  const failFirst = () => {
    const first = MockEventSource.instances[0];
    first.readyState = MockEventSource.CLOSED;
    first.onerror?.(new Event("error"));
    return first;
  };

  it("dispose from a 'connecting' subscriber during reconnection constructs no replacement", () => {
    const s = stream("/events", { autoReconnect: true, reconnectBaseMs: 1, reconnectMaxMs: 1 });
    let reconnecting = false;
    const stop = effect(() => {
      // Read status unconditionally so the effect stays subscribed.
      const status = s.status();
      if (reconnecting && status === "connecting") s.dispose();
    });
    failFirst();
    reconnecting = true;
    vi.advanceTimersByTime(10);

    expect(MockEventSource.instances).toHaveLength(1);
    expect(s.status()).toBe("closed");
    expect(vi.getTimerCount()).toBe(0);
    stop();
  });

  it("dispose from a 'closed' subscriber during onerror installs no reconnect timer", () => {
    const s = stream("/events", { autoReconnect: true, reconnectBaseMs: 1, reconnectMaxMs: 1 });
    const stop = effect(() => {
      if (s.status() === "closed") s.dispose();
    });
    failFirst();

    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(100);
    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances.every((source) => source.closed || source.readyState === 2)).toBe(true);
    stop();
  });

  it("close() from a 'closed' subscriber also stops reconnection", () => {
    const s = stream("/events", { autoReconnect: true, reconnectBaseMs: 1, reconnectMaxMs: 1 });
    const stop = effect(() => {
      if (s.status() === "closed") s.close();
    });
    failFirst();
    vi.advanceTimersByTime(100);
    expect(MockEventSource.instances).toHaveLength(1);
    s.dispose();
    stop();
  });

  it("every constructed source is closed after disposal", () => {
    const s = stream("/events", { autoReconnect: true, reconnectBaseMs: 1, reconnectMaxMs: 1 });
    failFirst();
    vi.advanceTimersByTime(10);
    expect(MockEventSource.instances).toHaveLength(2);
    s.dispose();
    expect(MockEventSource.instances.every((source) => source.readyState === MockEventSource.CLOSED)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(s.status()).toBe("closed");
  });
});

// ---------------------------------------------------------------------------
// Thenable adoption reads `then` once.
// ---------------------------------------------------------------------------
describe("thenable handling reads then exactly once", () => {
  const submitWith = (result: unknown) => {
    const f = form({ name: { initial: "x" } });
    f.handleSubmit(() => result as Promise<void>)();
    return f;
  };
  const enterWith = (result: unknown) => {
    TransitionGroup({ enter: () => result as Promise<void> }).add(document.createElement("div"));
  };

  for (const [label, run] of [
    ["form.handleSubmit", submitWith],
    ["TransitionGroup", enterWith],
  ] as const) {
    it(`${label}: the then accessor is read once`, async () => {
      let reads = 0;
      const result = {
        // biome-ignore lint/suspicious/noThenProperty: a stateful thenable is the subject under test
        get then() {
          reads++;
          return (resolve: () => void) => resolve();
        },
      };
      run(result);
      await macrotask();
      expect(reads).toBe(1);
      expect(handler).not.toHaveBeenCalled();
    });

    it(`${label}: an accessor answering differently on later reads is adopted by its first answer`, async () => {
      let reads = 0;
      const result = {
        // biome-ignore lint/suspicious/noThenProperty: a stateful thenable is the subject under test
        get then() {
          reads++;
          return reads === 1
            ? (_resolve: () => void, reject: (e: unknown) => void) => reject(new Error(`${label} rejected`))
            : undefined;
        },
      };
      run(result);
      await macrotask();
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0]).toMatchObject({ message: `${label} rejected` });
      expect(unhandled).not.toHaveBeenCalled();
    });

    it(`${label}: a captured then that throws when invoked is reported`, async () => {
      const result = {
        // biome-ignore lint/suspicious/noThenProperty: a hostile thenable is the subject under test
        then() {
          throw new Error(`${label} then threw`);
        },
      };
      run(result);
      await macrotask();
      expect(handler).toHaveBeenCalledTimes(1);
      expect(unhandled).not.toHaveBeenCalled();
    });

    it(`${label}: a then that settles more than once counts only its first settlement`, async () => {
      const result = {
        // biome-ignore lint/suspicious/noThenProperty: a hostile thenable is the subject under test
        then(resolve: () => void, reject: (e: unknown) => void) {
          reject(new Error("first"));
          reject(new Error("second"));
          resolve();
        },
      };
      run(result);
      await macrotask();
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0]).toMatchObject({ message: "first" });
    });
  }

  it("form: submitting is released after a multiply-settling then resolves first", async () => {
    const f = submitWith({
      // biome-ignore lint/suspicious/noThenProperty: a hostile thenable is the subject under test
      then(resolve: () => void, reject: (e: unknown) => void) {
        resolve();
        reject(new Error("late"));
      },
    });
    expect(f.submitting()).toBe(true);
    await macrotask();
    expect(f.submitting()).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });
});
