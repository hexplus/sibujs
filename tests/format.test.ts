import { describe, expect, it } from "vitest";
import { formatCurrency, formatNumber } from "../src/browser/format";

describe("formatNumber", () => {
  it("formats a number with default locale", () => {
    const result = formatNumber(1234.5);
    // Result is locale-dependent, but should contain the digits
    expect(result).toContain("1");
    expect(result).toContain("234");
  });

  it("formats with explicit locale", () => {
    const result = formatNumber(1234.5, { locale: "en-US" });
    expect(result).toBe("1,234.5");
  });

  it("formats as percent", () => {
    const result = formatNumber(0.85, { locale: "en-US", style: "percent" });
    expect(result).toBe("85%");
  });

  it("formats with decimal places", () => {
    const result = formatNumber(42, {
      locale: "en-US",
      minimumFractionDigits: 2,
    });
    expect(result).toBe("42.00");
  });
});

describe("formatCurrency", () => {
  it("formats USD", () => {
    const result = formatCurrency(9.99, "USD", { locale: "en-US" });
    expect(result).toBe("$9.99");
  });

  it("formats EUR with locale", () => {
    const result = formatCurrency(1234, "EUR", { locale: "de-DE" });
    // German locale uses . for thousands and , for decimals
    expect(result).toContain("1.234");
    expect(result).toContain("€");
  });
});
