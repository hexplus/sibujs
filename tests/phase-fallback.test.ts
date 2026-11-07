import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type DirectiveTransition, when } from "../src/core/rendering/directives";
import { dispose } from "../src/core/rendering/dispose";
import { Fragment } from "../src/core/rendering/fragment";
import { div, span } from "../src/core/rendering/html";
import { type PendingContent, pendingContent } from "../src/core/rendering/pendingContent";
import { signal } from "../src/core/signals/signal";

// ---------------------------------------------------------------------------
// Where `getAnimations()` is missing (jsdom here), an element of a phase is
// done when every animation entry it runs reported an end OR a cancel event,
// or at its own estimated end (computed timing + 50 ms) if an event never
// arrives — once. Whether an ancestor is still animating decides whether
// content committed inside it joins the enter; a missed event used to keep it
// "animating" for the whole readiness window. The phase-wide cap still holds.
// ---------------------------------------------------------------------------

let host: HTMLElement;

beforeAll(() => {
  const sheet = document.createElement("style");
  sheet.textContent = [
    ".in { animation-name: rise; animation-duration: 0.2s; }",
    ".multi { animation-name: fade, slide; animation-duration: 0.1s, 1s; }",
    ".spin { animation-name: spin; animation-duration: 0.2s; animation-iteration-count: infinite; }",
    ".still { animation-name: rise; animation-duration: 0.01ms; }",
    ".heading.split { animation-name: rise; animation-duration: 0.1s; }",
    ".region.split { animation-name: rise; animation-duration: 1s; }",
  ].join("\n");
  document.head.appendChild(sheet);
});

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
});

afterEach(() => {
  dispose(host);
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const settle = async () => {
  for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(0);
};
const q = (selector: string) => host.querySelector(selector) as HTMLElement;
const fire = (el: Element, type: string, animationName?: string) => {
  const event = new Event(type);
  if (animationName !== undefined) Object.defineProperty(event, "animationName", { value: animationName });
  el.dispatchEvent(event);
};

/** Heading + region entering with `cls`; `holds` registrations on the region keep the window open. */
async function enter(cls: string, holds = 1, extra: Partial<DirectiveTransition> = {}) {
  const pending: PendingContent[] = [];
  const [on, setOn] = signal(false);
  host.appendChild(
    when(
      on,
      () => {
        const region = div({ class: "region" });
        for (let i = 0; i < holds; i++) pending.push(pendingContent(region));
        return Fragment([span({ class: "heading" }, "h"), region]);
      },
      { transition: { enterClass: cls, waitForContent: 3000, ...extra } },
    ),
  );
  await settle();
  setOn(true);
  await settle();
  return pending;
}

/** Commit `.row` content inside the region and settle `pending` with it. */
async function commitRow(pending: PendingContent, name: string) {
  const row = span({ class: name }, name);
  q(".region").append(row);
  pending.done([row]);
  await settle();
  return row;
}

describe("an ancestor whose end event never arrives", () => {
  it("is finished at its estimated end: later content inside it joins; earlier content does not", async () => {
    const [early, late] = await enter("in", 2);
    await vi.advanceTimersByTimeAsync(100);
    const before = await commitRow(early, "early");
    expect(before.classList.contains("in")).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    const after = await commitRow(late, "late");
    expect(after.classList.contains("in")).toBe(true);
  });

  it("an infinite animation keeps it animating until the phase's cap, which still ends the phase", async () => {
    const [pending] = await enter("spin", 1, { maxDuration: 1500 });
    await vi.advanceTimersByTimeAsync(1000);
    const row = await commitRow(pending, "row");
    expect(row.classList.contains("spin")).toBe(false);
    expect(q(".region").classList.contains("spin")).toBe(true);
    await vi.advanceTimersByTimeAsync(600);
    expect(host.querySelectorAll(".spin").length).toBe(0);
  });
});

describe("cancel events", () => {
  it("animationcancel finishes the ancestor: content committed afterwards joins", async () => {
    const [pending] = await enter("in");
    fire(q(".region"), "animationcancel");
    const row = await commitRow(pending, "row");
    expect(row.classList.contains("in")).toBe(true);
  });

  it("with several animation names, the ancestor is finished only when each one ended", async () => {
    const [first, second] = await enter("multi", 2);
    fire(q(".region"), "animationend", "fade");
    const during = await commitRow(first, "during");
    expect(during.classList.contains("multi")).toBe(false);
    fire(q(".region"), "animationcancel", "slide");
    const after = await commitRow(second, "after");
    expect(after.classList.contains("multi")).toBe(true);
  });
});

describe("completion happens once", () => {
  it("an end event and the element's estimate do not both count", async () => {
    const [on, setOn] = signal(false);
    host.appendChild(
      when(on, () => Fragment([span({ class: "heading" }, "h"), div({ class: "region" })]), {
        transition: { enterClass: "split" },
      }),
    );
    await settle();
    setOn(true);
    await settle();
    // The heading ends by its event; its estimate (≈150 ms) must not count
    // as a second completion, which would end the phase while the region
    // (1 s) is still animating.
    await vi.advanceTimersByTimeAsync(10);
    fire(q(".heading"), "animationend");
    await vi.advanceTimersByTimeAsync(400);
    expect(q(".region").classList.contains("split")).toBe(true);
    await vi.advanceTimersByTimeAsync(700);
    expect(host.querySelectorAll(".split").length).toBe(0);
  });

  it("a reduced-motion duration is no animation: nothing waits for it", async () => {
    const [pending] = await enter("still");
    const row = await commitRow(pending, "row");
    await settle();
    expect(row.classList.contains("still")).toBe(false);
    expect(host.querySelectorAll(".still").length).toBe(0);
  });

  it("disposal cancels the per-element estimates with the phase", async () => {
    await enter("in");
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    dispose(host);
    host.replaceChildren();
    await settle();
    expect(vi.getTimerCount()).toBe(0);
  });
});
