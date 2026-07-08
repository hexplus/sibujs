import { describe, expect, it } from "vitest";
import { popover } from "../src/widgets/Popover";

describe("popover", () => {
  it("starts closed", () => {
    const pop = popover();
    expect(pop.isOpen()).toBe(false);
  });

  it("opens the popover", () => {
    const pop = popover();
    pop.open();
    expect(pop.isOpen()).toBe(true);
  });

  it("closes the popover", () => {
    const pop = popover();
    pop.open();
    pop.close();
    expect(pop.isOpen()).toBe(false);
  });

  it("toggles the popover state", () => {
    const pop = popover();
    pop.toggle();
    expect(pop.isOpen()).toBe(true);

    pop.toggle();
    expect(pop.isOpen()).toBe(false);
  });

  it("multiple opens do not break state", () => {
    const pop = popover();
    pop.open();
    pop.open();
    expect(pop.isOpen()).toBe(true);

    pop.close();
    expect(pop.isOpen()).toBe(false);
  });
});
