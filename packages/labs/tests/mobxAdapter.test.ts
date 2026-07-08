import { beforeEach, describe, expect, it, vi } from "vitest";
import { signal } from "@sibujs/core";
import type { MobXAdapterAPI } from "../src/ecosystem/adapters/mobx";
import { mobXAdapter } from "../src/ecosystem/adapters/mobx";
import { inject, plugin, resetPlugins } from "sibujs/plugins";

function createMockAutorun() {
  const disposers: ReturnType<typeof vi.fn>[] = [];
  const views: Array<() => void> = [];

  function autorun(view: () => void): () => void {
    view(); // MobX autorun runs immediately
    views.push(view);
    const disposer = vi.fn();
    disposers.push(disposer);
    return disposer;
  }

  return { autorun, disposers, views };
}

describe("mobXAdapter", () => {
  beforeEach(() => {
    resetPlugins();
  });

  it("should install plugin and provide API", () => {
    const mock = createMockAutorun();
    plugin(mobXAdapter({ autorun: mock.autorun }));
    const api = inject<MobXAdapterAPI>("mobx");
    expect(api).toBeDefined();
    expect(api.fromMobX).toBeTypeOf("function");
    expect(api.toMobX).toBeTypeOf("function");
    expect(api.destroy).toBeTypeOf("function");
  });

  it("should create reactive getter via fromMobX", () => {
    const mock = createMockAutorun();
    plugin(mobXAdapter({ autorun: mock.autorun }));
    const api = inject<MobXAdapterAPI>("mobx");

    const value = 42;
    const getter = api.fromMobX(() => value);
    expect(getter()).toBe(42);
  });

  it("should update getter when autorun re-fires", () => {
    const mock = createMockAutorun();
    plugin(mobXAdapter({ autorun: mock.autorun }));
    const api = inject<MobXAdapterAPI>("mobx");

    let value = 10;
    const getter = api.fromMobX(() => value);
    expect(getter()).toBe(10);

    // Simulate MobX observable change
    value = 20;
    mock.views[0](); // Re-trigger the autorun view
    expect(getter()).toBe(20);
  });

  it("should bridge SibuJS signal to callback via toMobX", () => {
    const mock = createMockAutorun();
    plugin(mobXAdapter({ autorun: mock.autorun }));
    const api = inject<MobXAdapterAPI>("mobx");

    const [count, setCount] = signal(0);
    const callback = vi.fn();
    api.toMobX(count, callback);

    // toMobX uses effect which runs immediately
    expect(callback).toHaveBeenCalledWith(0);

    setCount(5);
    expect(callback).toHaveBeenCalledWith(5);
  });

  it("should dispose all autorun subscriptions on destroy", () => {
    const mock = createMockAutorun();
    plugin(mobXAdapter({ autorun: mock.autorun }));
    const api = inject<MobXAdapterAPI>("mobx");

    api.fromMobX(() => 1);
    api.fromMobX(() => 2);
    expect(mock.disposers.length).toBe(2);

    api.destroy();
    expect(mock.disposers[0]).toHaveBeenCalled();
    expect(mock.disposers[1]).toHaveBeenCalled();
  });
});
