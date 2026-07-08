import { describe, expect, it } from "vitest";
import { createPluginRegistry, plugin, resetPlugins, setDefaultPluginRegistry } from "../src/plugins/plugin";

describe("createPluginRegistry — isolated registries", () => {
  it("two registries do not share installed plugins", () => {
    const a = createPluginRegistry();
    const b = createPluginRegistry();

    a.plugin({ name: "shared", install: (ctx) => ctx.provide("scope", "A") });
    b.plugin({ name: "shared", install: (ctx) => ctx.provide("scope", "B") });

    expect(a.inject<string>("scope")).toBe("A");
    expect(b.inject<string>("scope")).toBe("B");
  });

  it("setDefaultPluginRegistry swaps the singleton's backing store", () => {
    resetPlugins();
    const isolated = createPluginRegistry();
    isolated.plugin({ name: "iso", install: (ctx) => ctx.provide("flag", "iso-value") });

    setDefaultPluginRegistry(isolated);
    // Singleton inject() now reads from the isolated registry.
    // (We can't call the singleton inject directly without going through its
    // public API — installing via the singleton plugin() should also land
    // on the isolated registry now.)
    plugin({ name: "via-singleton", install: (ctx) => ctx.provide("via", "single") });
    expect(isolated.inject<string>("via")).toBe("single");
    resetPlugins();
  });
});
