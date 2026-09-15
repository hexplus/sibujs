import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginRegistry, type SibuPlugin } from "../src/plugins/plugin";

// ---------------------------------------------------------------------------
// Plugin installation is a transaction.
//
// THE DEFECT: `install()` wrote hooks and providers straight into the live
// registry, and the plugin was marked installed only after `install()` returned.
// A throwing install left its hooks and providers active while the plugin was
// reported as not installed, a retry registered every surviving hook again, and
// a plugin that (directly or indirectly) installed itself recursed without end.
//
// TRANSACTION POLICY: each `plugin()` call is its own transaction. Hooks and
// providers registered by a plugin's `install()` are committed only if that
// `install()` returns. A dependency installed successfully by a nested
// `plugin()` call commits independently and stays installed even when the outer
// installation later fails.
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.restoreAllMocks();
});

describe("plugin installation transaction", () => {
  it("a throwing install leaves no hooks, providers or installed state", () => {
    const registry = createPluginRegistry();
    const init = vi.fn();
    const mount = vi.fn();
    const unmount = vi.fn();
    const onError = vi.fn();

    expect(() =>
      registry.plugin({
        name: "broken",
        install(ctx) {
          ctx.onInit(init);
          ctx.onMount(mount);
          ctx.onUnmount(unmount);
          ctx.onError(onError);
          ctx.provide("token", "partial");
          throw new Error("install failed");
        },
      }),
    ).toThrow("install failed");

    registry.triggerMount(document.body);
    registry.triggerUnmount(document.body);
    registry.triggerError(new Error("x"));

    expect(init).not.toHaveBeenCalled();
    expect(mount).not.toHaveBeenCalled();
    expect(unmount).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(registry.inject("token", "fallback")).toBe("fallback");
    expect(registry.installedPlugins.has("broken")).toBe(false);
    expect(registry.hooks.mount).toHaveLength(0);
    expect(registry.provided.size).toBe(0);
  });

  it("a failed install does not remove what earlier plugins registered", () => {
    const registry = createPluginRegistry();
    const goodMount = vi.fn();
    registry.plugin({
      name: "good",
      install(ctx) {
        ctx.onMount(goodMount);
        ctx.provide("shared", "good");
      },
    });

    expect(() =>
      registry.plugin({
        name: "bad",
        install(ctx) {
          ctx.provide("shared", "bad");
          throw new Error("nope");
        },
      }),
    ).toThrow();

    registry.triggerMount(document.body);
    expect(goodMount).toHaveBeenCalledTimes(1);
    expect(registry.inject("shared")).toBe("good");
  });

  it("retrying after a failure registers each hook once", () => {
    const registry = createPluginRegistry();
    const mount = vi.fn();
    let fail = true;
    const flaky: SibuPlugin = {
      name: "flaky",
      install(ctx) {
        ctx.onMount(mount);
        if (fail) throw new Error("first attempt fails");
      },
    };

    expect(() => registry.plugin(flaky)).toThrow();
    fail = false;
    registry.plugin(flaky);

    registry.triggerMount(document.body);
    expect(mount).toHaveBeenCalledTimes(1);
    expect(registry.installedPlugins.has("flaky")).toBe(true);
  });

  it("the plugin is marked installed before its init hooks run", () => {
    const registry = createPluginRegistry();
    let installedDuringInit: boolean | undefined;
    registry.plugin({
      name: "observer",
      install(ctx) {
        ctx.onInit(() => {
          installedDuringInit = registry.installedPlugins.has("observer");
        });
      },
    });

    expect(installedDuringInit).toBe(true);
  });

  it("direct recursive installation fails deterministically", () => {
    const registry = createPluginRegistry();
    const install = vi.fn((ctx: Parameters<SibuPlugin["install"]>[0]) => {
      ctx.provide("self", true);
      registry.plugin(self);
    });
    const self: SibuPlugin = { name: "self", install };

    expect(() => registry.plugin(self)).toThrow(/"self" is already being installed/);
    expect(install).toHaveBeenCalledTimes(1);
    expect(registry.installedPlugins.has("self")).toBe(false);
    expect(registry.provided.size).toBe(0);

    // The registry is not left locked.
    registry.plugin({ name: "self", install: () => {} });
    expect(registry.installedPlugins.has("self")).toBe(true);
  });

  it("indirect recursive installation fails deterministically", () => {
    const registry = createPluginRegistry();
    const a: SibuPlugin = { name: "a", install: () => registry.plugin(b) };
    const b: SibuPlugin = { name: "b", install: () => registry.plugin(a) };

    expect(() => registry.plugin(a)).toThrow(/"a" is already being installed/);
    expect(registry.installedPlugins.size).toBe(0);
  });

  it("a nested dependency installed successfully stays installed when the outer install fails", () => {
    const registry = createPluginRegistry();
    const depMount = vi.fn();
    const outerMount = vi.fn();
    const dependency: SibuPlugin = {
      name: "dependency",
      install(ctx) {
        ctx.onMount(depMount);
        ctx.provide("dep", "ready");
      },
    };

    expect(() =>
      registry.plugin({
        name: "outer",
        install(ctx) {
          registry.plugin(dependency);
          ctx.onMount(outerMount);
          throw new Error("outer failed");
        },
      }),
    ).toThrow("outer failed");

    registry.triggerMount(document.body);
    expect(registry.installedPlugins.has("dependency")).toBe(true);
    expect(registry.installedPlugins.has("outer")).toBe(false);
    expect(registry.inject("dep")).toBe("ready");
    expect(depMount).toHaveBeenCalledTimes(1);
    expect(outerMount).not.toHaveBeenCalled();
  });

  it("a successful nested dependency commits before the outer plugin's hooks", () => {
    const registry = createPluginRegistry();
    const order: string[] = [];
    registry.plugin({
      name: "outer",
      install(ctx) {
        ctx.onMount(() => order.push("outer"));
        registry.plugin({ name: "inner", install: (inner) => inner.onMount(() => order.push("inner")) });
      },
    });

    registry.triggerMount(document.body);
    expect(order).toEqual(["inner", "outer"]);
  });
});
