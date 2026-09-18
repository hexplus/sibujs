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
