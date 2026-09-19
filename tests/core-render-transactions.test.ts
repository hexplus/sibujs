import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "../src/components/ErrorBoundary";
import { setRuntimeErrorHandler } from "../src/core/errors";
import { match, show, when } from "../src/core/rendering/directives";
import { detached, dispose } from "../src/core/rendering/dispose";
import {
  DynamicComponent,
  registerComponent,
  resolveComponent,
  unregisterComponent,
} from "../src/core/rendering/dynamic";
import { each } from "../src/core/rendering/each";
import { Fragment } from "../src/core/rendering/fragment";
import { div, span } from "../src/core/rendering/html";
import { KeepAlive } from "../src/core/rendering/keepAlive";
import { lazy, Suspense } from "../src/core/rendering/lazy";
import { mount } from "../src/core/rendering/mount";
import { Portal } from "../src/core/rendering/portal";
import type { NodeChildren } from "../src/core/rendering/types";
import { asyncDerived } from "../src/core/signals/asyncDerived";
import { derived } from "../src/core/signals/derived";
import { effect } from "../src/core/signals/effect";
import { signal } from "../src/core/signals/signal";
import { watch } from "../src/core/signals/watch";
import type { ReactiveSignal } from "../src/reactivity/signal";
import { getSubscriberCount } from "../src/reactivity/track-core";

// A signal accessor carries its node on `__signal` (see core/signals/signal.ts).
const subscribers = (accessor: unknown): number =>
  getSubscriberCount((accessor as { __signal: ReactiveSignal }).__signal);

const settle = () => new Promise((r) => setTimeout(r, 0));

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

/** Something reactive a failed build creates before it throws. */
const bindTo = (source: () => unknown) => div({ "data-v": () => String(source()) });

// ---------------------------------------------------------------------------
// 1. Standalone reactive resources created before a later failure.
// ---------------------------------------------------------------------------
describe("a failed mount() rolls back standalone resources it created", () => {
  const container = () => document.body.appendChild(document.createElement("div"));

  it("effect() created before the throw stops running", () => {
    const [source, setSource] = signal(0);
    let runs = 0;
    expect(() =>
      mount(() => {
        effect(() => {
          source();
          runs++;
        });
        throw new Error("component failed later");
      }, container()),
    ).toThrow("component failed later");

    expect(subscribers(source)).toBe(0);
    setSource(1);
    expect(runs).toBe(1);
  });

  it("derived() created before the throw releases its sources", () => {
    const [source] = signal(0);
    expect(() =>
      mount(() => {
        derived(() => source());
        throw new Error("later failure");
      }, container()),
    ).toThrow("later failure");
    expect(subscribers(source)).toBe(0);
  });

  it("watch() created before the throw never calls back", () => {
    const [source, setSource] = signal(0);
    const callback = vi.fn();
    expect(() =>
      mount(() => {
        watch(() => source(), callback);
        throw new Error("later failure");
      }, container()),
    ).toThrow("later failure");
    setSource(1);
    expect(callback).not.toHaveBeenCalled();
    expect(subscribers(source)).toBe(0);
  });

  it("asyncDerived() created before the throw aborts its request", () => {
    let aborted: AbortSignal | undefined;
    expect(() =>
      mount(() => {
        asyncDerived(({ signal: abort }) => {
          aborted = abort;
          return new Promise(() => {});
        }, 0);
        throw new Error("later failure");
      }, container()),
    ).toThrow("later failure");
    expect(aborted?.aborted).toBe(true);
  });

  it("a successful mount leaves its effects manually owned and running", () => {
    const [source, setSource] = signal(0);
    let runs = 0;
    const app = mount(() => {
      effect(() => {
        source();
        runs++;
      });
      return div();
    }, container());
    setSource(1);
    expect(runs).toBe(2);
    app.unmount();
    setSource(2);
    expect(runs).toBe(3); // unmount() does not own a standalone effect
  });

  it("resources created by a committed nested render roll back with the failing outer one", () => {
    const [source] = signal(0);
    expect(() =>
      mount(() => {
        // show() renders its thunk synchronously, as a nested transaction that
        // commits into the outer one before the outer one fails.
        div([
          show(
            () => true,
            () => {
              effect(() => source());
              return span("inner");
            },
          ),
        ]);
        throw new Error("outer failed");
      }, container()),
    ).toThrow("outer failed");
    expect(subscribers(source)).toBe(0);
  });

  it("an effect its owner already disposed is not disturbed by the rollback", () => {
    const [source] = signal(0);
    expect(() =>
      mount(() => {
        const stop = effect(() => source());
        stop();
        throw new Error("later failure");
      }, container()),
    ).toThrow("later failure");
    expect(subscribers(source)).toBe(0);
  });
});

