import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPlugin,
  createPluginRegistry,
  inject,
  plugin,
  resetPlugins,
  setDefaultPluginRegistry,
  triggerPluginError,
  triggerPluginMount,
  triggerPluginUnmount,
} from "../src/plugins/plugin";

describe("plugin registry coverage", () => {
  beforeEach(() => {
    resetPlugins();
  });

  afterEach(() => {
    resetPlugins();
    vi.restoreAllMocks();
  });

  it("createPlugin builds a plugin definition", () => {
    const install = vi.fn();
    const p = createPlugin("my-plugin", install);
    expect(p.name).toBe("my-plugin");
    expect(p.install).toBe(install);
  });

  it("installs a plugin and runs its init hooks immediately", () => {
    const reg = createPluginRegistry();
    const initSpy = vi.fn();
    reg.plugin(
      createPlugin("init-plugin", (ctx) => {
        ctx.onInit(initSpy);
      }),
    );
    expect(reg.installedPlugins.has("init-plugin")).toBe(true);
    expect(initSpy).toHaveBeenCalledTimes(1);
  });

  it("warns and skips when installing the same plugin twice", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const reg = createPluginRegistry();
    const install = vi.fn();
    const p = createPlugin("dup", install);
    reg.plugin(p);
    reg.plugin(p);
    expect(install).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("already installed"));
  });

  it("logs an init hook error without crashing", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const reg = createPluginRegistry();
    reg.plugin(
      createPlugin("bad-init", (ctx) => {
        ctx.onInit(() => {
          throw new Error("init boom");
        });
      }),
    );
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("init error"), expect.any(Error));
    expect(reg.installedPlugins.has("bad-init")).toBe(true);
  });

  it("provides and injects values", () => {
    const reg = createPluginRegistry();
    reg.plugin(
      createPlugin("provider", (ctx) => {
        ctx.provide("theme", "dark");
      }),
    );
    expect(reg.inject("theme")).toBe("dark");
  });

  it("inject returns default value when key missing", () => {
    const reg = createPluginRegistry();
    expect(reg.inject("missing", "fallback")).toBe("fallback");
  });

  it("inject throws when key missing and no default", () => {
    const reg = createPluginRegistry();
    expect(() => reg.inject("absent")).toThrow(/No provider found/);
  });

  it("triggers mount/unmount/error hooks", () => {
    const reg = createPluginRegistry();
    const mountHook = vi.fn();
    const unmountHook = vi.fn();
    const errorHook = vi.fn();
    reg.plugin(
      createPlugin("lifecycle", (ctx) => {
        ctx.onMount(mountHook);
        ctx.onUnmount(unmountHook);
        ctx.onError(errorHook);
      }),
    );
    const el = document.createElement("div");
    reg.triggerMount(el);
    reg.triggerUnmount(el);
    const err = new Error("hook error");
    reg.triggerError(err);
    expect(mountHook).toHaveBeenCalledWith(el);
    expect(unmountHook).toHaveBeenCalledWith(el);
    expect(errorHook).toHaveBeenCalledWith(err);
  });

  it("logs and continues when mount/unmount/error hooks throw", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const reg = createPluginRegistry();
    reg.plugin(
      createPlugin("throwing", (ctx) => {
        ctx.onMount(() => {
          throw new Error("m");
        });
        ctx.onUnmount(() => {
          throw new Error("u");
        });
        ctx.onError(() => {
          throw new Error("e");
        });
      }),
    );
    const el = document.createElement("div");
    reg.triggerMount(el);
    reg.triggerUnmount(el);
    reg.triggerError(new Error("orig"));
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Mount hook error"), expect.any(Error));
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Unmount hook error"), expect.any(Error));
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Error hook error"), expect.any(Error));
  });

  it("reset clears installed plugins, hooks, and provided values", () => {
    const reg = createPluginRegistry();
    reg.plugin(
      createPlugin("resettable", (ctx) => {
        ctx.provide("k", 1);
        ctx.onMount(vi.fn());
      }),
    );
    expect(reg.installedPlugins.size).toBe(1);
    reg.reset();
    expect(reg.installedPlugins.size).toBe(0);
    expect(reg.provided.size).toBe(0);
    expect(reg.hooks.mount.length).toBe(0);
  });

  it("default singleton API: plugin/inject/triggers/reset", () => {
    const mountHook = vi.fn();
    plugin(
      createPlugin("singleton", (ctx) => {
        ctx.provide("svc", { id: 1 });
        ctx.onMount(mountHook);
        ctx.onUnmount(vi.fn());
        ctx.onError(vi.fn());
      }),
    );
    expect(inject<{ id: number }>("svc").id).toBe(1);
    const el = document.createElement("div");
    triggerPluginMount(el);
    triggerPluginUnmount(el);
    triggerPluginError(new Error("x"));
    expect(mountHook).toHaveBeenCalledWith(el);
  });

  it("setDefaultPluginRegistry warns when replacing a touched non-empty singleton", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    plugin(createPlugin("touch", () => {}));
    const fresh = createPluginRegistry();
    setDefaultPluginRegistry(fresh);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Replacing default plugin registry"));
    // After swap, the new registry is used by the singleton API.
    fresh.plugin(
      createPlugin("on-fresh", (ctx) => {
        ctx.provide("flag", true);
      }),
    );
    expect(inject("flag")).toBe(true);
  });

  it("setDefaultPluginRegistry does not warn when singleton is empty", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setDefaultPluginRegistry(createPluginRegistry());
    expect(warn).not.toHaveBeenCalled();
  });
});
