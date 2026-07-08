import { describe, expect, it } from "vitest";
import { creditCardMask, dateMask, inputMask, phoneMask } from "../src/ui/inputMask";

describe("inputMask", () => {
  it("should apply phone mask", () => {
    const { value, bind } = inputMask(phoneMask());

    const input = document.createElement("input");
    bind(input);

    // Simulate input
    input.value = "1234567890";
    input.dispatchEvent(new Event("input"));

    expect(value()).toBe("(123) 456-7890");
  });

  it("should apply date mask", () => {
    const { value, bind } = inputMask(dateMask());

    const input = document.createElement("input");
    bind(input);

    input.value = "12252023";
    input.dispatchEvent(new Event("input"));

    expect(value()).toBe("12/25/2023");
  });

  it("should apply credit card mask", () => {
    const { value, bind } = inputMask(creditCardMask());

    const input = document.createElement("input");
    bind(input);

    input.value = "4111111111111111";
    input.dispatchEvent(new Event("input"));

    expect(value()).toBe("4111 1111 1111 1111");
  });

  it("should extract raw value", () => {
    const { rawValue, bind } = inputMask(phoneMask());

    const input = document.createElement("input");
    bind(input);

    input.value = "1234567890";
    input.dispatchEvent(new Event("input"));

    expect(rawValue()).toBe("1234567890");
  });
});
