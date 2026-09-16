import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { swipe } from "../src/browser/swipe";
import { urlState } from "../src/browser/urlState";
import { setRuntimeErrorHandler } from "../src/core/errors";
import { dispose, registerDisposer, withDisposerRollback } from "../src/core/rendering/dispose";
import { div } from "../src/core/rendering/html";
import { effect } from "../src/core/signals/effect";
import { signal } from "../src/core/signals/signal";
import type { ReactiveSignal } from "../src/reactivity/signal";
import { forEachSubscriber } from "../src/reactivity/track-core";

// A signal accessor carries its node on `__signal` (see core/signals/signal.ts).
const signalNode = (accessor: unknown): ReactiveSignal => (accessor as { __signal: ReactiveSignal }).__signal;

import { defineElement } from "../src/platform/customElement";
import { Head } from "../src/platform/head";
import { createISR } from "../src/platform/incrementalRegeneration";
import { renderToDocument } from "../src/platform/ssr";
import { createPluginRegistry, PluginInstallCancelledError } from "../src/plugins/plugin";
import { createMigrationRunner } from "../src/plugins/versioning";
import { checkFormLabels, checkKeyboardAccess } from "../src/testing/a11y";
import { createHttpMock } from "../src/testing/e2e";
import { hotkey } from "../src/ui/a11y";
import { TransitionGroup } from "../src/ui/TransitionGroup";
import { tooltip } from "../src/widgets/Tooltip";

