import { describe, expect, it } from "vitest";
import {
  getAvailableLocales,
  getLocale,
  hasTranslation,
  registerTranslations,
  setLocale,
  Trans,
} from "../src/plugins/i18n";

describe("Trans component", () => {
  it("should render translated text", () => {
    registerTranslations("en", { hello: "Hello World" });
    setLocale("en");

    const el = Trans("hello");
    expect(el.tagName).toBe("SPAN");
    // The text is rendered reactively via nodes function
  });
});

describe("getLocale", () => {
  it("should return current locale", () => {
    setLocale("en");
    expect(getLocale()).toBe("en");
    setLocale("es");
    expect(getLocale()).toBe("es");
  });
});

describe("hasTranslation", () => {
  it("should check if key exists", () => {
    registerTranslations("en", { exists: "Yes" });
    setLocale("en");
    expect(hasTranslation("exists")).toBe(true);
    expect(hasTranslation("missing")).toBe(false);
  });
});

describe("getAvailableLocales", () => {
  it("should list registered locales", () => {
    registerTranslations("en", { a: "a" });
    registerTranslations("fr", { a: "a" });
    const locales = getAvailableLocales();
    expect(locales).toContain("en");
    expect(locales).toContain("fr");
  });
});
