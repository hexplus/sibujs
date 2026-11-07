import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { when } from "../src/core/rendering/directives";
import { dispose } from "../src/core/rendering/dispose";
import { Fragment } from "../src/core/rendering/fragment";
import { div, span } from "../src/core/rendering/html";
import { type PendingContent, pendingContent } from "../src/core/rendering/pendingContent";
import { signal } from "../src/core/signals/signal";
import { structuralBinding } from "../src/reactivity/track";

// ---------------------------------------------------------------------------
// The `waitForContent` budget of a custom enter is bounded by its own timer.
// Its expiry used to be decided by re-reading `Date.now()` in the timer
// callback; when the clock said "not yet" (a timer delivered early, the wall
// clock moved back) the wait re-armed nothing and hung until some other
// readiness notification arrived — possibly never. Deterministic: fake
// timers, clocks mocked separately where a test needs them to disagree.
// ---------------------------------------------------------------------------

let host: HTMLElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  dispose(host);
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Microtasks and zero-delay timers, without moving fake time forward. */
const settle = async () => {
  for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(0);
};

/** A custom enter waiting for a registration that never settles. */
async function waitingEnter(budget: number) {
  let pending!: PendingContent;
  const [on, setOn] = signal(false);
  const enter = vi.fn();
  host.appendChild(
    when(
      on,
      () => {
        const region = div({ class: "region" });
        pending = pendingContent(region);
        return Fragment([span({ class: "heading" }, "h"), region]);
      },
      { transition: { enter, waitForContent: budget } },
    ),
  );
  await settle();
  setOn(true);
  await settle();
  return { enter, setOn, pending: () => pending };
}

describe("custom enter budget", () => {
  it("expires on time with no notification at all", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const { enter } = await waitingEnter(300);
    await vi.advanceTimersByTimeAsync(299);
    expect(enter).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(enter).toHaveBeenCalledTimes(1);
  });

  it("a timer delivered while the clocks still read the start does not strand the wait", async () => {
    // Timers advance; neither clock does — the timer fires "early" by them.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const start = Date.now();
    const perf = performance.now();
    vi.spyOn(Date, "now").mockReturnValue(start);
    vi.spyOn(performance, "now").mockReturnValue(perf);
    const { enter } = await waitingEnter(300);
    await vi.advanceTimersByTimeAsync(300);
    await settle();
    expect(enter).toHaveBeenCalledTimes(1);
  });

  it("a wall clock moved back after the switch does not stretch or strand the wait", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const start = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(start);
    const { enter } = await waitingEnter(300);
    now.mockReturnValue(start - 3_600_000);
    await vi.advanceTimersByTimeAsync(300);
    await settle();
    expect(enter).toHaveBeenCalledTimes(1);
  });

  it("notifications and registrations during the wait do not extend it; the enter runs once", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const { enter } = await waitingEnter(300);
    await vi.advanceTimersByTimeAsync(200);
    // A registration made (and moved) inside the branch while it waits.
    const late = div({ class: "late" });
    const latePending = pendingContent(late);
    host.querySelector(".region")?.append(late);
    await settle();
    await vi.advanceTimersByTimeAsync(100);
    await settle();
    expect(enter).toHaveBeenCalledTimes(1);
    latePending.done();
    await vi.advanceTimersByTimeAsync(1000);
    expect(enter).toHaveBeenCalledTimes(1);
  });

  it("a budget that runs out while an enclosing branch is paused waits for the resume", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const [inner, setInner] = signal(false);
    const enter = vi.fn();
    // The enclosing lifecycle: what a leaving branch (or a suspended
    // KeepAlive page) does to the subtree it owns.
    const outer = structuralBinding(() => {});
    host.appendChild(
      outer.run(() =>
        when(
          inner,
          () => {
            const region = div({ class: "region" });
            pendingContent(region);
            return Fragment([span({ class: "heading" }, "h"), region]);
          },
          { transition: { enter, waitForContent: 300 } },
        ),
      ),
    );
    await settle();
    setInner(true);
    await settle();
    outer.freeze?.();
    await vi.advanceTimersByTimeAsync(400);
    await settle();
    // Expired while paused: no user code runs before the resume.
    expect(enter).not.toHaveBeenCalled();
    outer.thaw?.();
    await settle();
    expect(enter).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(enter).toHaveBeenCalledTimes(1);
  });

  it("a switch during the wait cancels its timer and listeners", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const { enter, setOn } = await waitingEnter(300);
    setOn(false);
    await settle();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(enter).not.toHaveBeenCalled();
  });

  it("disposing the directive during the wait cancels its timer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const { enter } = await waitingEnter(300);
    dispose(host);
    host.replaceChildren();
    await settle();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(enter).not.toHaveBeenCalled();
  });
});
