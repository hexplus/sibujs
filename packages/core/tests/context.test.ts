import { describe, expect, it } from "vitest";
import { context } from "../src/core/rendering/context";

describe("context", () => {
  it("should return the default value", () => {
    const ctx = context("light");
    expect(ctx.get()).toBe("light");
  });

  it("should provide and consume a value", () => {
    const ctx = context(0);
    ctx.provide(42);
    expect(ctx.get()).toBe(42);
  });

  it("should return a reactive getter from use()", () => {
    const ctx = context("en");
    const locale = ctx.use();

    expect(locale()).toBe("en");
    ctx.set("es");
    expect(locale()).toBe("es");
  });

  it("should work with complex types", () => {
    const ctx = context({ theme: "dark", fontSize: 14 });
    expect(ctx.get().theme).toBe("dark");

    ctx.set({ theme: "light", fontSize: 16 });
    expect(ctx.get().theme).toBe("light");
    expect(ctx.get().fontSize).toBe(16);
  });
});
