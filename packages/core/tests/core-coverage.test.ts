import { afterEach, describe, expect, it, vi } from "vitest";
import { context } from "../src/core/rendering/context";
import { match, when } from "../src/core/rendering/directives";
import { dispose, registerDisposer } from "../src/core/rendering/dispose";
import { each } from "../src/core/rendering/each";
import { Fragment } from "../src/core/rendering/fragment";
import { lazy } from "../src/core/rendering/lazy";
import { mount } from "../src/core/rendering/mount";
import { array } from "../src/core/signals/array";
import { asyncDerived } from "../src/core/signals/asyncDerived";
import { deepEqual } from "../src/core/signals/deepSignal";
import { effect } from "../src/core/signals/effect";
import { signal } from "../src/core/signals/signal";
import { bindTextNode } from "../src/reactivity/bindTextNode";
import { nextTick } from "../src/reactivity/nextTick";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("Fragment edge cases", () => {
  it("handles nested arrays, null, boolean, function→Node and function→string", () => {
    const real = document.createElement("b");
    const frag = Fragment([
      [document.createElement("i"), null, true], // nested array with skips
      null, // top-level null
      false, // top-level boolean
      () => real, // function returning a Node
      () => "txt", // function returning a string
      "plain", // plain string
    ]);
    const kids = Array.from(frag.childNodes);
    // i, real(b), txt-text, plain-text  → 4 nodes (nulls/booleans skipped)
    expect(kids.length).toBe(4);
    expect((kids[0] as Element).tagName).toBe("I");
    expect(kids[1]).toBe(real);
    expect(kids[2].textContent).toBe("txt");
    expect(kids[3].textContent).toBe("plain");
  });

  it("resolves a null inside a nested array to nothing and bare null function to empty text", () => {
    const frag = Fragment([() => null]);
    expect(frag.childNodes.length).toBe(1);
    expect(frag.childNodes[0].textContent).toBe("");
  });
});

describe("mount", () => {
  it("throws when container is null", () => {
    expect(() => mount(document.createElement("div"), null)).toThrow(/container element not found/);
  });

  it("mounts a function component and unmount disposes + detaches", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    let cleaned = false;
    const comp = () => {
      const el = document.createElement("section");
      registerDisposer(el, () => {
        cleaned = true;
      });
      return el;
    };
    const handle = mount(comp, container);
    expect(container.querySelector("section")).toBeTruthy();
    handle.unmount();
    expect(container.querySelector("section")).toBeNull();
    expect(cleaned).toBe(true);
  });

  it("emits devtools app:init / app:unmount when a hook is present", () => {
    const events: string[] = [];
    (globalThis as Record<string, unknown>).__SIBU_DEVTOOLS_GLOBAL_HOOK__ = {
      emit: (name: string) => events.push(name),
    };
    try {
      const container = document.createElement("div");
      const handle = mount(document.createElement("p"), container);
      handle.unmount();
      expect(events).toContain("app:init");
      expect(events).toContain("app:unmount");
    } finally {
      delete (globalThis as Record<string, unknown>).__SIBU_DEVTOOLS_GLOBAL_HOOK__;
    }
  });
});

describe("bindTextNode error path", () => {
  it("swallows a throwing getter and keeps prior text", () => {
    const node = document.createTextNode("start");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    bindTextNode(node, () => {
      throw new Error("boom");
    });
    expect(node.textContent).toBe("start"); // unchanged
    expect(warn).toHaveBeenCalled();
  });
});

describe("nextTick rAF fallback", () => {
  it("resolves via microtask when requestAnimationFrame is unavailable", async () => {
    vi.stubGlobal("requestAnimationFrame", undefined);
    await expect(nextTick()).resolves.toBeUndefined();
  });
});

describe("context.withContext", () => {
  it("restores previous value after fn returns and after fn throws", () => {
    const ctx = context("a");
    const out = ctx.withContext("b", () => ctx.get());
    expect(out).toBe("b");
    expect(ctx.get()).toBe("a"); // restored

    expect(() =>
      ctx.withContext("c", () => {
        throw new Error("x");
      }),
    ).toThrow("x");
    expect(ctx.get()).toBe("a"); // restored even on throw
  });
});