describe("detached(): resources meant to outlive the render", () => {
  const container = () => document.body.appendChild(document.createElement("div"));

  it("a lazily cached derived survives the render that created it failing", () => {
    const [items, setItems] = signal([1, 2]);
    let cart: (() => number) | undefined;
    const cartCount = () => {
      cart ??= detached(() => derived(() => items().length));
      return cart();
    };

    expect(() =>
      mount(() => {
        cartCount();
        throw new Error("first user failed later");
      }, container()),
    ).toThrow("first user failed later");

    setItems([1, 2, 3]);
    expect(cartCount()).toBe(3);
    expect(subscribers(items)).toBe(1);
  });

  it("a lazily cached asyncDerived keeps its request", () => {
    let aborted: AbortSignal | undefined;
    let shared: unknown;
    expect(() =>
      mount(() => {
        shared ??= detached(() =>
          asyncDerived(({ signal: abort }) => {
            aborted = abort;
            return new Promise(() => {});
          }, 0),
        );
        throw new Error("later failure");
      }, container()),
    ).toThrow("later failure");
    expect(shared).toBeDefined();
    expect(aborted?.aborted).toBe(false);
  });

  it("a detached effect keeps running", () => {
    const [source, setSource] = signal(0);
    let runs = 0;
    expect(() =>
      mount(() => {
        detached(() =>
          effect(() => {
            source();
            runs++;
          }),
        );
        throw new Error("later failure");
      }, container()),
    ).toThrow("later failure");
    setSource(1);
    expect(runs).toBe(2);
  });

  it("without detached(), a cached derived is disposed with the failed render (documented)", () => {
    const [items, setItems] = signal([1]);
    let cart: (() => number) | undefined;
    expect(() =>
      mount(() => {
        cart ??= derived(() => items().length);
        throw new Error("later failure");
      }, container()),
    ).toThrow("later failure");
    setItems([1, 2]);
    expect(cart?.()).toBe(1); // inert: the render that created it owned it
  });

  it("a shared derived's recompute does not hand what it creates to the reader's render", () => {
    const [items, setItems] = signal(["a"]);
    const [suffix, setSuffix] = signal("!");
    // Module-level, created outside any render. Its getter creates nested
    // deriveds that live on in its cached value.
    const rows = derived(() => items().map((it) => ({ it, label: derived(() => it + suffix()) })));
    rows(); // settled once outside any render

    setItems(["a", "b"]); // dirty: the next read recomputes
    expect(() =>
      mount(() => {
        rows(); // first reader after the change, inside a render…
        throw new Error("…that fails");
      }, container()),
    ).toThrow("…that fails");

    setSuffix("?");
    expect(rows().map((r) => r.label())).toEqual(["a?", "b?"]);
  });

  it("a derived created inside a render still recomputes into that render's transaction", () => {
    const [source, setSource] = signal(0);
    const [inner] = signal(0);
    expect(() =>
      mount(() => {
        const outer = derived(() => {
          source();
          return derived(() => inner()); // created on each recompute
        });
        outer();
        setSource(1);
        outer(); // recompute inside the same render: still that render's
        throw new Error("later failure");
      }, container()),
    ).toThrow("later failure");
    expect(subscribers(inner)).toBe(0);
  });

  it("returns fn's result and works outside any transaction", () => {
    expect(detached(() => 42)).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// 2. Every framework call into a user render factory is a transaction.
// ---------------------------------------------------------------------------
describe("render factories run as transactions", () => {
  it("each(): a row that throws leaves its bindings unsubscribed", async () => {
    const [source] = signal("a");
    const host = document.body.appendChild(document.createElement("div"));
    host.appendChild(
      each(
        () => [1],
        () => {
          bindTo(source);
          throw new Error("row failed");
        },
        { key: (x) => x },
      ),
    );
    await settle();
    expect(subscribers(source)).toBe(0);
    expect(handler).toHaveBeenCalled();
  });

  /**
   * Attach a directive to the document and run both of its render paths: the
   * deferred first render (its anchor had no parent when created), inactive,
   * then a scheduled switch to the factory under test, which throws after
   * creating a binding.
   */
  async function expectDirectiveReleases(build: (active: () => boolean) => Node, source: () => unknown) {
    const [active, setActive] = signal(false);
    const host = document.body.appendChild(document.createElement("div"));
    host.appendChild(build(active));
    await settle();
    expect(subscribers(source)).toBe(0);
    setActive(true);
    await settle();
    expect(subscribers(source)).toBe(0);
    expect(handler).toHaveBeenCalled();
  }

  const throwingFactory = (source: () => unknown, message: string) => () => {
    bindTo(source);
    throw new Error(message);
  };

  it("when(): a branch that throws leaves its bindings unsubscribed", async () => {
    const [source] = signal("a");
    await expectDirectiveReleases((active) => when(() => active(), throwingFactory(source, "branch failed")), source);
  });

  it("match(): a case that throws leaves its bindings unsubscribed", async () => {
    const [source] = signal("a");
    await expectDirectiveReleases(
      (active) => match(() => (active() ? "x" : "none"), { x: throwingFactory(source, "case failed") }),
      source,
    );
  });

  it("KeepAlive(): a case factory that throws leaves its bindings unsubscribed", async () => {
    const [source] = signal("a");
    await expectDirectiveReleases(
      (active) =>
        KeepAlive(() => (active() ? "x" : "none"), { x: throwingFactory(source, "case failed") as () => Node }),
      source,
    );
  });

  it("a deferred first render that throws is reported, not left uncaught", async () => {
    const [source] = signal("a");
    for (const build of [
      () => when(() => true, throwingFactory(source, "when failed")),
      () => match(() => "x", { x: throwingFactory(source, "match failed") }),
      () => KeepAlive(() => "x", { x: throwingFactory(source, "keepalive failed") as () => Node }),
    ]) {
      document.body.appendChild(document.createElement("div")).appendChild(build());
    }
    await settle();
    const messages = handler.mock.calls.map((c) => (c[0] as Error).message);
    expect(messages).toEqual(expect.arrayContaining(["when failed", "match failed", "keepalive failed"]));
    expect(subscribers(source)).toBe(0);
  });

  it("show(): a thunk that throws leaves its bindings unsubscribed", () => {
    const [source] = signal("a");
    expect(() =>
      show(
        () => true,
        () => {
          bindTo(source);
          throw new Error("thunk failed");
        },
      ),
    ).toThrow("thunk failed");
    expect(subscribers(source)).toBe(0);
  });

  it("resolveComponent() and DynamicComponent(): a component that throws", () => {
    const [source] = signal("a");
    const Broken = () => {
      bindTo(source);
      throw new Error("component failed");
    };
    registerComponent("Broken", Broken as () => HTMLElement);
    try {
      expect(() => resolveComponent("Broken")).toThrow("component failed");
      try {
        DynamicComponent(() => Broken as () => HTMLElement);
      } catch {
        /* see above */
      }
      expect(subscribers(source)).toBe(0);
    } finally {
      unregisterComponent("Broken");
    }
  });

  it("KeepAlive(): an inherited key is not a case", async () => {
    const host = document.body.appendChild(document.createElement("div"));
    host.appendChild(KeepAlive(() => "toString", {}));
    await settle(); // the deferred first render runs here
    expect(host.textContent).toBe("");
    expect(handler).not.toHaveBeenCalled();
  });

  it("lazy(): an already-loaded component that throws", async () => {
    const [source] = signal("a");
    let fail = false;
    const Lazy = lazy(async () => ({
      default: () => {
        const el = bindTo(source) as HTMLElement;
        if (fail) throw new Error("loaded component failed");
        return el;
      },
    }));
    const first = Lazy();
    await settle();
    expect(subscribers(source)).toBe(1);
    dispose(first);
    expect(subscribers(source)).toBe(0);

    fail = true;
    expect(() => Lazy()).toThrow("loaded component failed");
    expect(subscribers(source)).toBe(0);
  });

  it("Suspense(): a fallback that throws leaves its bindings unsubscribed", () => {
    const [source] = signal("a");
    expect(() =>
      Suspense({
        nodes: () => div() as HTMLElement,
        fallback: () => {
          bindTo(source);
          throw new Error("fallback failed");
        },
      }),
    ).toThrow("fallback failed");
    expect(subscribers(source)).toBe(0);
  });

  it("Portal(): content that throws leaves its bindings unsubscribed", async () => {
    const [source] = signal("a");
    document.body.appendChild(
      div([
        Portal(() => {
          bindTo(source);
          throw new Error("portal failed");
        }),
      ]),
    );
    await settle();
    expect(subscribers(source)).toBe(0);
  });

  it("ErrorBoundary(): children that throw leave nothing subscribed behind the fallback", () => {
    const [source] = signal("a");
    const boundary = ErrorBoundary(() => {
      bindTo(source);
      throw new Error("children failed");
    });
    expect(boundary.textContent).not.toBe("");
    expect(subscribers(source)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Fragment() flattens every NodeChildren nesting level.
// ---------------------------------------------------------------------------
describe("Fragment() nested arrays", () => {
  it("appends nodes nested three levels deep instead of stringifying them", () => {
    const a = span("a");
    const b = span("b");
    const frag = Fragment([[[a, b]]] as unknown as NodeChildren[]);
    expect(Array.from(frag.childNodes)).toEqual([a, b]);
  });

  it("skips null and booleans at every level", () => {
    const a = span("a");
    const frag = Fragment([[null, [false, a, true, [undefined]]]] as unknown as NodeChildren[]);
    expect(Array.from(frag.childNodes)).toEqual([a]);
  });
});

// ---------------------------------------------------------------------------
// 4. tagFactory() reads own props only.
// ---------------------------------------------------------------------------
describe("tagFactory own-property semantics", () => {
  it("ignores inherited top-level props, including `on`", () => {
    const click = vi.fn();
    const props = Object.create({ on: { click }, title: "inherited", class: "inherited" });
    props.id = "own";
    const el = div(props) as HTMLElement;
    el.click();
    expect(click).not.toHaveBeenCalled();
    expect(el.hasAttribute("title")).toBe(false);
    expect(el.hasAttribute("class")).toBe(false);
    expect(el.id).toBe("own");
  });

  it("ignores inherited entries in class, style and event maps", () => {
    const inherited = vi.fn();
    const own = vi.fn();
    const on = Object.assign(Object.create({ focus: inherited }), { click: own });
    const cls = Object.assign(Object.create({ ghost: true }), { real: true });
    const style = Object.assign(Object.create({ color: "red" }), { width: "10px" });
    const el = div({ on, class: cls, style }) as HTMLElement;

    el.click();
    el.dispatchEvent(new Event("focus"));
    expect(own).toHaveBeenCalledTimes(1);
    expect(inherited).not.toHaveBeenCalled();
    expect(el.className).toBe("real");
    expect(el.style.color).toBe("");
    expect(el.style.width).toBe("10px");
  });

  it("still applies own props of a non-plain props object", () => {
    class Props {
      title = "own";
    }
    const el = div(new Props() as unknown as Record<string, unknown>) as HTMLElement;
    expect(el.getAttribute("title")).toBe("own");
  });

  it("does not let an own __proto__ key change the copied props' prototype", () => {
    const props = Object.create({ inherited: "x" });
    Object.defineProperty(props, "__proto__", { value: { title: "polluted" }, enumerable: true });
    const el = div(props) as HTMLElement;
    expect(el.hasAttribute("title")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. The lifecycle observer does not depend on <body> existing.
// ---------------------------------------------------------------------------
describe("lifecycle observer root", () => {
  it("works when registered before <body> exists", async () => {
    vi.resetModules();
    const { onMount } = await import("../src/core/rendering/lifecycle");
    const body = document.body;
    body.remove();
    try {
      const el = document.createElement("div");
      const mounted = vi.fn();
      expect(() => onMount(mounted, el)).not.toThrow();
      await settle(); // the deferred registration runs with no <body>

      document.documentElement.appendChild(body);
      body.appendChild(el);
      await settle();
      expect(mounted).toHaveBeenCalledTimes(1);
    } finally {
      if (!body.isConnected) document.documentElement.appendChild(body);
    }
  });

  it("keeps working after <body> is replaced", async () => {
    vi.resetModules();
    const { onMount } = await import("../src/core/rendering/lifecycle");
    const first = document.createElement("div");
    const firstMounted = vi.fn();
    onMount(firstMounted, first); // installs the observer
    await settle();

    const oldBody = document.body;
    const newBody = document.createElement("body");
    oldBody.replaceWith(newBody);
    try {
      const el = document.createElement("div");
      const mounted = vi.fn();
      onMount(mounted, el);
      await settle();
      newBody.appendChild(el);
      await settle();
      expect(mounted).toHaveBeenCalledTimes(1);
    } finally {
      newBody.replaceWith(oldBody);
    }
  });
});
