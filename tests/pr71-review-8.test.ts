import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setRuntimeErrorHandler } from "../src/core/errors";
import { registerDisposer } from "../src/core/rendering/dispose";
import { div } from "../src/core/rendering/html";
import { signal } from "../src/core/signals/signal";
import { componentAdapter, createTheme } from "../src/ecosystem/ui/componentAdapter";
import { globalStore, type Middleware } from "../src/patterns/globalStore";
import { defineElement } from "../src/platform/customElement";

let handler: ReturnType<typeof vi.fn>;
beforeEach(() => {
  handler = vi.fn();
  setRuntimeErrorHandler(handler);
});
afterEach(() => {
  setRuntimeErrorHandler(null);
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

const flush = async () => {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 0));
    for (let j = 0; j < 10; j++) await Promise.resolve();
  }
};

let elementId = 0;
const uniqueTag = () => `x-pr71-review-8-${++elementId}`;

// ---------------------------------------------------------------------------
// 1. defineElement: a disconnect during the old subtree's teardown abandons
//    the commit of the new generation.
// ---------------------------------------------------------------------------
describe("defineElement commit after old-subtree teardown", () => {
  function setup() {
    const tag = uniqueTag();
    const [value, setValue] = signal(0);
    const bindingRuns = vi.fn();
    const hostCleanup = vi.fn();
    let removeHostOnTeardown = false;
    let generation = 0;
    defineElement(
      tag,
      (_props, host) => {
        const gen = ++generation;
        registerDisposer(host, () => hostCleanup(gen));
        const tree = div({
          class: () => {
            bindingRuns(gen);
            return `gen-${gen} v-${value()}`;
          },
        }) as HTMLElement;
        registerDisposer(tree, () => {
          if (removeHostOnTeardown) {
            removeHostOnTeardown = false;
            host.remove();
          }
        });
        return tree;
      },
      { observedAttributes: ["n"], shadow: false },
    );
    const el = document.createElement(tag);
    document.body.appendChild(el);
    return {
      el,
      setValue,
      bindingRuns,
      hostCleanup,
      armRemoval: () => {
        removeHostOnTeardown = true;
      },
    };
  }

  it("does not install the new generation when the old teardown disconnects the host", () => {
    const { el, setValue, bindingRuns, armRemoval } = setup();
    armRemoval();

    el.setAttribute("n", "2");

    expect(el.isConnected).toBe(false);
    expect(el.querySelector(".gen-2")).toBeNull();
    expect(el.childNodes.length).toBe(0);

    bindingRuns.mockClear();
    setValue(1);
    expect(bindingRuns).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("runs the abandoned generation's host cleanup exactly once", () => {
    const { el, hostCleanup, armRemoval } = setup();
    armRemoval();

    el.setAttribute("n", "2");

    expect(hostCleanup.mock.calls.filter(([gen]) => gen === 2)).toHaveLength(1);
  });

  it("renders a fresh, live generation when the host is reconnected", () => {
    const { el, setValue, bindingRuns, armRemoval } = setup();
    armRemoval();
    el.setAttribute("n", "2");

    document.body.appendChild(el);

    const live = el.querySelector(".gen-3");
    expect(live).not.toBeNull();
    bindingRuns.mockClear();
    setValue(5);
    expect(bindingRuns).toHaveBeenCalledWith(3);
    expect(bindingRuns).not.toHaveBeenCalledWith(2);
    expect(live?.className).toContain("v-5");
  });
});

// ---------------------------------------------------------------------------
// 2. globalStore: an already-rejected middleware beats a next() it queued.
// ---------------------------------------------------------------------------
describe("globalStore middleware rejected before a queued next()", () => {
  function storeWith(middleware: Middleware<{ count: number }>) {
    const action = vi.fn((state: { count: number }) => ({ count: state.count + 1 }));
    const store = globalStore({ state: { count: 0 }, actions: { inc: action }, middleware: [middleware] });
    return { store, action };
  }

  it("does not continue when an already-rejected middleware beats a queued next()", async () => {
    const { store, action } = storeWith((_s, _a, _p, next) => {
      queueMicrotask(next);
      return Promise.reject(new Error("failed first"));
    });

    store.dispatch("inc");
    await flush();

    expect(action).not.toHaveBeenCalled();
    expect(store.getState().count).toBe(0);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({ message: "failed first" });
  });

  it("an async middleware that queues next() and then throws does not continue", async () => {
    const { store, action } = storeWith(async (_s, _a, _p, next) => {
      queueMicrotask(next);
      throw new Error("async failed first");
    });

    store.dispatch("inc");
    await flush();

    expect(action).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("a hostile then getter beats an already-queued next()", async () => {
    const poisoned = Promise.resolve();
    // biome-ignore lint/suspicious/noThenProperty: a hostile thenable is the subject under test
    Object.defineProperty(poisoned, "then", {
      get() {
        throw new Error("hostile getter");
      },
    });
    const { store, action } = storeWith((_s, _a, _p, next) => {
      queueMicrotask(next);
      return poisoned as unknown as PromiseLike<void>;
    });

    store.dispatch("inc");
    await flush();

    expect(action).not.toHaveBeenCalled();
    expect(store.getState().count).toBe(0);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({ message: "hostile getter" });
  });

  it("a native promise whose then invocation throws beats an already-queued next()", async () => {
    const poisoned = Promise.resolve();
    Object.defineProperty(poisoned, "constructor", {
      get() {
        throw new Error("hostile constructor");
      },
    });
    const { store, action } = storeWith((_s, _a, _p, next) => {
      queueMicrotask(next);
      return poisoned as unknown as PromiseLike<void>;
    });

    store.dispatch("inc");
    await flush();

    expect(action).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({ message: "hostile constructor" });
  });

  it("a synchronously rejecting foreign thenable beats an already-queued next()", async () => {
    const { store, action } = storeWith((_s, _a, _p, next) => {
      queueMicrotask(next);
      return {
        // biome-ignore lint/suspicious/noThenProperty: a foreign thenable is the subject under test
        then(_resolve: unknown, reject?: (err: unknown) => void) {
          reject?.(new Error("foreign thenable failed"));
        },
      } as unknown as PromiseLike<void>;
    });

    store.dispatch("inc");
    await flush();

    expect(action).not.toHaveBeenCalled();
    expect(store.getState().count).toBe(0);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({ message: "foreign thenable failed" });
  });

  it("a foreign thenable whose then() throws beats an already-queued next()", async () => {
    const { store, action } = storeWith((_s, _a, _p, next) => {
      queueMicrotask(next);
      return {
        // biome-ignore lint/suspicious/noThenProperty: a foreign thenable is the subject under test
        then() {
          throw new Error("then invocation failed");
        },
      } as unknown as PromiseLike<void>;
    });

    store.dispatch("inc");
    await flush();

    expect(action).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({ message: "then invocation failed" });
  });

  it("a synchronously fulfilling foreign thenable still continues a queued next()", async () => {
    const { store, action } = storeWith((_s, _a, _p, next) => {
      queueMicrotask(next);
      return {
        // biome-ignore lint/suspicious/noThenProperty: a foreign thenable is the subject under test
        then(resolve?: (v: unknown) => void) {
          resolve?.(undefined);
        },
      } as unknown as PromiseLike<void>;
    });

    store.dispatch("inc");
    await flush();

    expect(action).toHaveBeenCalledTimes(1);
    expect(handler).not.toHaveBeenCalled();
  });

  it("a foreign thenable that rejects only after next() keeps the committed action", async () => {
    let rejectLater: (err: unknown) => void = () => {};
    const { store, action } = storeWith((_s, _a, _p, next) => {
      queueMicrotask(next);
      return {
        // biome-ignore lint/suspicious/noThenProperty: a foreign thenable is the subject under test
        then(_resolve: unknown, reject: (err: unknown) => void) {
          rejectLater = reject;
        },
      } as unknown as PromiseLike<void>;
    });

    store.dispatch("inc");
    await flush();
    expect(action).toHaveBeenCalledTimes(1);

    rejectLater(new Error("late failure"));
    await flush();
    expect(store.getState().count).toBe(1);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  describe("nested resolution chains", () => {
    /** A foreign thenable that resolves synchronously with `inner`. */
    const resolvingTo = (inner: unknown) =>
      ({
        // biome-ignore lint/suspicious/noThenProperty: a foreign thenable is the subject under test
        then(resolve?: (value: unknown) => void) {
          resolve?.(inner);
        },
      }) as unknown as PromiseLike<void>;
    const rejectingThenable = (message: string) => ({
      // biome-ignore lint/suspicious/noThenProperty: a foreign thenable is the subject under test
      then(_resolve: unknown, reject?: (err: unknown) => void) {
        reject?.(new Error(message));
      },
    });

    /** A foreign thenable delegating to `promise`: its `then` is not the native one. */
    const wrap = (promise: Promise<unknown>) =>
      // biome-ignore lint/suspicious/noThenProperty: a promise wrapper is the subject under test
      ({ then: promise.then.bind(promise) }) as unknown as PromiseLike<void>;

    async function expectBlocked(result: PromiseLike<void>, message: string) {
      const { store, action } = storeWith((_s, _a, _p, next) => {
        queueMicrotask(next);
        return result;
      });
      store.dispatch("inc");
      await flush();
      expect(action).not.toHaveBeenCalled();
      expect(store.getState().count).toBe(0);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0]).toMatchObject({ message });
    }

    async function expectContinued(result: PromiseLike<void>) {
      const { store, action } = storeWith((_s, _a, _p, next) => {
        queueMicrotask(next);
        return result;
      });
      store.dispatch("inc");
      await flush();
      expect(action).toHaveBeenCalledTimes(1);
    }

    it("a foreign thenable resolving to an immediately rejecting thenable beats queued next()", async () => {
      await expectBlocked(resolvingTo(rejectingThenable("nested failure")), "nested failure");
    });

    it("a foreign thenable resolving to a rejected native promise beats queued next()", async () => {
      await expectBlocked(resolvingTo(Promise.reject(new Error("nested failure"))), "nested failure");
    });

    it("a deep chain ending in a rejection beats queued next()", async () => {
      await expectBlocked(
        resolvingTo(resolvingTo(resolvingTo(resolvingTo(rejectingThenable("deep failure"))))),
        "deep failure",
      );
    });

    it("a nested then accessor that throws beats queued next()", async () => {
      const hostile = {
        // biome-ignore lint/suspicious/noThenProperty: a hostile thenable is the subject under test
        get then() {
          throw new Error("nested getter");
        },
      };
      await expectBlocked(resolvingTo(hostile), "nested getter");
    });

    // CONTRACT: a non-native `then` counts as failed before next() only if it
    // rejects or throws synchronously when the adoption invokes it. Anything it
    // reports later is a later settlement — the action stays committed and the
    // failure is reported. A promise-backed `then` that delivers an
    // already-rejected state through a reaction is, observably, the same thing
    // as a thenable rejecting one microtask later, so both land here.
    async function expectLateFailure(result: PromiseLike<void>, message: string) {
      const { store, action } = storeWith((_s, _a, _p, next) => {
        queueMicrotask(next);
        return result;
      });
      store.dispatch("inc");
      await flush();
      expect(action).toHaveBeenCalledTimes(1);
      expect(store.getState().count).toBe(1);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0]).toMatchObject({ message });
    }

    it("a foreign thenable rejecting one microtask after next() keeps the action", async () => {
      await expectLateFailure(
        {
          // biome-ignore lint/suspicious/noThenProperty: a foreign thenable is the subject under test
          then(_resolve: unknown, reject?: (err: unknown) => void) {
            queueMicrotask(() => reject?.(new Error("late failure")));
          },
        } as unknown as PromiseLike<void>,
        "late failure",
      );
    });

    it("an already-rejected wrapped promise reports asynchronously, so it is a late failure", async () => {
      await expectLateFailure(wrap(Promise.reject(new Error("wrapped failure"))), "wrapped failure");
    });

    it("an already-rejected promise subclass overriding then() is a late failure", async () => {
      class WrappedPromise<T> extends Promise<T> {
        // biome-ignore lint/suspicious/noThenProperty: a promise subclass is the subject under test
        override then<A = T, B = never>(
          onFulfilled?: ((value: T) => A | PromiseLike<A>) | null,
          onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
        ): Promise<A | B> {
          return super.then(onFulfilled, onRejected);
        }
      }
      const failed = WrappedPromise.reject(new Error("subclass failure")) as PromiseLike<void>;
      await expectLateFailure(failed, "subclass failure");
    });

    it("a promise subclass that inherits the native then() is probed natively and blocks", async () => {
      class PlainSubclass<T> extends Promise<T> {}
      await expectBlocked(
        PlainSubclass.reject(new Error("plain subclass failure")) as PromiseLike<void>,
        "plain subclass failure",
      );
    });

    it("an already-fulfilled wrapped promise continues", async () => {
      await expectContinued(wrap(Promise.resolve()));
      expect(handler).not.toHaveBeenCalled();
    });

    it("a pending wrapped promise continues", async () => {
      await expectContinued(wrap(new Promise(() => {})));
    });

    it("a chain ending in a plain value continues", async () => {
      await expectContinued(resolvingTo(resolvingTo(Promise.resolve(42))));
      expect(handler).not.toHaveBeenCalled();
    });

    it("a chain ending in a genuinely pending thenable continues", async () => {
      // biome-ignore lint/suspicious/noThenProperty: a foreign thenable is the subject under test
      await expectContinued(resolvingTo(resolvingTo({ then() {} })));
    });

    it("a chain ending in a pending native promise continues", async () => {
      await expectContinued(resolvingTo(new Promise(() => {})));
    });
  });

  it("a queued next() still continues while the middleware's promise is pending", async () => {
    let finish: () => void = () => {};
    const { store, action } = storeWith((_s, _a, _p, next) => {
      queueMicrotask(next);
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });

    store.dispatch("inc");
    await flush();

    expect(action).toHaveBeenCalledTimes(1);
    expect(store.getState().count).toBe(1);
    finish();
    await flush();
    expect(handler).not.toHaveBeenCalled();
  });

  it("a queued next() still continues when the middleware's promise already resolved", async () => {
    const { store, action } = storeWith((_s, _a, _p, next) => {
      queueMicrotask(next);
      return Promise.resolve();
    });

    store.dispatch("inc");
    await flush();

    expect(action).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 3. componentAdapter / createTheme: inherited keys are not class names.
// ---------------------------------------------------------------------------
describe("componentAdapter inherited variant/size/override keys", () => {
  const adapter = () =>
    componentAdapter({
      name: "test",
      prefix: "tui",
      components: { Button: { tag: "button", baseClass: "tui-button", variants: {}, sizes: {} } },
    });

  for (const key of ["toString", "constructor", "hasOwnProperty", "__proto__"]) {
    it(`variant "${key}" is ignored`, () => {
      const { Button } = adapter().components;
      const el = Button({ variant: key });
      expect(el.getAttribute("class")).toBe("tui-button");
    });

    it(`size "${key}" is ignored`, () => {
      const { Button } = adapter().components;
      const el = Button({ size: key });
      expect(el.getAttribute("class")).toBe("tui-button");
    });

    it(`resolveClass("${key}") does not return an inherited member`, () => {
      const theme = createTheme({ prefix: "tui", classOverrides: {} });
      expect(theme.resolveClass(key)).toBe(`tui-${key}`);
    });
  }

  it("own variant, size and override entries still apply", () => {
    const { Button } = componentAdapter({
      name: "test",
      prefix: "tui",
      components: {
        Button: {
          tag: "button",
          baseClass: "tui-button",
          variants: { primary: "tui-button--primary" },
          sizes: { sm: "tui-button--sm" },
        },
      },
    }).components;
    expect(Button({ variant: "primary", size: "sm" }).getAttribute("class")).toBe(
      "tui-button tui-button--primary tui-button--sm",
    );
    const theme = createTheme({ prefix: "tui", classOverrides: { card: "my-card" } });
    expect(theme.resolveClass("card")).toBe("my-card");
  });
});
