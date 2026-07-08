import { describe, expect, it } from "vitest";
import { getSlot } from "../src/core/rendering/slots";

describe("slots", () => {
  it("should return the correct slot function", () => {
    const slots = {
      default: () => "Hello",
      header: () => "Header content",
    };

    const defaultSlot = getSlot(slots, "default");
    const headerSlot = getSlot(slots, "header");
    const missingSlot = getSlot(slots, "footer");

    expect(defaultSlot?.()).toBe("Hello");
    expect(headerSlot?.()).toBe("Header content");
    expect(missingSlot).toBeUndefined();
  });
});
