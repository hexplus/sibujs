import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { swipe } from "../src/browser/swipe";
import { dispose } from "../src/core/rendering/dispose";
import { effect } from "../src/core/signals/effect";
import { signal } from "../src/core/signals/signal";
import { throttle } from "../src/data/throttle";
import { Head, setStructuredData } from "../src/platform/head";
import { scrollLock } from "../src/ui/scrollLock";
import { interval } from "../src/ui/timers";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// 58. throttle(): a trailing emission starts a new window.
// ---------------------------------------------------------------------------
describe("throttle trailing window", () => {
  beforeEach(() => vi.useFakeTimers());

  function setup(ms = 100) {
    const [value, setValue] = signal(0);
    const throttled = throttle(value, ms);
    // Recorded by an effect at the moment each emission happens (fake timers
    // also drive Date.now), so gaps are exact rather than step-quantized.
    const emissions: Array<{ t: number; v: number }> = [];
    const start = Date.now();
    const stopRecording = effect(() => {
      emissions.push({ t: Date.now() - start, v: throttled() });
    });
    emissions.length = 0;
    const advance = (ms2: number) => vi.advanceTimersByTime(ms2);
    const set = (v: number) => setValue(v);
    const dispose = () => {
      stopRecording();
      throttled.dispose();
    };
    return { throttled, set, advance, emissions, dispose };
  }

  it("an update right after a trailing emission waits for the new window", () => {
    const t = setup();
    t.set(1); // leading at 0
    t.advance(90);
    t.set(2); // pending
    t.advance(10); // trailing at 100
    t.advance(1);
    t.set(3); // must not emit at 101
    expect(t.throttled()).toBe(2);
    t.advance(98); // 199
    expect(t.throttled()).toBe(2);
    t.advance(1); // 200 — trailing of the new window
    expect(t.throttled()).toBe(3);

    const gaps = t.emissions.slice(1).map((e, i) => e.t - t.emissions[i].t);
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(100);
    t.dispose();
  });

  it("consecutive trailing windows stay at least one interval apart", () => {
    const t = setup();
    t.set(1);
    for (let i = 2; i <= 8; i++) {
      t.advance(30);
      t.set(i);
    }
    t.advance(500);
    const gaps = t.emissions.slice(1).map((e, i) => e.t - t.emissions[i].t);
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(100);
    expect(t.throttled()).toBe(8);
    t.dispose();
  });

  it("after a quiet full window the next change leads immediately", () => {
    const t = setup();
    t.set(1);
    t.advance(100);
    t.set(2);
    expect(t.throttled()).toBe(2);
    t.dispose();
  });

  it("disposal during a restarted window cancels the pending emission", () => {
    const t = setup();
    t.set(1);
    t.advance(50);
    t.set(2);
    t.advance(50); // trailing emits 2, new window starts
    t.set(3);
    t.throttled.dispose();
    t.advance(500);
    expect(t.throttled()).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 60. interval(): pause preserves the remaining delay.
// ---------------------------------------------------------------------------
describe("interval pause keeps the remaining delay", () => {
  beforeEach(() => vi.useFakeTimers());

  it("pausing near a deadline ticks after only the remainder", () => {
    const fn = vi.fn();
    const timer = interval(fn, 1000);
    vi.advanceTimersByTime(900);
    timer.pause();
    timer.resume();
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(2);
    timer.stop();
  });

  it("time spent paused does not count, over multiple cycles", () => {
    const fn = vi.fn();
    const timer = interval(fn, 1000);
    vi.advanceTimersByTime(300);
    timer.pause();
    vi.advanceTimersByTime(5000);
    timer.resume();
    vi.advanceTimersByTime(300);
    timer.pause();
    vi.advanceTimersByTime(5000);
    timer.resume();
    vi.advanceTimersByTime(399);
    expect(fn).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    timer.stop();
  });

  it("pausing right after a tick resumes with a full period", () => {
    const fn = vi.fn();
    const timer = interval(fn, 100);
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(1);
    timer.pause();
    timer.resume();
    vi.advanceTimersByTime(99);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(2);
    timer.stop();
  });

  it("pause and resume are idempotent", () => {
    const fn = vi.fn();
    const timer = interval(fn, 100);
    vi.advanceTimersByTime(40);
    timer.pause();
    timer.pause();
    expect(timer.isRunning()).toBe(false);
    timer.resume();
    timer.resume();
    expect(timer.isRunning()).toBe(true);
    vi.advanceTimersByTime(60);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    timer.stop();
  });

  it("stop while paused leaves nothing scheduled", () => {
    const fn = vi.fn();
    const timer = interval(fn, 100);
    vi.advanceTimersByTime(50);
    timer.pause();
    timer.stop();
    vi.advanceTimersByTime(1000);
    expect(fn).not.toHaveBeenCalled();
    expect(timer.isRunning()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 61. swipe(): one gesture is one touch, and cancellation ends it.
// ---------------------------------------------------------------------------
describe("swipe touch identity", () => {
  type T = { identifier: number; clientX: number; clientY: number };
  function makeTarget() {
    const handlers: Record<string, Array<(e: unknown) => void>> = {};
    const el = {
      addEventListener: (type: string, h: (e: unknown) => void) => {
        (handlers[type] ||= []).push(h);
      },
      removeEventListener: (type: string, h: (e: unknown) => void) => {
        handlers[type] = (handlers[type] || []).filter((x) => x !== h);
      },
    } as unknown as HTMLElement;
    const fire = (type: string, touches: T[], changedTouches: T[]) => {
      for (const h of handlers[type] || []) h({ touches, changedTouches });
    };
    return { el, fire, handlers };
  }
  const touch = (identifier: number, clientX: number, clientY = 0): T => ({ identifier, clientX, clientY });

  it("a cancel followed by an unrelated touch end is not a swipe", () => {
    const { el, fire } = makeTarget();
    const onSwipe = vi.fn();
    swipe(el, { onSwipe });

    fire("touchstart", [touch(1, 0)], [touch(1, 0)]);
    fire("touchcancel", [], [touch(1, 0)]);
    fire("touchend", [], [touch(2, 100)]);

    expect(onSwipe).not.toHaveBeenCalled();
  });

  it("matches the initiating touch even when changedTouches is reordered", () => {
    const { el, fire } = makeTarget();
    const onSwipe = vi.fn();
    swipe(el, { threshold: 50, onSwipe });

    fire("touchstart", [touch(7, 0)], [touch(7, 0)]);
    fire("touchend", [], [touch(9, 0), touch(7, 120)]);

    expect(onSwipe).toHaveBeenCalledWith("right", 120);
  });

  it("an end without the initiating touch does not complete the gesture", () => {
    const { el, fire } = makeTarget();
    const onSwipe = vi.fn();
    swipe(el, { onSwipe });

    fire("touchstart", [touch(1, 0)], [touch(1, 0)]);
    fire("touchend", [touch(1, 0)], [touch(2, 200)]);
    expect(onSwipe).not.toHaveBeenCalled();

    fire("touchend", [], [touch(1, 90)]);
    expect(onSwipe).toHaveBeenCalledWith("right", 90);
  });

  it("a gesture that becomes multi-touch is rejected", () => {
    const { el, fire } = makeTarget();
    const onSwipe = vi.fn();
    swipe(el, { onSwipe });

    fire("touchstart", [touch(1, 0)], [touch(1, 0)]);
    fire("touchstart", [touch(1, 0), touch(2, 10)], [touch(2, 10)]);
    fire("touchend", [touch(2, 10)], [touch(1, 150)]);

    expect(onSwipe).not.toHaveBeenCalled();
  });

  it("an ordinary single-touch swipe still works", () => {
    const { el, fire } = makeTarget();
    const s = swipe(el, { threshold: 50 });
    fire("touchstart", [touch(3, 0, 0)], [touch(3, 0, 0)]);
    fire("touchend", [], [touch(3, 5, -80)]);
    expect(s.direction()).toBe("up");
  });

  it("dispose removes the cancel listener too", () => {
    const { el, handlers } = makeTarget();
    const s = swipe(el);
    expect(handlers.touchcancel).toHaveLength(1);
    s.dispose();
    expect(handlers.touchcancel).toHaveLength(0);
    expect(handlers.touchstart).toHaveLength(0);
    expect(handlers.touchend).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 63. scrollLock(): a failed lock leaves the shared count untouched.
// ---------------------------------------------------------------------------
describe("scrollLock failure is transactional", () => {
  beforeEach(() => {
    document.body.style.overflow = "";
    document.body.style.paddingRight = "";
  });

  it("a lock that throws for a missing body does not corrupt later locks", () => {
    const bodyDescriptor = Object.getOwnPropertyDescriptor(Document.prototype, "body")!;
    Object.defineProperty(document, "body", { configurable: true, get: () => null });
    try {
      expect(() => scrollLock().lock()).toThrow();
    } finally {
      delete (document as unknown as Record<string, unknown>).body;
      Object.defineProperty(Document.prototype, "body", bodyDescriptor);
    }

    const handle = scrollLock();
    handle.lock();
    expect(document.body.style.overflow).toBe("hidden");
    handle.unlock();
    expect(document.body.style.overflow).toBe("");
  });

  it("a style write that throws rolls back and does not count", () => {
    document.body.style.overflow = "scroll";
    const style = document.body.style;
    const original = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, "overflow");
    let fail = true;
    Object.defineProperty(style, "overflow", {
      configurable: true,
      get: () => "scroll",
      set: () => {
        if (fail) throw new Error("style locked");
      },
    });
    try {
      expect(() => scrollLock().lock()).toThrow("style locked");
    } finally {
      fail = false;
      delete (style as unknown as Record<string, unknown>).overflow;
      if (original) void original;
    }

    expect(document.body.style.paddingRight).toBe("");
    const handle = scrollLock();
    handle.lock();
    expect(document.body.style.overflow).toBe("hidden");
    handle.unlock();
    expect(document.body.style.overflow).toBe("scroll");
  });

  it("nested locking and restoration still work", () => {
    const a = scrollLock();
    const b = scrollLock();
    a.lock();
    b.lock();
    a.unlock();
    expect(document.body.style.overflow).toBe("hidden");
    b.unlock();
    expect(document.body.style.overflow).toBe("");
  });
});

// ---------------------------------------------------------------------------
// 64. Head({ title: "" }) clears the title.
// ---------------------------------------------------------------------------
describe("Head empty title", () => {
  it("a static empty title is applied and released on disposal", () => {
    document.title = "Previous";
    const anchor = Head({ title: "" });
    document.head.appendChild(anchor);
    expect(document.title).toBe("");
    dispose(anchor);
    anchor.remove();
    expect(document.title).toBe("Previous");
  });

  it("a reactive empty title behaves the same", () => {
    document.title = "Previous";
    const anchor = Head({ title: () => "" });
    expect(document.title).toBe("");
    dispose(anchor);
    expect(document.title).toBe("Previous");
  });

  it("overlapping empty and non-empty titles lease correctly", () => {
    document.title = "Base";
    const outer = Head({ title: "Outer" });
    const inner = Head({ title: "" });
    expect(document.title).toBe("");
    dispose(inner);
    expect(document.title).toBe("Outer");
    dispose(outer);
    expect(document.title).toBe("Base");
  });
});

// ---------------------------------------------------------------------------
// 65. setStructuredData() keeps the previous JSON-LD when serialization fails.
// ---------------------------------------------------------------------------
describe("setStructuredData atomic replacement", () => {
  const current = () => document.head.querySelectorAll('script[type="application/ld+json"][data-sibu]');

  beforeEach(() => {
    for (const el of Array.from(current())) el.remove();
  });

  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const FAILING: [string, Record<string, unknown>][] = [
    ["circular", circular],
    ["BigInt", { n: BigInt(1) }],
    [
      "throwing getter",
      Object.defineProperty({}, "boom", {
        enumerable: true,
        get() {
          throw new Error("getter");
        },
      }),
    ],
    [
      "throwing toJSON",
      {
        toJSON() {
          throw new Error("toJSON");
        },
      },
    ],
  ];

  for (const [label, bad] of FAILING) {
    it(`a ${label} payload throws and preserves the previous element`, () => {
      setStructuredData({ name: "valid" });
      const before = current()[0];

      expect(() => setStructuredData(bad)).toThrow();

      expect(current()).toHaveLength(1);
      expect(current()[0]).toBe(before);
      expect(before.textContent).toContain("valid");
    });
  }

  it("a successful update replaces the element in place", () => {
    const marker = document.createElement("meta");
    document.head.appendChild(marker);
    setStructuredData({ name: "first" });
    document.head.appendChild(document.createElement("link"));
    const first = current()[0];
    const next = first.nextSibling;

    setStructuredData({ name: "second" });

    expect(current()).toHaveLength(1);
    expect(current()[0].textContent).toContain("second");
    expect(current()[0].nextSibling).toBe(next);
  });

  it("still escapes script-breaking characters", () => {
    setStructuredData({ name: "</script><script>alert(1)</script>" });
    expect(current()[0].textContent).not.toContain("</script>");
  });
});
