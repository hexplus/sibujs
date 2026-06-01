import { describe, expect, it } from "vitest";
import { creditCardMask, dateMask, inputMask, phoneMask, ssnMask, timeMask, zipMask } from "../src/ui/inputMask";

function bindInput(mask: ReturnType<typeof inputMask>): { input: HTMLInputElement; dispose: () => void } {
  const input = document.createElement("input");
  document.body.appendChild(input);
  const dispose = mask.bind(input);
  return { input, dispose };
}

function typeInto(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.setSelectionRange(value.length, value.length);
  input.dispatchEvent(new Event("input"));
}

describe("inputMask digit pattern", () => {
  it("masks a phone number with literals", () => {
    const mask = inputMask(phoneMask());
    const { input, dispose } = bindInput(mask);
    typeInto(input, "1234567890");
    expect(mask.value()).toBe("(123) 456-7890");
    expect(mask.rawValue()).toBe("1234567890");
    expect(input.value).toBe("(123) 456-7890");
    dispose();
    document.body.removeChild(input);
  });

  it("strips non-digit characters for a date mask", () => {
    const mask = inputMask(dateMask());
    const { input, dispose } = bindInput(mask);
    typeInto(input, "ab12cd31ef2024");
    expect(mask.value()).toBe("12/31/2024");
    expect(mask.rawValue()).toBe("12312024");
    dispose();
    document.body.removeChild(input);
  });
});

describe("inputMask letter and any patterns", () => {
  it("keeps only letters for an A-only pattern", () => {
    const mask = inputMask({ pattern: "AAA" });
    const { input, dispose } = bindInput(mask);
    typeInto(input, "a1b2c3");
    expect(mask.value()).toBe("abc");
    expect(mask.rawValue()).toBe("abc");
    dispose();
    document.body.removeChild(input);
  });

  it("keeps digits and letters for a mixed 9/A pattern", () => {
    const mask = inputMask({ pattern: "9A9A" });
    const { input, dispose } = bindInput(mask);
    typeInto(input, "1a2b!!");
    expect(mask.value()).toBe("1a2b");
    dispose();
    document.body.removeChild(input);
  });

  it("accepts any character for a * pattern and strips its literals", () => {
    const mask = inputMask({ pattern: "**-**" });
    const { input, dispose } = bindInput(mask);
    typeInto(input, "ab-cd");
    expect(mask.value()).toBe("ab-cd");
    // raw extracts only slot positions
    expect(mask.rawValue()).toBe("abcd");
    dispose();
    document.body.removeChild(input);
  });

  it("handles a * pattern with no literals", () => {
    const mask = inputMask({ pattern: "***" });
    const { input, dispose } = bindInput(mask);
    typeInto(input, "x!z");
    expect(mask.value()).toBe("x!z");
    dispose();
    document.body.removeChild(input);
  });
});

describe("inputMask focus placeholder", () => {
  it("sets a placeholder built from the pattern when empty", () => {
    const mask = inputMask({ pattern: "99/99", placeholder: "#" });
    const { input, dispose } = bindInput(mask);
    input.dispatchEvent(new Event("focus"));
    expect(input.placeholder).toBe("##/##");
    dispose();
    document.body.removeChild(input);
  });

  it("does not override placeholder when input already has a value", () => {
    const mask = inputMask({ pattern: "9999" });
    const { input, dispose } = bindInput(mask);
    input.value = "12";
    input.dispatchEvent(new Event("focus"));
    expect(input.placeholder).toBe("");
    dispose();
    document.body.removeChild(input);
  });

  it("uses the default underscore placeholder", () => {
    const mask = inputMask({ pattern: "AA" });
    const { input, dispose } = bindInput(mask);
    input.dispatchEvent(new Event("focus"));
    expect(input.placeholder).toBe("__");
    dispose();
    document.body.removeChild(input);
  });
});

describe("inputMask cursor handling", () => {
  it("positions the cursor inside the masked value", () => {
    const mask = inputMask(phoneMask());
    const { input, dispose } = bindInput(mask);
    input.value = "123";
    input.setSelectionRange(3, 3);
    input.dispatchEvent(new Event("input"));
    expect(input.value).toBe("(123");
    expect(input.selectionStart).toBeGreaterThanOrEqual(0);
    dispose();
    document.body.removeChild(input);
  });

  it("handles a null selectionStart by falling back to value length", () => {
    const mask = inputMask({ pattern: "9999" });
    const input = document.createElement("input");
    Object.defineProperty(input, "selectionStart", { get: () => null, configurable: true });
    document.body.appendChild(input);
    const dispose = mask.bind(input);
    input.value = "12";
    input.dispatchEvent(new Event("input"));
    expect(mask.value()).toBe("12");
    dispose();
    document.body.removeChild(input);
  });
});

describe("preset masks", () => {
  it("returns expected patterns", () => {
    expect(phoneMask().pattern).toBe("(999) 999-9999");
    expect(dateMask().pattern).toBe("99/99/9999");
    expect(creditCardMask().pattern).toBe("9999 9999 9999 9999");
    expect(timeMask().pattern).toBe("99:99");
    expect(ssnMask().pattern).toBe("999-99-9999");
    expect(zipMask().pattern).toBe("99999");
  });

  it("credit card mask formats grouped digits", () => {
    const mask = inputMask(creditCardMask());
    const { input, dispose } = bindInput(mask);
    typeInto(input, "4111111111111111");
    expect(mask.value()).toBe("4111 1111 1111 1111");
    dispose();
    document.body.removeChild(input);
  });
});
