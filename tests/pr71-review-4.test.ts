import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { imageLoader } from "../src/browser/imageLoader";
import { setRuntimeErrorHandler } from "../src/core/errors";
import { effect } from "../src/core/signals/effect";
import { signal } from "../src/core/signals/signal";
import { globalStore } from "../src/patterns/globalStore";
import { transition } from "../src/reactivity/concurrent";
import { socket } from "../src/ui/socket";
import { select } from "../src/widgets/Select";

const settle = async () => {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 0));
    for (let j = 0; j < 10; j++) await Promise.resolve();
  }
};

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
  document.body.innerHTML = "";
});

// ---------------------------------------------------------------------------
// 1. transition() settles for every kind of thenable.
// ---------------------------------------------------------------------------
describe("transition thenable adoption", () => {
  beforeEach(() => {
    // Run idle work immediately so the test controls only promise timing.
    vi.stubGlobal("requestIdleCallback", (fn: () => void) => {
      fn();
      return 1;
    });
  });

  it("a throwing then getter settles pending() and is reported", async () => {
    const task = transition();
    task.start(
      () =>
        ({
          // biome-ignore lint/suspicious/noThenProperty: a hostile thenable is the subject under test
          get then() {
            throw new Error("hostile getter");
          },
        }) as unknown as Promise<void>,
    );
    await settle();
    expect(task.pending()).toBe(false);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][1]).toMatchObject({ phase: "async", name: "transition" });
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("a stateful getter is read exactly once", async () => {
    let reads = 0;
    const task = transition();
    task.start(
      () =>
        ({
          // biome-ignore lint/suspicious/noThenProperty: a stateful thenable is the subject under test
          get then() {
            reads++;
            return reads === 1 ? (resolve: () => void) => resolve() : undefined;
          },
        }) as unknown as Promise<void>,
    );
    await settle();
    expect(reads).toBe(1);
    expect(task.pending()).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it("a then that throws when invoked settles and is reported", async () => {
    const task = transition();
    task.start(
      () =>
        ({
          // biome-ignore lint/suspicious/noThenProperty: a hostile thenable is the subject under test
          then() {
            throw new Error("invocation");
          },
        }) as unknown as Promise<void>,
    );
    await settle();
    expect(task.pending()).toBe(false);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("a multiply-settling thenable settles once and overlapping starts keep pending() correct", async () => {
    const task = transition();
    let releaseSlow!: () => void;
    task.start(
      () =>
        new Promise<void>((resolve) => {
          releaseSlow = resolve;
        }),
    );
    task.start(
      () =>
        ({
          // biome-ignore lint/suspicious/noThenProperty: a hostile thenable is the subject under test
          then(resolve: () => void, reject: (e: unknown) => void) {
            resolve();
            resolve();
            reject(new Error("late"));
          },
        }) as unknown as Promise<void>,
    );
    await settle();
    // The multiply-settling start counted once; the slow one is still running.
    expect(task.pending()).toBe(true);
    expect(handler).not.toHaveBeenCalled();
    releaseSlow();
    await settle();
    expect(task.pending()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. socket() never acquires a connection or heartbeat after reentrant disposal.
// ---------------------------------------------------------------------------
describe("socket reentrant disposal", () => {
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
    open() {
      this.readyState = MockWebSocket.OPEN;
      this.onopen?.({} as Event);
    }
    remoteClose() {
      this.readyState = MockWebSocket.CLOSED;
      this.onclose?.({} as CloseEvent);
    }
  }
  beforeEach(() => {
    MockWebSocket.instances = [];
    vi.stubGlobal("WebSocket", MockWebSocket);
    vi.useFakeTimers();
  });

  it("dispose from a 'connecting' subscriber during reconnection constructs no replacement", () => {
    const client = socket("wss://example.test", { autoReconnect: true, reconnectDelay: 1 });
    let reconnecting = false;
    const stop = effect(() => {
      const status = client.status();
      if (reconnecting && status === "connecting") client.dispose();
    });
    MockWebSocket.instances[0].open();
    reconnecting = true;
    MockWebSocket.instances[0].remoteClose();
    vi.advanceTimersByTime(100);

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(client.status()).toBe("closed");
    expect(vi.getTimerCount()).toBe(0);
    stop();
  });

  it("dispose from an 'open' subscriber does not start a heartbeat", () => {
    const client = socket("wss://example.test", { heartbeat: { interval: 10, message: "ping" } });
    const stop = effect(() => {
      if (client.status() === "open") client.dispose();
    });
    const ws = MockWebSocket.instances[0];
    ws.open();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(100);
    expect(ws.send).not.toHaveBeenCalled();
    stop();
  });

  it("every constructed socket is closed after disposal, and stale generations are ignored", () => {
    const client = socket("wss://example.test", { autoReconnect: true, reconnectDelay: 1 });
    const first = MockWebSocket.instances[0];
    const firstHandlers = { open: first.onopen, message: first.onmessage, close: first.onclose };
    first.open();
    first.remoteClose();
    vi.advanceTimersByTime(100);
    const second = MockWebSocket.instances[1];
    expect(second).toBeDefined();
    second.open();

    // Late events from the first generation change nothing.
    firstHandlers.message?.({ data: "stale" } as MessageEvent);
    firstHandlers.close?.({} as CloseEvent);
    firstHandlers.open?.({} as Event);
    expect(client.data()).toBeNull();
    expect(client.status()).toBe("open");

    client.dispose();
    vi.advanceTimersByTime(100);
    expect(MockWebSocket.instances).toHaveLength(2);
    expect(MockWebSocket.instances.every((ws) => ws.readyState === MockWebSocket.CLOSED)).toBe(true);
    expect(client.status()).toBe("closed");
  });
});

// ---------------------------------------------------------------------------
// 3. imageLoader() starts no request after reentrant disposal or replacement.
// ---------------------------------------------------------------------------
describe("imageLoader reentrant start", () => {
  interface FakeImage {
    onload: (() => void) | null;
    onerror: (() => void) | null;
    assigned: string[];
  }
  let created: FakeImage[];
  beforeEach(() => {
    created = [];
    vi.stubGlobal(
      "Image",
      class {
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        naturalWidth = 1;
        naturalHeight = 1;
        // Every src assignment is a request (or, for "", an abort).
        assigned: string[] = [];
        set src(value: string) {
          this.assigned.push(value);
        }
        constructor() {
          created.push(this as unknown as FakeImage);
        }
      },
    );
  });
  const requests = () => created.flatMap((img) => img.assigned).filter(Boolean);

  // Effect notifications raised inside the loader's own src effect are queued
  // until that effect finishes, so a "pending" subscriber runs after start() has
  // returned. What must hold is that nothing survives: every request other than
  // a settled one is aborted and detached. (The start() token guard additionally
  // covers synchronous notification paths.)
  const live = () => created.filter((img) => img.onload !== null || img.onerror !== null);
  const lastAssigned = (img: FakeImage) => img.assigned[img.assigned.length - 1];

  it("dispose from the 'pending' notification leaves no live request or handlers", () => {
    const [src, setSrc] = signal("first.png");
    const loader = imageLoader(src);
    created[0].onload?.();
    expect(loader.status()).toBe("loaded");

    let armed = false;
    const stop = effect(() => {
      const status = loader.status();
      if (armed && status === "pending") loader.dispose();
    });
    armed = true;
    setSrc("second.png");

    expect(live()).toEqual([]);
    for (const img of created.slice(1)) expect(lastAssigned(img)).toBe("");
    expect(loader.status()).toBe("pending");
    expect(loader.image()).toBeNull();

    // Nothing restarts afterwards.
    setSrc("third.png");
    expect(requests()).not.toContain("third.png");
    stop();
  });

  it("a reentrant source change aborts the older start and only the newest stays live", () => {
    const [src, setSrc] = signal("first.png");
    const loader = imageLoader(src);
    created[0].onload?.();

    let armed = false;
    const stop = effect(() => {
      const status = loader.status();
      if (armed && status === "pending") {
        armed = false;
        setSrc("third.png");
      }
    });
    armed = true;
    setSrc("second.png");

    const liveNow = live();
    expect(liveNow).toHaveLength(1);
    expect(lastAssigned(liveNow[0])).toBe("third.png");
    for (const img of created) {
      if (img.assigned.includes("second.png")) expect(lastAssigned(img)).toBe("");
    }

    // A late load from the abandoned request cannot commit.
    liveNow[0].onload?.();
    expect(loader.status()).toBe("loaded");

    stop();
    loader.dispose();
    expect(live()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. globalStore notification rounds run in commit order.
// ---------------------------------------------------------------------------
describe("globalStore reentrant notification order", () => {
  const make = () =>
    globalStore({
      state: { count: 0 },
      actions: { inc: (state: { count: number }) => ({ count: state.count + 1 }) },
    });

  for (const position of ["first", "middle", "last"] as const) {
    it(`a nested dispatch from the ${position} subscriber is delivered after the current round`, () => {
      const store = make();
      const seen: Record<string, number[]> = { a: [], b: [], c: [] };
      const nester = (state: { count: number }) => {
        if (state.count === 1) store.dispatch("inc");
      };
      const names = ["a", "b", "c"];
      const nestAt = { first: 0, middle: 1, last: 2 }[position];
      names.forEach((name, i) => {
        store.subscribe((state) => {
          if (i === nestAt) nester(state);
          seen[name].push(state.count);
        });
      });

      store.dispatch("inc");
      expect(seen).toEqual({ a: [1, 2], b: [1, 2], c: [1, 2] });
      expect(store.getState().count).toBe(2);
    });
  }

  it("nested reset() then dispatch, and dispatch then reset(), keep commit order", () => {
    const store = make();
    const seen: number[] = [];
    let step = 0;
    store.subscribe(() => {
      step++;
      if (step === 1) {
        store.reset();
        store.dispatch("inc");
      }
    });
    store.subscribe((state) => seen.push(state.count));
    store.dispatch("inc");
    expect(seen).toEqual([1, 0, 1]);

    const store2 = make();
    const seen2: number[] = [];
    let step2 = 0;
    store2.subscribe(() => {
      step2++;
      if (step2 === 1) {
        store2.dispatch("inc");
        store2.reset();
      }
    });
    store2.subscribe((state) => seen2.push(state.count));
    store2.dispatch("inc");
    expect(seen2).toEqual([1, 2, 0]);
  });

  it("listener errors stay isolated and unsubscribe still works during draining", () => {
    const store = make();
    const seen: number[] = [];
    let unsubscribe = () => {};
    store.subscribe((state) => {
      if (state.count === 1) {
        store.dispatch("inc");
        throw new Error("listener failed");
      }
    });
    unsubscribe = store.subscribe((state) => {
      seen.push(state.count);
      if (state.count === 1) unsubscribe();
    });
    store.dispatch("inc");
    expect(seen).toEqual([1]);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(store.getState().count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 5. Select Home/End and aria-activedescendant skip disabled options.
// ---------------------------------------------------------------------------
describe("Select Home/End with disabled options", () => {
  function setup(isDisabled: (item: string) => boolean) {
    const items = ["first", "enabled", "other", "last"];
    const s = select({ items, isDisabled });
    const listbox = document.createElement("ul");
    const options = items.map((item) => {
      const li = document.createElement("li");
      li.textContent = item;
      listbox.appendChild(li);
      return li;
    });
    document.body.appendChild(listbox);
    const teardown = s.bind({ listbox, option: (_item, i) => options[i] });
    const key = (k: string) => listbox.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
    const active = () => {
      const id = listbox.getAttribute("aria-activedescendant");
      return id ? (document.getElementById(id)?.textContent ?? null) : null;
    };
    return { s, key, active, teardown, options };
  }

  it("Home skips a disabled first option and End a disabled last option", () => {
    const { s, key, active, teardown } = setup((item) => item === "first" || item === "last");
    key("Home");
    expect(s.highlightedIndex()).toBe(1);
    expect(active()).toBe("enabled");
    key("End");
    expect(s.highlightedIndex()).toBe(2);
    expect(active()).toBe("other");
    teardown();
  });

  it("with every option disabled, Home and End leave the highlight unchanged", () => {
    const { s, key, active, teardown } = setup(() => true);
    key("Home");
    key("End");
    expect(s.highlightedIndex()).toBe(-1);
    expect(active()).toBeNull();
    teardown();
  });

  it("a changed disabled predicate is honoured and never exposes a disabled active descendant", () => {
    const [blocked, setBlocked] = signal<string[]>([]);
    const { s, key, active, teardown, options } = setup((item) => blocked().includes(item));
    key("Home");
    expect(active()).toBe("first");

    setBlocked(["first"]);
    expect(active()).toBeNull();
    expect(options[0].getAttribute("aria-disabled")).toBe("true");

    key("Home");
    expect(s.highlightedIndex()).toBe(1);
    setBlocked(["first", "last"]);
    key("End");
    expect(active()).toBe("other");
    teardown();
  });
});
