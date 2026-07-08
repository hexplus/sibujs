import { describe, expect, it } from "vitest";
import { transition } from "../src/ui/transition";

describe("transition", () => {
  it("should return enter and leave functions", () => {
    const el = document.createElement("div");
    const { enter, leave } = transition(el);

    expect(typeof enter).toBe("function");
    expect(typeof leave).toBe("function");
  });

  it("should add and remove classes on enter/leave", async () => {
    const el = document.createElement("div");
    const { enter, leave } = transition(el, {
      duration: 10,
      enterClass: "entering",
      activeClass: "active",
      leaveClass: "leaving",
    });

    await enter();
    // After enter: activeClass should be set, enterClass removed
    expect(el.classList.contains("active")).toBe(true);
    expect(el.classList.contains("entering")).toBe(false);

    await leave();
    // After leave: activeClass removed, leaveClass removed
    expect(el.classList.contains("active")).toBe(false);
    expect(el.classList.contains("leaving")).toBe(false);
  });
});