let handler: ReturnType<typeof vi.fn>;
beforeEach(() => {
  handler = vi.fn();
  setRuntimeErrorHandler(handler);
});
afterEach(() => {
  setRuntimeErrorHandler(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

let elementId = 0;
const uniqueTag = () => `x-branch-review-${++elementId}`;

// ---------------------------------------------------------------------------
// customElement: self-written attributes, bounded feedback, retry after failure.
// ---------------------------------------------------------------------------
describe("defineElement render reentrancy", () => {
  it("a component mirroring state onto an observed host attribute renders once per change", () => {
    const tag = uniqueTag();
    const renders = vi.fn();
    defineElement(
      tag,
      (props, host) => {
        renders();
        host.setAttribute("state", props.open ? "open" : "closed");
        return div(String(props.open ?? "")) as HTMLElement;
      },
      { observedAttributes: ["open", "state"] },
    );
    const el = document.createElement(tag);
    document.body.appendChild(el);
    const initial = renders.mock.calls.length;

    el.setAttribute("open", "1");
    // One render for the change, plus at most one follow-up for the mirrored value.
    expect(renders.mock.calls.length - initial).toBeLessThanOrEqual(2);
    expect(el.getAttribute("state")).toBe("open");
    expect(handler).not.toHaveBeenCalled();
  });

  it("a component that changes its own attribute on every render is stopped and reported", () => {
    const tag = uniqueTag();
    let n = 0;
    const renders = vi.fn();
    defineElement(
      tag,
      (_props, host) => {
        renders();
        host.setAttribute("tick", String(++n));
        return div() as HTMLElement;
      },
      { observedAttributes: ["tick"] },
    );
    const el = document.createElement(tag);
    expect(() => document.body.appendChild(el)).not.toThrow();
    expect(renders.mock.calls.length).toBeLessThanOrEqual(10);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][1]).toMatchObject({ phase: "render" });
  });

  it("a failed first render is retried when an attribute changes", () => {
    const tag = uniqueTag();
    defineElement(
      tag,
      (props) => {
        if (props.bad !== undefined) throw new Error("bad input");
        return div("ok") as HTMLElement;
      },
      { observedAttributes: ["bad"], shadow: false },
    );
    const el = document.createElement(tag);
    el.setAttribute("bad", "");
    document.body.appendChild(el);
    expect(el.textContent).toBe("");
    expect(handler).toHaveBeenCalledTimes(1);

    el.removeAttribute("bad");
    expect(el.textContent).toBe("ok");
  });

  it("a component that removes its own host while rendering leaves no live subtree", () => {
    const tag = uniqueTag();
    const [label, setLabel] = signal("a");
    let bindings = 0;
    defineElement(
      tag,
      (_props, host) => {
        host.remove();
        const node = div(() => {
          bindings++;
          return label();
        }) as HTMLElement;
        return node;
      },
      { shadow: false },
    );
    const el = document.createElement(tag);
    document.body.appendChild(el);

    expect(el.isConnected).toBe(false);
    expect(el.childNodes).toHaveLength(0);
    const before = bindings;
    expect(before).toBeGreaterThan(0);
    // The discarded build was disposed: its binding no longer reacts.
    setLabel("b");
    expect(bindings).toBe(before);
  });

  it("a component that moves its own host while rendering renders again without nesting", () => {
    const tag = uniqueTag();
    const renders = vi.fn();
    const parkA = document.createElement("section");
    const parkB = document.createElement("section");
    document.body.append(parkA, parkB);
    defineElement(
      tag,
      (_props, host) => {
        renders();
        if (host.parentNode === parkA) parkB.appendChild(host);
        return div("moved") as HTMLElement;
      },
      { shadow: false },
    );
    const el = document.createElement(tag);
    expect(() => parkA.appendChild(el)).not.toThrow();
    expect(el.parentNode).toBe(parkB);
    expect(el.textContent).toBe("moved");
    expect(renders.mock.calls.length).toBeLessThanOrEqual(3);
    expect(handler).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Rollback ignores registrations made by unrelated reactive re-runs.
// ---------------------------------------------------------------------------
describe("withDisposerRollback scope", () => {
  it("a failed render does not tear down bindings an effect re-registered on live DOM", () => {
    const live = document.createElement("div");
    document.body.appendChild(live);
    const [s, set] = signal(0);
    const torn = vi.fn();
    const stop = effect(() => {
      if (s() > 0) registerDisposer(live, torn);
    });

    expect(() =>
      withDisposerRollback(() => {
        set(1);
        throw new Error("render failed");
      }),
    ).toThrow("render failed");

    expect(torn).not.toHaveBeenCalled();
    dispose(live);
    expect(torn).toHaveBeenCalledTimes(1);
    stop();
  });

  it("an effect created BY the build is rolled back, including a later re-run's cleanup", () => {
    const node = document.createElement("div");
    const cleanup = vi.fn();
    const [value, setValue] = signal(0);

    expect(() =>
      withDisposerRollback(() => {
        const stop = effect(() => {
          if (value() === 1) registerDisposer(node, cleanup);
        });
        registerDisposer(node, stop);
        setValue(1); // the transaction's own effect re-runs here
        throw new Error("render failed");
      }),
    ).toThrow("render failed");

    expect(cleanup).toHaveBeenCalledTimes(1);
    // Exactly once: the rollback already ran it, so disposing the node does not.
    dispose(node);
    expect(cleanup).toHaveBeenCalledTimes(1);
    // The effect itself was stopped by the rollback.
    setValue(2);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("nested transactions keep the right owner for each effect", () => {
    const node = document.createElement("div");
    const order: string[] = [];
    const [value, setValue] = signal(0);
    let stopOuter = () => {};

    withDisposerRollback(() => {
      stopOuter = effect(() => {
        if (value() > 0) registerDisposer(node, () => order.push("outer effect"));
      });
      expect(() =>
        withDisposerRollback(() => {
          const stopInner = effect(() => {
            if (value() > 0) registerDisposer(node, () => order.push("inner effect"));
          });
          registerDisposer(node, stopInner);
          setValue(1); // re-runs BOTH effects
          throw new Error("inner failed");
        }),
      ).toThrow("inner failed");
    });

    // Only the inner transaction's registrations were rolled back.
    expect(order).toEqual(["inner effect"]);
    dispose(node);
    expect(order).toEqual(["inner effect", "outer effect"]);
    stopOuter();
  });

  it("a successful inner transaction hands its effects to the outer one", () => {
    const node = document.createElement("div");
    const cleanup = vi.fn();
    const [value, setValue] = signal(0);

    expect(() =>
      withDisposerRollback(() => {
        withDisposerRollback(() => {
          const stop = effect(() => {
            if (value() === 1) registerDisposer(node, cleanup);
          });
          registerDisposer(node, stop);
        });
        setValue(1); // the inner transaction's effect re-runs here
        throw new Error("outer failed");
      }),
    ).toThrow("outer failed");

    expect(cleanup).toHaveBeenCalledTimes(1);
    dispose(node);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("three nested successful transactions hand ownership up to a failing ancestor", () => {
    const node = document.createElement("div");
    const cleanup = vi.fn();
    const [value, setValue] = signal(0);

    expect(() =>
      withDisposerRollback(() => {
        withDisposerRollback(() => {
          withDisposerRollback(() => {
            const stop = effect(() => {
              if (value() === 1) registerDisposer(node, cleanup);
            });
            registerDisposer(node, stop);
          });
        });
        setValue(1);
        throw new Error("ancestor failed");
      }),
    ).toThrow("ancestor failed");

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("after the outermost transaction succeeds, later re-runs are captured by nobody", () => {
    const node = document.createElement("div");
    const cleanup = vi.fn();
    const [value, setValue] = signal(0);
    let stop = () => {};

    withDisposerRollback(() => {
      withDisposerRollback(() => {
        stop = effect(() => {
          if (value() > 0) registerDisposer(node, cleanup);
        });
      });
    });

    setValue(1);
    expect(cleanup).not.toHaveBeenCalled();
    // A later failing transaction does not own that registration either.
    expect(() =>
      withDisposerRollback(() => {
        setValue(2);
        throw new Error("unrelated failure");
      }),
    ).toThrow();
    expect(cleanup).not.toHaveBeenCalled();

    dispose(node);
    expect(cleanup).toHaveBeenCalledTimes(2);
    stop();
  });

  it("a successful transaction's frame stops referencing its nodes and teardowns", () => {
    const sibling = document.createElement("div");
    const cleanup = vi.fn();
    const [source] = signal(0);
    let subscriber: { _cap?: { entries: unknown[] } } | undefined;

    const keeper = document.createElement("div");
    withDisposerRollback(() => {
      const stop = effect(() => {
        source();
      });
      // The effect outlives the sibling: its teardown belongs to another node.
      registerDisposer(keeper, stop);
      registerDisposer(sibling, cleanup);
    });
    dispose(sibling);
    expect(cleanup).toHaveBeenCalledTimes(1);

    // The surviving effect's capture must not retain the disposed sibling.
    forEachSubscriber(signalNode(source), (sub) => {
      subscriber = sub as { _cap?: { entries: unknown[] } };
    });
    expect(subscriber, "the effect must still be subscribed").toBeDefined();
    expect(subscriber?._cap, "it must still remember its transaction").toBeDefined();
    expect(subscriber?._cap?.entries).toEqual([]);
    dispose(keeper);
  });

  it("a nested successful transaction releases its own entries but still forwards", () => {
    const node = document.createElement("div");
    const cleanup = vi.fn();
    const [value, setValue] = signal(0);
    let innerCapture: { entries: unknown[] } | undefined;

    expect(() =>
      withDisposerRollback(() => {
        withDisposerRollback(() => {
          const stop = effect(() => {
            if (value() === 1) registerDisposer(node, cleanup);
          });
          registerDisposer(node, stop);
          forEachSubscriber(signalNode(value), (sub) => {
            innerCapture = (sub as { _cap?: { entries: unknown[] } })._cap;
          });
        });
        // The inner frame kept nothing, yet its effect still registers upward.
        expect(innerCapture?.entries).toEqual([]);
        setValue(1);
        throw new Error("outer failed");
      }),
    ).toThrow("outer failed");

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("a node disposed during the build is not torn down twice by an effect re-run", () => {
    const node = document.createElement("div");
    const cleanup = vi.fn();
    const [value, setValue] = signal(0);
    expect(() =>
      withDisposerRollback(() => {
        effect(() => {
          if (value() === 1) registerDisposer(node, cleanup);
        });
        setValue(1);
        dispose(node); // runs the cleanup already
        throw new Error("render failed");
      }),
    ).toThrow();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("registrations made directly by the build are still rolled back", () => {
    const node = document.createElement("div");
    const own = vi.fn();
    expect(() =>
      withDisposerRollback(() => {
        registerDisposer(node, own);
        throw new Error("render failed");
      }),
    ).toThrow();
    expect(own).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Plugins can register after install() returns.
// ---------------------------------------------------------------------------
describe("plugin context after commit", () => {
  it("hooks and providers registered after install() reach the live registry", () => {
    const registry = createPluginRegistry();
    let saved: Parameters<Parameters<typeof registry.plugin>[0]["install"]>[0] | undefined;
    const lateInit = vi.fn();
    registry.plugin({
      name: "late",
      install(ctx) {
        saved = ctx;
        ctx.onInit(() => {
          ctx.provide("k", 1);
          ctx.onInit(lateInit);
        });
      },
    });
    expect(registry.inject("k")).toBe(1);
    // An init hook registered by an init hook is recorded, not run in the same loop.
    expect(lateInit).not.toHaveBeenCalled();
    expect(registry.hooks.init).toContain(lateInit);

    const mount = vi.fn();
    saved?.onMount(mount);
    registry.triggerMount(document.createElement("div"));
    expect(mount).toHaveBeenCalledTimes(1);
  });

  it("an async install commits only after it fulfils", async () => {
    const registry = createPluginRegistry();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const init = vi.fn();
    const result = registry.plugin({
      name: "async-ok",
      async install(ctx) {
        ctx.provide("early", 1);
        ctx.onInit(init);
        await gate;
        ctx.provide("late", 2);
      },
    });
    expect(registry.installedPlugins.has("async-ok")).toBe(false);
    expect(registry.provided.has("early")).toBe(false);
    expect(init).not.toHaveBeenCalled();

    release();
    await result;
    // Registrations from before and after the await commit together.
    expect(registry.inject("early")).toBe(1);
    expect(registry.inject("late")).toBe(2);
    expect(init).toHaveBeenCalledTimes(1);
  });

  it("a rejected async install commits nothing, is reported, and stays retryable", async () => {
    const registry = createPluginRegistry();
    const install = vi.fn(async (ctx: { provide: (k: string, v: unknown) => void }) => {
      ctx.provide("partial", true);
      await Promise.resolve();
      throw new Error("install failed");
    });
    const failing = { name: "flaky", install } as unknown as Parameters<typeof registry.plugin>[0];
    // Ignoring the returned promise must not produce an unhandled rejection.
    registry.plugin(failing);
    await new Promise((r) => setTimeout(r, 0));

    expect(registry.installedPlugins.has("flaky")).toBe(false);
    expect(registry.provided.has("partial")).toBe(false);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][1]).toMatchObject({ phase: "async", name: "plugin(flaky)" });

    // Retryable, and an awaited install still rejects.
    handler.mockClear();
    await expect(registry.plugin(failing)).rejects.toThrow("install failed");
    expect(install).toHaveBeenCalledTimes(2);
  });

  it("a second install while the first is still pending is rejected", async () => {
    const registry = createPluginRegistry();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const plugin = { name: "slow", install: async () => gate };
    const first = registry.plugin(plugin);
    expect(() => registry.plugin(plugin)).toThrow(/already being installed/);
    release();
    await first;
    expect(registry.installedPlugins.has("slow")).toBe(true);
  });

  it("a hostile thenable from install() is reported and commits nothing", async () => {
    const registry = createPluginRegistry();
    registry.plugin({
      name: "hostile",
      install: (ctx) => {
        ctx.provide("nope", 1);
        return {
          // biome-ignore lint/suspicious/noThenProperty: a hostile thenable is the subject under test
          get then() {
            throw new Error("hostile getter");
          },
        } as unknown as PromiseLike<void>;
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(registry.installedPlugins.has("hostile")).toBe(false);
    expect(registry.provided.has("nope")).toBe(false);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("reset() is terminal for a pending install and for retained contexts", async () => {
    const registry = createPluginRegistry();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const pending = registry.plugin({
      name: "slow",
      async install(ctx) {
        ctx.provide("stale", true);
        await gate;
      },
    });

    let retained!: Parameters<Parameters<typeof registry.plugin>[0]["install"]>[0];
    registry.plugin({
      name: "old",
      install(ctx) {
        retained = ctx;
      },
    });

    registry.reset();
    release();
    await expect(pending).rejects.toThrow(/cancelled/);

    expect(registry.installedPlugins.has("slow")).toBe(false);
    expect(registry.provided.has("stale")).toBe(false);

    retained.provide("resurrected", true);
    retained.onMount(() => {});
    expect(registry.provided.has("resurrected")).toBe(false);
    expect(registry.hooks.mount).toHaveLength(0);
  });

  it("a rejected install settling after reset() leaves the new generation alone", async () => {
    const registry = createPluginRegistry();
    let fail!: (e: unknown) => void;
    const gate = new Promise<void>((_r, reject) => {
      fail = reject;
    });
    registry.plugin({ name: "shared", install: async () => gate });
    registry.reset();

    // The same name installs immediately after the reset.
    registry.plugin({
      name: "shared",
      install(ctx) {
        ctx.provide("fresh", 1);
      },
    });
    expect(registry.inject("fresh")).toBe(1);

    fail(new Error("old install failed"));
    await new Promise((r) => setTimeout(r, 0));

    // The replacement survives the old installation's failure.
    expect(registry.installedPlugins.has("shared")).toBe(true);
    expect(registry.inject("fresh")).toBe(1);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("the singleton plugin() returns the installation's completion", async () => {
    const { plugin, inject } = await import("../src/plugins/plugin");
    const name = `singleton-${Math.random().toString(36).slice(2)}`;
    const completion = plugin({
      name,
      async install(ctx) {
        await Promise.resolve();
        ctx.provide(`${name}-ready`, true);
      },
    });
    expect(completion).toBeInstanceOf(Promise);
    await completion;
    expect(inject(`${name}-ready`)).toBe(true);

    const failingName = `${name}-bad`;
    await expect(
      plugin({
        name: failingName,
        async install() {
          await Promise.resolve();
          throw new Error("singleton install failed");
        },
      }),
    ).rejects.toThrow("singleton install failed");
    expect(handler).toHaveBeenCalled();
  });

  it("a plugin that resets the registry inside install() still cannot install itself", () => {
    const registry = createPluginRegistry();
    let attempts = 0;
    const recursive: Parameters<typeof registry.plugin>[0] = {
      name: "recursive",
      install() {
        attempts++;
        registry.reset();
        registry.plugin(recursive);
      },
    };
    expect(() => registry.plugin(recursive)).toThrow(/recursive installation/);
    expect(attempts).toBe(1);

    // A different name after the reset is fine, and the same name installs
    // normally once the original call has unwound.
    registry.plugin({ name: "other", install: (ctx) => ctx.provide("other", 1) });
    expect(registry.inject("other")).toBe(1);
    registry.plugin({ name: "recursive", install: (ctx) => ctx.provide("done", 1) });
    expect(registry.inject("done")).toBe(1);
  });

  it("a synchronous install that resets its own registry reports cancellation", () => {
    const registry = createPluginRegistry();
    expect(() =>
      registry.plugin({
        name: "self-reset",
        install(ctx) {
          ctx.provide("never", 1);
          registry.reset();
        },
      }),
    ).toThrow(PluginInstallCancelledError);
    expect(registry.installedPlugins.has("self-reset")).toBe(false);
    expect(registry.provided.has("never")).toBe(false);
  });

  it("an async install cancelled by reset() rejects, silently for a caller that ignores it", async () => {
    const registry = createPluginRegistry();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    // Ignored on purpose: a cancellation must not surface as an unhandled rejection.
    const ignored = registry.plugin({ name: "cancelled", install: async () => gate });
    registry.reset();
    // A newer installation of the same name is unaffected by the cancellation.
    registry.plugin({ name: "cancelled", install: (ctx) => ctx.provide("fresh", 1) });
    release();
    await new Promise((r) => setTimeout(r, 0));

    expect(registry.inject("fresh")).toBe(1);
    expect(registry.installedPlugins.has("cancelled")).toBe(true);
    // Cancellation is deliberate, so it is not reported as a runtime error.
    expect(handler).not.toHaveBeenCalled();
    // An awaiting caller still learns the installation never happened.
    await expect(ignored).rejects.toBeInstanceOf(PluginInstallCancelledError);
  });

  it("an async install that resets synchronously never reserves its name", async () => {
    const registry = createPluginRegistry();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const cancelled = registry.plugin({
      name: "same",
      install() {
        registry.reset();
        return gate;
      },
    });

    // The name is free immediately: nothing stale reserved it.
    expect(() => registry.plugin({ name: "same", install: (ctx) => ctx.provide("fresh", 1) })).not.toThrow();
    expect(registry.inject("fresh")).toBe(1);

    release();
    await expect(cancelled).rejects.toBeInstanceOf(PluginInstallCancelledError);

    // The newer installation is untouched, and the name stays reusable.
    expect(registry.installedPlugins.has("same")).toBe(true);
    registry.reset();
    expect(() => registry.plugin({ name: "same", install: (ctx) => ctx.provide("again", 1) })).not.toThrow();
    expect(registry.inject("again")).toBe(1);
  });

  it("a stale install that never settles does not lock its name", () => {
    const registry = createPluginRegistry();
    registry.plugin({
      name: "forever",
      install() {
        registry.reset();
        return new Promise<void>(() => {}); // never settles
      },
    });
    expect(() => registry.plugin({ name: "forever", install: () => {} })).not.toThrow();
    expect(registry.installedPlugins.has("forever")).toBe(true);
  });

  it("a stale install that rejects after reset leaves the name reusable", async () => {
    const registry = createPluginRegistry();
    let fail!: (e: unknown) => void;
    const gate = new Promise<void>((_r, reject) => {
      fail = reject;
    });
    registry.plugin({
      name: "rejects",
      install() {
        registry.reset();
        return gate;
      },
    });
    fail(new Error("stale failure"));
    await new Promise((r) => setTimeout(r, 0));

    expect(() => registry.plugin({ name: "rejects", install: (ctx) => ctx.provide("after", 1) })).not.toThrow();
    expect(registry.inject("after")).toBe(1);
  });

  it("a second async install of the same name while one is in flight is refused", async () => {
    const registry = createPluginRegistry();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const first = registry.plugin({ name: "inflight", install: async () => gate });
    expect(() => registry.plugin({ name: "inflight", install: () => {} })).toThrow(/already being installed/);
    release();
    await first;
    expect(registry.installedPlugins.has("inflight")).toBe(true);
  });

  it("a throwing install still commits nothing", () => {
    const registry = createPluginRegistry();
    expect(() =>
      registry.plugin({
        name: "broken",
        install(ctx) {
          ctx.provide("x", 1);
          throw new Error("install failed");
        },
      }),
    ).toThrow();
    expect(registry.provided.has("x")).toBe(false);
    expect(registry.installedPlugins.has("broken")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ISR keeps retrying after a failed revalidation.
// ---------------------------------------------------------------------------
describe("createISR retry after failure", () => {
  it("a transient fetch failure is retried after revalidateAfter", async () => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let calls = 0;
    const isr = createISR({
      revalidateAfter: 100,
      initialData: 1,
      fetcher: async () => {
        calls++;
        if (calls === 1) throw new Error("network");
        return 2;
      },
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toBe(1);
    expect(isr.isStale()).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toBe(2);
    expect(isr.data()).toBe(2);
    expect(isr.isStale()).toBe(false);
    isr.dispose();
  });
});

// ---------------------------------------------------------------------------
// hotkey: the "+" key.
// ---------------------------------------------------------------------------
describe("hotkey plus key", () => {
  const press = (key: string, init: KeyboardEventInit = {}) =>
    document.dispatchEvent(new KeyboardEvent("keydown", { key, ...init }));

  it('"+" and "ctrl++" register and fire', () => {
    const plain = vi.fn();
    const withCtrl = vi.fn();
    const stopPlain = hotkey("+", plain);
    const stopCtrl = hotkey("ctrl++", withCtrl);
    press("+");
    press("+", { ctrlKey: true });
    expect(plain).toHaveBeenCalledTimes(1);
    expect(withCtrl).toHaveBeenCalledTimes(1);
    stopPlain();
    stopCtrl();
  });

  it("a combo with no key still throws", () => {
    expect(() => hotkey("ctrl+", () => {})).toThrow(/missing key/);
    expect(() => hotkey("hyper+s", () => {})).toThrow(/unknown modifier/);
  });
});

// ---------------------------------------------------------------------------
// TransitionGroup.remove isolates leave failures.
// ---------------------------------------------------------------------------
describe("TransitionGroup.remove failures", () => {
  it("a throwing leave is reported, the element is removed, and remove() resolves", async () => {
    const el = document.createElement("div");
    const leave = vi.fn(() => {
      throw new Error("leave failed");
    });
    const group = TransitionGroup({ leave });
    group.add(el);
    await expect(group.remove(el)).resolves.toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][1]).toMatchObject({ node: el });

    // No longer tracked, so a later track() does not call leave for it again.
    group.track([]);
    expect(leave).toHaveBeenCalledTimes(1);
  });

  it("a rejecting leave behaves the same", async () => {
    const el = document.createElement("div");
    const group = TransitionGroup({ leave: async () => Promise.reject(new Error("async leave")) });
    group.add(el);
    await expect(group.remove(el)).resolves.toBeUndefined();
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// a11y: delegated listeners and labels outside the checked root.
// ---------------------------------------------------------------------------
describe("a11y false positives", () => {
  const delegatingList = () => {
    const list = document.createElement("ul");
    for (let i = 0; i < 2; i++) {
      const li = document.createElement("li");
      li.appendChild(document.createElement("button")).textContent = `b${i}`;
      list.appendChild(li);
    }
    list.addEventListener("click", () => {});
    return list;
  };

  it("declared delegation (attribute or option) is not a violation", () => {
    const withAttribute = delegatingList();
    withAttribute.setAttribute("data-a11y-delegates", "");
    expect(checkKeyboardAccess(withAttribute)).toEqual([]);

    const withOption = delegatingList();
    expect(checkKeyboardAccess(withOption, { delegatesActivation: (el) => el === withOption })).toEqual([]);
  });

  it("containing a button is NOT evidence of delegation: a clickable card is still reported", () => {
    const card = document.createElement("div");
    card.setAttribute("onclick", "openCard()");
    card.append("Open details ", document.createElement("button"));
    expect(checkKeyboardAccess(card).some((v) => v.level === "error")).toBe(true);

    const undeclared = delegatingList();
    expect(checkKeyboardAccess(undeclared).length).toBeGreaterThan(0);
  });

  it("a clickable container with no keyboard-reachable content is still reported", () => {
    const box = document.createElement("div");
    box.textContent = "click me";
    box.addEventListener("click", () => {});
    expect(checkKeyboardAccess(box).some((v) => v.level === "error")).toBe(true);
  });

  it("checking an input directly sees its <label for> elsewhere in the document", () => {
    document.body.innerHTML = '<label for="name-field">Name</label><input id="name-field">';
    const input = document.getElementById("name-field") as HTMLElement;
    expect(checkFormLabels(input)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// createHttpMock: jsdom structured bodies and abort reasons.
// ---------------------------------------------------------------------------
describe("createHttpMock in jsdom", () => {
  // Runtimes differ in whether they accept another realm's FormData/URLSearchParams
  // (jsdom's, here): some serialize them, some stringify them, newer ones throw.
  // What must hold everywhere is that the handler can still read the data and
  // sees a content type describing it — never "[object FormData]" as text.
  const fieldOf = async (body: unknown, name: string): Promise<string> => {
    // Cross-realm: the body may be this realm's FormData, the runtime's own
    // FormData/Blob, or text — duck-typed rather than instanceof.
    if (body && typeof (body as FormData).get === "function") return String((body as FormData).get(name) ?? "");
    const text = body && typeof (body as Blob).text === "function" ? await (body as Blob).text() : String(body ?? "");
    // What must never happen: the object stringified into the body.
    expect(text).not.toContain("[object ");
    return text;
  };

  it("passes jsdom FormData and URLSearchParams through in a readable form", async () => {
    const seen: Array<{ body: unknown; type: string | null }> = [];
    const mock = createHttpMock([
      {
        method: "POST",
        url: "/x",
        response: ({ body, headers }) => {
          seen.push({ body, type: headers.get("content-type") });
          return { body: "ok" };
        },
      },
    ]);
    const original = globalThis.fetch;
    mock.install();
    try {
      const form = new FormData();
      form.append("name", "Ada");
      await fetch("/x", { method: "POST", body: form });
      await fetch("/x", { method: "POST", body: new URLSearchParams("a=1") });
      await fetch("/x", { method: "POST", body: "plain" });
    } finally {
      mock.restore();
      globalThis.fetch = original;
    }
    expect(seen[0].type).toMatch(/^multipart\/form-data/);
    expect(await fieldOf(seen[0].body, "name")).toContain("Ada");
    expect(seen[1].type).toMatch(/^application\/x-www-form-urlencoded/);
    expect(String((seen[1].body as URLSearchParams).toString?.() ?? seen[1].body)).toContain("a=1");
    expect(seen[2]).toEqual({ body: "plain", type: "text/plain;charset=UTF-8" });
  });

  it("an explicit Content-Type is kept, and the body is still readable", async () => {
    let seen: { body: unknown; type: string | null } | undefined;
    const mock = createHttpMock([
      {
        method: "POST",
        url: "/x",
        response: ({ body, headers }) => {
          seen = { body, type: headers.get("content-type") };
          return { body: "ok" };
        },
      },
    ]);
    const original = globalThis.fetch;
    mock.install();
    try {
      const form = new FormData();
      form.append("k", "v");
      await fetch("/x", { method: "POST", body: form, headers: { "content-type": "application/x-custom" } });
    } finally {
      mock.restore();
      globalThis.fetch = original;
    }
    expect(seen?.type).toBe("application/x-custom");
    expect(await fieldOf(seen?.body, "k")).toContain("v");
  });

  it("refuses a body on GET and HEAD, like fetch(), without reaching a route", async () => {
    const response = vi.fn(() => ({ body: "ok" }));
    const mock = createHttpMock([{ method: "GET", url: "/x", response }]);
    const original = globalThis.fetch;
    mock.install();
    try {
      const form = new FormData();
      form.append("a", "1");
      for (const method of ["GET", "HEAD"]) {
        await expect(fetch("/x", { method, body: form })).rejects.toThrow(/cannot have body/i);
      }
      expect(response).not.toHaveBeenCalled();
      expect(mock.getRequests()).toEqual([]);

      // POST with the same body is still served.
      mock.addRoute({ method: "POST", url: "/x", response: () => ({ body: "posted" }) });
      expect(await (await fetch("/x", { method: "POST", body: form })).text()).toBe("posted");
    } finally {
      mock.restore();
      globalThis.fetch = original;
    }
  });

  it("rejects with the signal's reason, like fetch()", async () => {
    const mock = createHttpMock([{ url: "/slow", response: { delay: 1000, body: "late" } }]);
    const original = globalThis.fetch;
    mock.install();
    try {
      const timeout = new AbortController();
      const pending = fetch("/slow", { signal: timeout.signal });
      const reason = new DOMException("took too long", "TimeoutError");
      timeout.abort(reason);
      await expect(pending).rejects.toBe(reason);

      const custom = new AbortController();
      const pending2 = fetch("/slow", { signal: custom.signal });
      custom.abort("user cancelled");
      await expect(pending2).rejects.toBe("user cancelled");
    } finally {
      mock.restore();
      globalThis.fetch = original;
    }
  });
});

// ---------------------------------------------------------------------------
// swipe: missed touchend and fingers elsewhere.
// ---------------------------------------------------------------------------
describe("swipe gesture recovery", () => {
  type T = { identifier: number; clientX: number; clientY: number };
  const make = () => {
    const handlers: Record<string, Array<(e: unknown) => void>> = {};
    const el = {
      addEventListener: (type: string, h: (e: unknown) => void) => {
        (handlers[type] ||= []).push(h);
      },
      removeEventListener: () => {},
    } as unknown as HTMLElement;
    const fire = (type: string, e: { touches: T[]; targetTouches?: T[]; changedTouches: T[] }) => {
      for (const h of handlers[type] || []) h(e);
    };
    return { el, fire };
  };
  const touch = (identifier: number, clientX: number): T => ({ identifier, clientX, clientY: 0 });

  it("a new gesture after a missed touchend is recognised", () => {
    const { el, fire } = make();
    const s = swipe(el);
    fire("touchstart", { touches: [touch(1, 0)], changedTouches: [touch(1, 0)] });
    // touchend for id 1 never arrives.
    fire("touchstart", { touches: [touch(2, 0)], changedTouches: [touch(2, 0)] });
    fire("touchend", { touches: [], changedTouches: [touch(2, 200)] });
    expect(s.direction()).toBe("right");
    s.dispose();
  });

  it("a finger resting outside the target does not block a swipe on it", () => {
    const { el, fire } = make();
    const s = swipe(el);
    fire("touchstart", {
      touches: [touch(9, 500), touch(3, 0)],
      targetTouches: [touch(3, 0)],
      changedTouches: [touch(3, 0)],
    });
    fire("touchend", { touches: [touch(9, 500)], changedTouches: [touch(3, -200)] });
    expect(s.direction()).toBe("left");
    s.dispose();
  });

  it("two fingers on the target are still not a swipe", () => {
    const { el, fire } = make();
    const s = swipe(el);
    const both = [touch(1, 0), touch(2, 0)];
    fire("touchstart", { touches: both, targetTouches: both, changedTouches: [touch(2, 0)] });
    fire("touchend", { touches: [touch(1, 0)], changedTouches: [touch(2, 300)] });
    expect(s.direction()).toBeNull();
    s.dispose();
  });
});

// ---------------------------------------------------------------------------
// urlState: pushed entries do not inherit scroll-restoration identity.
// ---------------------------------------------------------------------------
describe("urlState entry identity", () => {
  it("push drops __sibuScrollKey, replace keeps it, other state is carried", () => {
    history.replaceState({ __sibuScrollKey: "K", app: 1 }, "", "/");
    const url = urlState();
    url.setParams({ q: "1" });
    expect(history.state).toEqual({ app: 1 });

    history.replaceState({ __sibuScrollKey: "K2", app: 2 }, "", "/");
    url.setParams({ q: "2" }, { replace: true });
    expect(history.state).toEqual({ __sibuScrollKey: "K2", app: 2 });

    url.setParams({ q: "3" }, { state: { __sibuScrollKey: "explicit" } });
    expect(history.state).toEqual({ __sibuScrollKey: "explicit" });
    url.dispose();
    history.replaceState(null, "", "/");
  });
});

// ---------------------------------------------------------------------------
// Head / renderToDocument: a null title from untyped callers is ignored.
// ---------------------------------------------------------------------------
describe("null titles", () => {
  it("Head({ title: null }) does not set the document title to 'null'", () => {
    document.title = "kept";
    const marker = Head({ title: null as unknown as string });
    expect(document.title).toBe("kept");
    dispose(marker);
  });

  it("renderToDocument({ title: null }) renders no <title>", () => {
    const html = renderToDocument(() => div("x") as HTMLElement, { title: null as unknown as string });
    expect(html).not.toContain("<title>");
  });
});

// ---------------------------------------------------------------------------
// Migrations: an unparseable stored version is reported, not thrown.
// ---------------------------------------------------------------------------
describe("migrate with a legacy stored version", () => {
  it("reports the invalid stored version in errors and runs nothing", async () => {
    const data = new Map<string, string>([["legacy", "1.0.0.1"]]);
    const storage = {
      get length() {
        return data.size;
      },
      clear: () => data.clear(),
      getItem: (k: string) => data.get(k) ?? null,
      key: () => null,
      removeItem: (k: string) => void data.delete(k),
      setItem: (k: string, v: string) => void data.set(k, v),
    } as Storage;
    const up = vi.fn();
    const runner = createMigrationRunner({
      currentVersion: "2.0.0",
      storage,
      storageKey: "legacy",
      migrations: [{ version: "2.0.0", description: "two", up }],
    });
    const result = await runner.migrate();
    expect(up).not.toHaveBeenCalled();
    expect(result.applied).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].version).toBe("1.0.0.1");
    expect(result.errors[0].error.message).toMatch(/Invalid semver/);
  });
});

// ---------------------------------------------------------------------------
// Widget teardowns are idempotent across a rebind.
// ---------------------------------------------------------------------------
describe("stale widget teardown after rebind", () => {
  it("calling an old tooltip teardown again does not undo the new binding", () => {
    const trigger = document.createElement("button");
    const tip = document.createElement("div");
    document.body.append(trigger, tip);
    const t = tooltip();
    const first = t.bind({ trigger, tooltip: tip });
    first();
    const second = t.bind({ trigger, tooltip: tip });
    const describedBy = trigger.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();

    first();
    expect(trigger.getAttribute("aria-describedby")).toBe(describedBy);
    expect(t.bind({ trigger, tooltip: tip })).toBe(second);
    second();
  });
});
