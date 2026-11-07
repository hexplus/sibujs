import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { when } from "../src/core/rendering/directives";
import { dispose } from "../src/core/rendering/dispose";
import { span } from "../src/core/rendering/html";
import { signal } from "../src/core/signals/signal";

// ---------------------------------------------------------------------------
// Leave timing follows CSS list matching.
//
// `transition-property` and `animation-name` decide HOW MANY transitions and
// animations an element runs; the duration / delay / iteration lists repeat to
// match them, and surplus entries are ignored. Counting the duration list
// instead truncated `transition: opacity, transform` with one shared duration
// to a single 200 ms transition: the opacity end event finished the phase and
// cut off the delayed transform, and the fallback timeout was too short.
//
// Computed styles are mocked here (jsdom resolves no animation timing); the
// real-engine counterpart lives in tests-browser/directive-transitions.spec.ts.
// ---------------------------------------------------------------------------

type Timing = Partial<
  Record<
    | "display"
    | "transitionProperty"
    | "transitionDuration"
    | "transitionDelay"
    | "animationName"
    | "animationDuration"
    | "animationDelay"
    | "animationIterationCount",
    string
  >
>;

const NONE: Timing = {
  display: "block",
  transitionProperty: "all",
  transitionDuration: "0s",
  transitionDelay: "0s",
  animationName: "none",
  animationDuration: "0s",
  animationDelay: "0s",
  animationIterationCount: "1",
};

let host: HTMLElement;
let leaving: Timing;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  leaving = NONE;
  const real = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((el: Element) =>
    el.classList.contains("out") ? ({ ...NONE, ...leaving } as CSSStyleDeclaration) : real(el),
  );
});

afterEach(() => {
  vi.useRealTimers();
  dispose(host);
  host.remove();
  vi.restoreAllMocks();
});

/** A `when` whose first branch leaves with `.out`; returns the leaving element and the switch. */
async function leaveWith(timing: Timing, maxDuration?: number) {
  leaving = timing;
  const [on, setOn] = signal(true);
  host.appendChild(
    when(
      () => on(),
      () => span("A"),
      { transition: { leaveClass: "out", maxDuration } },
    ),
  );
  await new Promise<void>((r) => setTimeout(r, 0));
  vi.useFakeTimers();
  const el = host.firstElementChild as HTMLElement;
  setOn(false);
  return el;
}

function fire(el: Element, type: "transitionend" | "animationend", name: string): void {
  const event = new Event(type);
  Object.defineProperty(event, type === "transitionend" ? "propertyName" : "animationName", { value: name });
  el.dispatchEvent(event);
}

describe("transitions: timing per transition-property entry", () => {
  const twoProps: Timing = {
    transitionProperty: "opacity, transform",
    transitionDuration: "0.2s",
    transitionDelay: "0s, 0.5s",
  };

  it("does not end when the first of two properties sharing one duration ends", async () => {
    const el = await leaveWith(twoProps);
    vi.advanceTimersByTime(200);
    fire(el, "transitionend", "opacity");
    expect(el.isConnected).toBe(true);
    vi.advanceTimersByTime(500);
    fire(el, "transitionend", "transform");
    expect(el.isConnected).toBe(false);
  });

  it("falls back to the delayed property's end (700 ms + 50 ms slack) when no event fires", async () => {
    const el = await leaveWith(twoProps);
    vi.advanceTimersByTime(749);
    expect(el.isConnected).toBe(true);
    vi.advanceTimersByTime(1);
    expect(el.isConnected).toBe(false);
  });

  it("ignores surplus duration entries", async () => {
    const el = await leaveWith({
      transitionProperty: "opacity",
      transitionDuration: "0.1s, 3s, 4s",
      transitionDelay: "0s",
    });
    vi.advanceTimersByTime(150);
    expect(el.isConnected).toBe(false);
  });

  it("an end event without a property name counts for one pending transition", async () => {
    const el = await leaveWith(twoProps);
    el.dispatchEvent(new Event("transitionend"));
    expect(el.isConnected).toBe(true);
    el.dispatchEvent(new Event("transitionend"));
    expect(el.isConnected).toBe(false);
  });

  it("matches a longhand event to its shorthand property", async () => {
    const el = await leaveWith({ transitionProperty: "margin", transitionDuration: "0.3s" });
    fire(el, "transitionend", "margin-top");
    expect(el.isConnected).toBe(false);
  });

  it("treats transition-property: none as no transition", async () => {
    const el = await leaveWith({ transitionProperty: "none", transitionDuration: "1s" });
    expect(el.isConnected).toBe(false);
  });

  it("waits for both a transition and an animation on the same element", async () => {
    const el = await leaveWith({
      transitionProperty: "opacity",
      transitionDuration: "0.2s",
      animationName: "spin",
      animationDuration: "0.4s",
    });
    fire(el, "transitionend", "opacity");
    expect(el.isConnected).toBe(true);
    fire(el, "animationend", "spin");
    expect(el.isConnected).toBe(false);
  });
});

