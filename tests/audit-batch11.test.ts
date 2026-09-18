import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gamepad } from "../src/browser/gamepad";
import { setRuntimeErrorHandler } from "../src/core/errors";
import { action, copyOnClick } from "../src/core/rendering/action";
import { infiniteQuery } from "../src/data/infiniteQuery";

const settle = async () => {
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 0));
    for (let j = 0; j < 15; j++) await Promise.resolve();
  }
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setRuntimeErrorHandler(null);
});

// ---------------------------------------------------------------------------
// 27. gamepad() reconciles disconnection and device identity.
// ---------------------------------------------------------------------------
describe("gamepad reconciliation", () => {
  let frames: Array<(ts: number) => void>;
  let native: Array<Gamepad | null>;
  let handlers: Record<string, EventListener[]>;

  beforeEach(() => {
    frames = [];
    native = [];
    handlers = {};
    vi.stubGlobal("requestAnimationFrame", (cb: (ts: number) => void) => frames.push(cb));
    vi.stubGlobal("cancelAnimationFrame", () => {
      frames = [];
    });
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

  const pad = (index: number, id: string) =>
    ({ index, id, connected: true, buttons: [{ pressed: false, value: 0 }], axes: [0] }) as unknown as Gamepad;
  const fire = (type: string) => {
    for (const fn of handlers[type] || []) fn(new Event(type));
  };
  const frame = () => {
    const pending = frames;
    frames = [];
    for (const cb of pending) cb(0);
  };

  it("the last controller disconnecting publishes an empty set", () => {
    native = [pad(0, "old")];
    const gp = gamepad();
    expect(gp.pads().map((p) => p.id)).toEqual(["old"]);

    native = [];
    fire("gamepaddisconnected");
    expect(gp.pads()).toEqual([]);
    expect(frames).toHaveLength(0);
    gp.dispose();
  });

  it("a replacement at the same index with identical inputs updates the id", () => {
    native = [pad(0, "old")];
    const gp = gamepad();
    native = [pad(0, "new")];
    frame();
    expect(gp.pads().map((p) => p.id)).toEqual(["new"]);
    gp.dispose();
  });

  it("disconnecting one of several controllers publishes the remaining set and keeps polling", () => {
    native = [pad(0, "a"), pad(1, "b")];
    const gp = gamepad();
    native = [null, pad(1, "b")];
    fire("gamepaddisconnected");
    expect(gp.pads().map((p) => p.id)).toEqual(["b"]);
    expect(frames.length).toBeGreaterThan(0);
    gp.dispose();
  });
});

// ---------------------------------------------------------------------------
// 28. infiniteQuery public fetches are harmless after dispose().
// ---------------------------------------------------------------------------
describe("infiniteQuery after dispose", () => {
  const OPTS = {
    getNextPageParam: (_last: unknown, all: unknown[]) => all.length,
    getPreviousPageParam: (_first: unknown, all: unknown[]) => (all.length > 0 ? -1 : undefined),
    retry: { maxRetries: 0 },
  };

  it("refetch, fetchNextPage and fetchPreviousPage change nothing and fetch nothing", async () => {
    const fetcher = vi.fn(async () => "page");
    const q = infiniteQuery(() => "batch11-k", fetcher as never, OPTS as never);
    await settle();
    expect(q.pages()).toHaveLength(1);
    const pagesBefore = q.pages();
    const dataBefore = q.data();
    fetcher.mockClear();

    q.dispose();
    await q.refetch();
    await q.fetchNextPage();
    await q.fetchPreviousPage();
    await settle();

    expect(fetcher).not.toHaveBeenCalled();
    expect(q.pages()).toBe(pagesBefore);
    expect(q.data()).toEqual(dataBefore);
    expect(q.fetching()).toBe(false);
    expect(q.fetchingNextPage()).toBe(false);
    expect(q.fetchingPreviousPage()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 29. copyOnClick reports clipboard failures.
// ---------------------------------------------------------------------------
describe("copyOnClick failures", () => {
  let handler: ReturnType<typeof vi.fn>;
  let unhandled: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    handler = vi.fn();
    setRuntimeErrorHandler(handler);
    unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
  });
  afterEach(() => {
    process.off("unhandledRejection", unhandled);
  });

  const button = () => {
    const el = document.createElement("button");
    el.textContent = "token";
    document.body.appendChild(el);
    return el;
  };

  it("a rejected writeText() is reported once with the element", async () => {
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: async () => {
          throw new Error("Permission denied");
        },
      },
    });
    const el = button();
    action(el, copyOnClick);
    el.click();
    await settle();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({ message: "Permission denied" });
    expect(handler.mock.calls[0][1]).toMatchObject({ phase: "async", name: "copyOnClick", node: el });
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("a missing Clipboard API is reported, not thrown", async () => {
    vi.stubGlobal("navigator", {});
    const el = button();
    action(el, copyOnClick);
    expect(() => el.click()).not.toThrow();
    await settle();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(unhandled).not.toHaveBeenCalled();
  });

  it("a throwing custom text getter is reported and nothing is written", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const el = button();
    action(el, copyOnClick, () => {
      throw new Error("no token");
    });
    el.click();
    await settle();
    expect(writeText).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({ message: "no token" });
  });

  it("a successful copy reports nothing", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const el = button();
    action(el, copyOnClick);
    el.click();
    await settle();
    expect(writeText).toHaveBeenCalledWith("token");
    expect(handler).not.toHaveBeenCalled();
  });
});
