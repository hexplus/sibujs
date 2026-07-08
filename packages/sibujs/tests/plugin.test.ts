import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPlugin, inject, plugin, resetPlugins } from "../src/plugins/plugin";

describe("Plugin architecture", () => {
  beforeEach(() => {
    resetPlugins();
  });

  it("should create and install a plugin", () => {
    const initFn = vi.fn();
    const p = createPlugin("test-plugin", (ctx) => {
      ctx.onInit(initFn);
    });

    plugin(p);
    expect(initFn).toHaveBeenCalledOnce();
  });

  it("should provide and inject values", () => {
    const p = createPlugin("provider", (ctx) => {
      ctx.provide("apiUrl", "https://api.example.com");
    });

    plugin(p);
    expect(inject("apiUrl")).toBe("https://api.example.com");
  });

  it("should use default value for missing injection", () => {
    expect(inject("missing", "default")).toBe("default");
  });

  it("should throw for missing injection without default", () => {
    expect(() => inject("missing")).toThrow('No provider found for key "missing"');
  });

  it("should prevent duplicate installations", () => {
    const initFn = vi.fn();
    const p = createPlugin("dup", (ctx) => {
      ctx.onInit(initFn);
    });

    plugin(p);
    plugin(p); // Duplicate
    expect(initFn).toHaveBeenCalledTimes(1);
  });

  it("should pass options to plugin", () => {
    const p = createPlugin("opts", (ctx, options) => {
      ctx.provide("setting", options.value);
    });

    plugin(p, { value: 42 });
    expect(inject("setting")).toBe(42);
  });
});
