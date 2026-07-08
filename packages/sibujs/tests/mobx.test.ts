import { beforeEach, describe, expect, it, vi } from "vitest";
import { signal } from "@sibujs/core";
import type { MobXAdapterAPI, MobXReactionDisposer } from "../src/ecosystem/adapters/mobx";
import { mobXAdapter } from "../src/ecosystem/adapters/mobx";
import { inject, plugin, resetPlugins } from "../src/plugins/plugin";

/**
 * Hand-rolled fake MobX `autorun`. MobX is not installed; the adapter only
 * needs a function that runs the view synchronously once and returns a disposer.
 * We keep the registered views so tests can re-fire them to simulate an
 * observable change.
 */
function createFakeAutorun() {
  const disposers: Array<ReturnType<typeof vi.fn> & MobXReactionDisposer> = [];
  const views: Array<() => void> = [];

  function autorun(view: () => void): MobXReactionDisposer {
    view(); // MobX autorun invokes the view immediately
    views.push(view);
    const disposer = vi.fn() as ReturnType<typeof vi.fn> & MobXReactionDisposer;
    disposers.push(disposer);
    return disposer;
  }

  return { autorun, disposers, views };
}

describe("mobXAdapter", () => {
  beforeEach(() => {
    resetPlugins();
  });

  it("installs the plugin and provides a 'mobx' API", () => {
    const fake = createFakeAutorun();
    plugin(mobXAdapter({ autorun: fake.autorun }));
    const api = inject<MobXAdapterAPI>("mobx");
    expect(api).toBeDefined();
    expect(api.fromMobX).toBeTypeOf("function");
    expect(api.toMobX).toBeTypeOf("function");
    expect(api.destroy).toBeTypeOf("function");
  });

  it("fromMobX seeds the getter with the initial expression value", () => {
    const fake = createFakeAutorun();
    plugin(mobXAdapter({ autorun: fake.autorun }));
    const api = inject<MobXAdapterAPI>("mobx");

    const getter = api.fromMobX(() => 42);
    expect(getter()).toBe(42);
  });

  it("fromMobX getter updates when the autorun view re-fires", () => {
    const fake = createFakeAutorun();
    plugin(mobXAdapter({ autorun: fake.autorun }));
    const api = inject<MobXAdapterAPI>("mobx");

    let observable = 10;
    const getter = api.fromMobX(() => observable);
    expect(getter()).toBe(10);

    observable = 25;
    fake.views[0]!(); // simulate MobX re-running the reaction
    expect(getter()).toBe(25);
  });

  it("fromMobX getter carries a per-subscription dispose()", () => {
    const fake = createFakeAutorun();
    plugin(mobXAdapter({ autorun: fake.autorun }));
    const api = inject<MobXAdapterAPI>("mobx");

    const getter = api.fromMobX(() => 1);
    expect(getter.dispose).toBeTypeOf("function");

    getter.dispose();
    expect(fake.disposers[0]).toHaveBeenCalledTimes(1);
  });

  it("disposing one getter does not dispose the others", () => {
    const fake = createFakeAutorun();
    plugin(mobXAdapter({ autorun: fake.autorun }));
    const api = inject<MobXAdapterAPI>("mobx");

    const a = api.fromMobX(() => 1);
    api.fromMobX(() => 2);

    a.dispose();
    expect(fake.disposers[0]).toHaveBeenCalledTimes(1);
    expect(fake.disposers[1]).not.toHaveBeenCalled();
  });

  it("toMobX runs the callback immediately and on subsequent signal changes", () => {
    const fake = createFakeAutorun();
    plugin(mobXAdapter({ autorun: fake.autorun }));
    const api = inject<MobXAdapterAPI>("mobx");

    const [count, setCount] = signal(0);
    const callback = vi.fn();
    api.toMobX(count, callback);

    expect(callback).toHaveBeenCalledWith(0);

    setCount(7);
    expect(callback).toHaveBeenCalledWith(7);
  });

  it("toMobX returns a disposer that stops further callbacks", () => {
    const fake = createFakeAutorun();
    plugin(mobXAdapter({ autorun: fake.autorun }));
    const api = inject<MobXAdapterAPI>("mobx");

    const [count, setCount] = signal(0);
    const callback = vi.fn();
    const stop = api.toMobX(count, callback);

    callback.mockClear();
    stop();
    setCount(99);
    expect(callback).not.toHaveBeenCalled();
  });

  it("destroy() disposes every fromMobX subscription", () => {
    const fake = createFakeAutorun();
    plugin(mobXAdapter({ autorun: fake.autorun }));
    const api = inject<MobXAdapterAPI>("mobx");

    api.fromMobX(() => 1);
    api.fromMobX(() => 2);
    expect(fake.disposers.length).toBe(2);

    api.destroy();
    expect(fake.disposers[0]).toHaveBeenCalled();
    expect(fake.disposers[1]).toHaveBeenCalled();
  });
});
