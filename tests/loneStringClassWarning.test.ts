import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { div, span } from "../src/core/rendering/html";

// BUG 2 — a lone string argument is a TEXT child (unchanged behavior), but the
// framework warns in dev when that string looks like a misplaced class list so
// a styled empty wrapper doesn't silently render its class names as text.

describe("BUG 2 — lone class-like string warning (core tag)", () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it("renders a lone string as text (behavior unchanged)", () => {
    const el = div("space-y-6");
    expect(el.textContent).toBe("space-y-6");
  });

  it("warns when a lone string looks like a class list", () => {
    div("px-4 py-2");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("looks like a class list");
    expect(warn.mock.calls[0][0]).toContain('class: "px-4 py-2"');
  });

  it("warns for multi-token Tailwind-shaped strings", () => {
    div("h-6 w-48");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("h-6 w-48");
  });

  it("does NOT warn for a SINGLE token — a deliberate narrowing", () => {
    // `space-y-6` is a real class list and this used to warn. It no longer
    // does, because a single hyphen-and-digit token is indistinguishable from
    // the identifiers applications legitimately render as text: `item-0`,
    // `user-42`, `home-content`, `v4.1.0`. Warning on that shape measured 29.8%
    // false positives, and a list rendering `item-0`…`item-999` emitted a
    // thousand warnings — noise that trains developers to ignore the whole
    // diagnostic. Requiring two utility-shaped tokens takes false positives to
    // zero. See `tests/lone-string-heuristic-rate.test.ts` for the measurement.
    div("space-y-6");
    expect(warn).not.toHaveBeenCalled();
  });

  it("reports a repeated mistake once, not once per element", () => {
    for (let i = 0; i < 100; i++) div("mt-4 mb-4");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("does NOT warn for prose text", () => {
    div("Hello world");
    span("Click here to continue");
    expect(warn).not.toHaveBeenCalled();
  });

  it("does NOT warn for a single plain word (could be legit text)", () => {
    span("New");
    expect(warn).not.toHaveBeenCalled();
  });

  it("does NOT warn when a class string is passed positionally with children", () => {
    const el = div("space-y-6", [span("child")]);
    expect(el.getAttribute("class")).toBe("space-y-6");
    expect(el.textContent).toBe("child");
    expect(warn).not.toHaveBeenCalled();
  });

  it("does NOT warn when the class is passed via props", () => {
    const el = div({ class: "space-y-6" });
    expect(el.getAttribute("class")).toBe("space-y-6");
    expect(warn).not.toHaveBeenCalled();
  });
});