describe("when / match dispose paths", () => {
  it("when() disposes the old branch node on toggle", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const [show, setShow] = signal(true);
    let cleaned = 0;
    const anchor = when(
      () => show(),
      () => {
        const el = document.createElement("b");
        registerDisposer(el, () => cleaned++);
        return el;
      },
      () => document.createTextNode("off"),
    );
    root.appendChild(anchor);
    await Promise.resolve();
    expect(root.querySelector("b")).toBeTruthy();
    setShow(false); // disposes the <b>
    expect(cleaned).toBe(1);
    expect(root.querySelector("b")).toBeNull();
  });

  it("match() disposes the old branch when the key changes", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const [k, setK] = signal<"a" | "b">("a");
    let cleaned = 0;
    const anchor = match(() => k(), {
      a: () => {
        const el = document.createElement("i");
        registerDisposer(el, () => cleaned++);
        return el;
      },
      b: () => document.createElement("u"),
    });
    root.appendChild(anchor);
    await Promise.resolve();
    expect(root.querySelector("i")).toBeTruthy();
    setK("b");
    expect(cleaned).toBe(1);
    expect(root.querySelector("u")).toBeTruthy();
  });
});

describe("dispose re-entrant drain", () => {
  it("runs disposers added during disposal", () => {
    const node = document.createElement("div");
    const order: string[] = [];
    registerDisposer(node, () => {
      order.push("first");
      // Register another disposer DURING disposal — must still run.
      registerDisposer(node, () => order.push("added-during"));
    });
    dispose(node);
    expect(order).toEqual(["first", "added-during"]);
  });

  it("swallows a throw from a disposer added during disposal (drain catch)", () => {
    const node = document.createElement("div");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let drained = false;
    registerDisposer(node, () => {
      registerDisposer(node, () => {
        drained = true;
        throw new Error("drain-boom");
      });
    });
    expect(() => dispose(node)).not.toThrow();
    expect(drained).toBe(true);
    expect(warn).toHaveBeenCalled();
  });
});

describe("deepEqual built-in types", () => {
  it("compares Date, RegExp, Map, Set, ArrayBuffer, DataView, TypedArray, cycles", () => {
    expect(deepEqual(new Date(5), new Date(5))).toBe(true);
    expect(deepEqual(new Date(5), new Date(6))).toBe(false);
    expect(deepEqual(/a/gi, /a/gi)).toBe(true);
    expect(deepEqual(/a/g, /a/i)).toBe(false);

    expect(deepEqual(new Map([["a", 1]]), new Map([["a", 1]]))).toBe(true);
    expect(deepEqual(new Map([["a", 1]]), new Map([["a", 2]]))).toBe(false);
    expect(deepEqual(new Map([["a", 1]]), new Map([["b", 1]]))).toBe(false);

    expect(deepEqual(new Set([1, 2]), new Set([1, 2]))).toBe(true);
    expect(deepEqual(new Set([1, 2]), new Set([1, 3]))).toBe(false);

    const ab1 = new Uint8Array([1, 2, 3]).buffer;
    const ab2 = new Uint8Array([1, 2, 3]).buffer;
    const ab3 = new Uint8Array([1, 2, 4]).buffer;
    expect(deepEqual(ab1, ab2)).toBe(true);
    expect(deepEqual(ab1, ab3)).toBe(false);

    const dv1 = new DataView(new Uint8Array([9, 8]).buffer);
    const dv2 = new DataView(new Uint8Array([9, 8]).buffer);
    const dv3 = new DataView(new Uint8Array([9, 7]).buffer);
    expect(deepEqual(dv1, dv2)).toBe(true);
    expect(deepEqual(dv1, dv3)).toBe(false);
    expect(deepEqual(dv1, new DataView(new Uint8Array([9, 8, 7]).buffer))).toBe(false);

    expect(deepEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(deepEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);

    // constructor mismatch + key-set mismatch + nested arrays
    expect(deepEqual(new Date(1), {})).toBe(false);
    expect(deepEqual({ a: undefined, b: 2 }, { x: undefined, b: 2 })).toBe(false);
    expect(deepEqual([1, [2, 3]], [1, [2, 3]])).toBe(true);
    expect(deepEqual([1, [2, 3]], [1, [2, 4]])).toBe(false);

    // cycle
    const c1: Record<string, unknown> = { v: 1 };
    c1.self = c1;
    const c2: Record<string, unknown> = { v: 1 };
    c2.self = c2;
    expect(deepEqual(c1, c2)).toBe(true);
  });
});

describe("array() non-reactive actions", () => {
  it("covers filter and map (replace) actions", () => {
    const [items, actions] = array([1, 2, 3, 4]);
    actions.filter((n) => n % 2 === 0);
    expect(items()).toEqual([2, 4]);
    actions.map((n) => n * 10);
    expect(items()).toEqual([20, 40]);
  });
});

describe("effect dispose error handling", () => {
  it("swallows an onCleanup that throws during dispose", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stop = effect((onCleanup) => {
      onCleanup(() => {
        throw new Error("cleanup-boom");
      });
    });
    expect(() => stop()).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });
});