describe("animations: timing per animation-name entry", () => {
  it("does not end before the second of two names sharing one duration (different delays)", async () => {
    const el = await leaveWith({
      animationName: "fade, slide",
      animationDuration: "0.2s",
      animationDelay: "0s, 0.3s",
    });
    fire(el, "animationend", "fade");
    expect(el.isConnected).toBe(true);
    fire(el, "animationend", "slide");
    expect(el.isConnected).toBe(false);
  });

  it("repeats the iteration list: the fallback covers 3 iterations of the second name", async () => {
    const el = await leaveWith({
      animationName: "fade, pulse",
      animationDuration: "0.1s",
      animationIterationCount: "1, 3",
    });
    vi.advanceTimersByTime(349);
    expect(el.isConnected).toBe(true);
    vi.advanceTimersByTime(1);
    expect(el.isConnected).toBe(false);
  });

  it("ignores surplus duration entries", async () => {
    const el = await leaveWith({ animationName: "fade", animationDuration: "0.1s, 4s" });
    vi.advanceTimersByTime(150);
    expect(el.isConnected).toBe(false);
  });
});

describe("unchanged behaviour", () => {
  it("instant and reduced-motion timings end synchronously", async () => {
    expect((await leaveWith({ animationName: "fade", animationDuration: "0s" })).isConnected).toBe(false);
    vi.useRealTimers();
    expect((await leaveWith({ animationName: "fade", animationDuration: "0.01ms" })).isConnected).toBe(false);
    vi.useRealTimers();
    expect(
      (await leaveWith({ transitionProperty: "opacity, transform", transitionDuration: "0.01ms" })).isConnected,
    ).toBe(false);
  });

  it("an infinite animation is capped by maxDuration, and at 5 s without one", async () => {
    const capped = await leaveWith(
      { animationName: "spin", animationDuration: "1s", animationIterationCount: "infinite" },
      120,
    );
    vi.advanceTimersByTime(120);
    expect(capped.isConnected).toBe(false);
    vi.useRealTimers();
    const hard = await leaveWith({
      animationName: "spin",
      animationDuration: "1s",
      animationIterationCount: "infinite",
    });
    vi.advanceTimersByTime(4999);
    expect(hard.isConnected).toBe(true);
    vi.advanceTimersByTime(1);
    expect(hard.isConnected).toBe(false);
  });

  it("a long computed timing is still capped by maxDuration", async () => {
    const el = await leaveWith({ transitionProperty: "opacity", transitionDuration: "2s" }, 300);
    vi.advanceTimersByTime(300);
    expect(el.isConnected).toBe(false);
  });

  it("disposing the directive cancels a pending leave without waiting", async () => {
    const el = await leaveWith({ transitionProperty: "opacity, transform", transitionDuration: "1s" });
    dispose(host);
    expect(el.isConnected).toBe(false);
    vi.advanceTimersByTime(5000);
  });
});
