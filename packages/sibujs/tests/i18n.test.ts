import { describe, expect, it } from "vitest";
import { registerTranslations, setLocale, t } from "../src/plugins/i18n";

describe("i18n", () => {
  it("should return translation for current locale", () => {
    registerTranslations("en", { greeting: "Hello" });
    registerTranslations("es", { greeting: "Hola" });

    setLocale("en");
    expect(t("greeting")).toBe("Hello");

    setLocale("es");
    expect(t("greeting")).toBe("Hola");
  });

  it("should support parameter replacement", () => {
    registerTranslations("en", { welcome: "Welcome, {name}!" });

    setLocale("en");
    expect(t("welcome", { name: "Fran" })).toBe("Welcome, Fran!");
  });

  it("should fallback to key if translation is missing", () => {
    setLocale("en");
    expect(t("not.found")).toBe("not.found");
  });

  it("should return updated value after locale switch", () => {
    registerTranslations("fr", { yes: "Oui" });
    registerTranslations("en", { yes: "Yes" });

    setLocale("fr");
    expect(t("yes")).toBe("Oui");

    setLocale("en");
    expect(t("yes")).toBe("Yes");
  });
});