describe("each render-throws path", () => {
  it("renders an error comment and does not crash when render throws", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const [items, setItems] = signal([1, 2]);
    const anchor = each(
      items,
      (item) => {
        if (item() === 2) throw new Error("render-fail");
        const el = document.createElement("span");
        el.textContent = String(item());
        return el;
      },
      { key: (n) => n },
    );
    root.appendChild(anchor);
    setItems([1, 2]); // force render
    await Promise.resolve();
    expect(root.querySelector("span")?.textContent).toBe("1");
    expect(warn).toHaveBeenCalled();
  });
});

describe("asyncDerived", () => {
  it("captures a synchronous factory throw into error()", async () => {
    const res = asyncDerived(() => {
      throw new Error("sync-fail");
    }, "init");
    await Promise.resolve();
    expect(res.error()).toBeInstanceOf(Error);
    expect(res.loading()).toBe(false);
    expect(res.value()).toBe("init");
  });

  it("drops stale results and surfaces the latest via refresh()", async () => {
    let n = 0;
    const res = asyncDerived(async () => {
      n++;
      return n;
    }, 0);
    await new Promise((r) => setTimeout(r, 0));
    expect(res.value()).toBe(1);
    res.refresh();
    await new Promise((r) => setTimeout(r, 0));
    expect(res.value()).toBe(2);
  });
});

describe("lazy load-failure propagation", () => {
  it("renders an error node and dispatches sibu:error-propagate when mounted", async () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    let propagated: Error | null = null;
    root.addEventListener("sibu:error-propagate", (e) => {
      propagated = (e as CustomEvent).detail.error;
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const Lazy = lazy(() => Promise.reject(new Error("net-down")));
    const el = Lazy();
    root.appendChild(el);
    await new Promise((r) => setTimeout(r, 0));
    expect(el.querySelector(".sibu-lazy-error")).toBeTruthy();
    expect(propagated).toBeInstanceOf(Error);
    expect(warn).toHaveBeenCalled();
  });
});

describe("signal custom equals + devtools hook", () => {
  it("custom equals suppresses notification for structurally-equal values", () => {
    const [v, setV] = signal({ n: 1 }, { equals: (a, b) => a.n === b.n });
    let runs = 0;
    effect(() => {
      v();
      runs++;
    });
    expect(runs).toBe(1);
    setV({ n: 1 }); // equal by custom eq → no notify
    expect(runs).toBe(1);
    setV({ n: 2 }); // different → notify
    expect(runs).toBe(2);
  });

  it("emits devtools signal:create / signal:update hooks", () => {
    const events: string[] = [];
    (globalThis as Record<string, unknown>).__SIBU_DEVTOOLS_GLOBAL_HOOK__ = {
      emit: (name: string) => events.push(name),
    };
    try {
      const [v, setV] = signal(0, { name: "probe" });
      setV(1);
      void v();
      expect(events).toContain("signal:create");
      expect(events).toContain("signal:update");
    } finally {
      delete (globalThis as Record<string, unknown>).__SIBU_DEVTOOLS_GLOBAL_HOOK__;
    }
  });
});
