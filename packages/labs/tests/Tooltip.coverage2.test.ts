import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tooltip } from "../src/widgets/Tooltip";

const makeEls = () => {
  const trigger = document.createElement("button");
  const tip = document.createElement("div");
  document.body.appendChild(trigger);
  document.body.appendChild(tip);
  return { trigger, tooltip: tip };
};

describe("tooltip bind coverage", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("wires aria attributes and role on bind", () => {
    const tip = tooltip();
    const els = makeEls();
    const teardown = tip.bind(els);
    expect(els.tooltip.getAttribute("role")).toBe("tooltip");
    expect(els.tooltip.id).toMatch(/^sibu-tooltip-\d+$/);
    expect(els.trigger.getAttribute("aria-describedby")).toBe(els.tooltip.id);
    teardown();
  });

  it("appends to an existing aria-describedby and restores on teardown", () => {
    const tip = tooltip();
    const els = makeEls();
    els.trigger.setAttribute("aria-describedby", "existing-id");
    const teardown = tip.bind(els);
    const describedBy = els.trigger.getAttribute("aria-describedby") ?? "";
    expect(describedBy.startsWith("existing-id ")).toBe(true);
    teardown();
    // Our id is spliced out; the prior id remains.
    expect(els.trigger.getAttribute("aria-describedby")).toBe("existing-id");
  });

  it("removes aria-describedby entirely when no prior value existed", () => {
    const tip = tooltip();
    const els = makeEls();
    const teardown = tip.bind(els);
    teardown();
    expect(els.trigger.hasAttribute("aria-describedby")).toBe(false);
  });

  it("toggles tooltip.hidden via the visibility effect", async () => {
    const tip = tooltip();
    const els = makeEls();
    tip.bind(els);
    // effect runs synchronously on bind -> hidden when not visible.
    expect(els.tooltip.hidden).toBe(true);
    tip.show();
    await Promise.resolve();
    expect(els.tooltip.hidden).toBe(false);
    tip.hide();
    await Promise.resolve();
    expect(els.tooltip.hidden).toBe(true);
  });

  it("shows on pointerenter and schedules hide on pointerleave", () => {
    vi.useFakeTimers();
    const tip = tooltip({ hideDelay: 100 });
    const els = makeEls();
    tip.bind(els);
    els.trigger.dispatchEvent(new Event("pointerenter"));
    expect(tip.isVisible()).toBe(true);
    els.trigger.dispatchEvent(new Event("pointerleave"));
    // Still visible until hideDelay elapses.
    expect(tip.isVisible()).toBe(true);
    vi.advanceTimersByTime(100);
    expect(tip.isVisible()).toBe(false);
  });

  it("keeps tooltip visible when pointer moves onto the tooltip", () => {
    vi.useFakeTimers();
    const tip = tooltip({ hideDelay: 100 });
    const els = makeEls();
    tip.bind(els);
    tip.show();
    els.trigger.dispatchEvent(new Event("pointerleave"));
    // Pointer enters the tooltip itself -> cancels pending hide.
    els.tooltip.dispatchEvent(new Event("pointerenter"));
    vi.advanceTimersByTime(100);
    expect(tip.isVisible()).toBe(true);
    // Leaving the tooltip schedules hide again.
    els.tooltip.dispatchEvent(new Event("pointerleave"));
    vi.advanceTimersByTime(100);
    expect(tip.isVisible()).toBe(false);
  });

  it("shows on focus and hides on blur", () => {
    const tip = tooltip();
    const els = makeEls();
    tip.bind(els);
    els.trigger.dispatchEvent(new Event("focus"));
    expect(tip.isVisible()).toBe(true);
    els.trigger.dispatchEvent(new Event("blur"));
    expect(tip.isVisible()).toBe(false);
  });

  it("dismisses on Escape when visible", () => {
    const tip = tooltip();
    const els = makeEls();
    tip.bind(els);
    tip.show();
    expect(tip.isVisible()).toBe(true);
    els.trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(tip.isVisible()).toBe(false);
  });

  it("ignores Escape when not visible and ignores other keys", () => {
    const tip = tooltip();
    const els = makeEls();
    tip.bind(els);
    els.trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(tip.isVisible()).toBe(false);
    tip.show();
    els.trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    expect(tip.isVisible()).toBe(true);
  });

  it("is idempotent: a second bind returns the same teardown", () => {
    const tip = tooltip();
    const els = makeEls();
    const t1 = tip.bind(els);
    const t2 = tip.bind(els);
    expect(t1).toBe(t2);
    t1();
  });

  it("teardown removes listeners so further events do nothing", () => {
    const tip = tooltip();
    const els = makeEls();
    const teardown = tip.bind(els);
    teardown();
    els.trigger.dispatchEvent(new Event("pointerenter"));
    expect(tip.isVisible()).toBe(false);
  });

  it("cancels a pending hide when show is called again", () => {
    vi.useFakeTimers();
    const tip = tooltip({ hideDelay: 100 });
    const els = makeEls();
    tip.bind(els);
    tip.show();
    els.trigger.dispatchEvent(new Event("pointerleave")); // schedule hide
    // show() again before hideDelay elapses -> clears the pending hide timer.
    tip.show();
    vi.advanceTimersByTime(200);
    expect(tip.isVisible()).toBe(true);
  });

  it("restores prior aria-describedby when the live value was stripped", () => {
    const tip = tooltip();
    const els = makeEls();
    els.trigger.setAttribute("aria-describedby", "prior-id");
    const teardown = tip.bind(els);
    // Simulate something external stripping the attribute entirely.
    els.trigger.removeAttribute("aria-describedby");
    teardown();
    // Teardown restores the prior value it captured at bind time.
    expect(els.trigger.getAttribute("aria-describedby")).toBe("prior-id");
  });

  it("cancels a pending show timer when scheduleHide fires", () => {
    vi.useFakeTimers();
    const tip = tooltip({ delay: 200, hideDelay: 50 });
    const els = makeEls();
    tip.bind(els);
    els.trigger.dispatchEvent(new Event("pointerenter")); // starts delayed show
    els.trigger.dispatchEvent(new Event("pointerleave")); // scheduleHide clears delay timer
    vi.advanceTimersByTime(300);
    expect(tip.isVisible()).toBe(false);
  });
});
