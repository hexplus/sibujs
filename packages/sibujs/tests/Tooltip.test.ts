import { afterEach, describe, expect, it, vi } from "vitest";
import { tooltip } from "../src/widgets/Tooltip";

describe("tooltip", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts hidden with empty content", () => {
    const tip = tooltip();
    expect(tip.isVisible()).toBe(false);
    expect(tip.content()).toBe("");
  });

  it("shows and hides without delay", () => {
    const tip = tooltip();
    tip.show();
    expect(tip.isVisible()).toBe(true);

    tip.hide();
    expect(tip.isVisible()).toBe(false);
  });

  it("sets and reads content", () => {
    const tip = tooltip();
    tip.setContent("Hello tooltip");
    expect(tip.content()).toBe("Hello tooltip");
  });

  it("delays showing when delay option is set", () => {
    vi.useFakeTimers();
    const tip = tooltip({ delay: 500 });

    tip.show();
    expect(tip.isVisible()).toBe(false); // not yet visible

    vi.advanceTimersByTime(499);
    expect(tip.isVisible()).toBe(false);

    vi.advanceTimersByTime(1);
    expect(tip.isVisible()).toBe(true);
  });

  it("cancels delayed show when hide is called", () => {
    vi.useFakeTimers();
    const tip = tooltip({ delay: 500 });

    tip.show();
    vi.advanceTimersByTime(200);
    tip.hide(); // cancel the pending show

    vi.advanceTimersByTime(500);
    expect(tip.isVisible()).toBe(false);
  });
});
