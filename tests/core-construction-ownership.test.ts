import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setRuntimeErrorHandler } from "../src/core/errors";
import { catchError } from "../src/core/rendering/catch";
import { dispose, MAX_DRAIN_TEARDOWNS, registerDisposer } from "../src/core/rendering/dispose";
import { Fragment } from "../src/core/rendering/fragment";
import { div } from "../src/core/rendering/html";
import { onMount } from "../src/core/rendering/lifecycle";
import { mount } from "../src/core/rendering/mount";
import type { NodeChildren } from "../src/core/rendering/types";
import { derived } from "../src/core/signals/derived";
import { effect } from "../src/core/signals/effect";
import { signal } from "../src/core/signals/signal";
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

// ---------------------------------------------------------------------------
// Failed construction: nothing handed back, so nothing may stay subscribed.
// ---------------------------------------------------------------------------
describe("effect() whose first run throws", () => {
  it("rethrows, releases its dependency edges and never runs again", () => {
    const [n, setN] = signal(0);
    let runs = 0;
    expect(() =>
      effect(() => {
        runs++;
        n();
        throw new Error("boom");
      }),
    ).toThrow("boom");

    expect(subscribers(n)).toBe(0);
    setN(1);
    setN(2);
    expect(runs).toBe(1);
  });

  it("runs the cleanups the failed run registered", () => {
    const cleanup = vi.fn();
    expect(() =>
      effect((onCleanup) => {
        onCleanup(cleanup);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("emits neither effect:create nor effect:destroy", () => {
    const emit = vi.fn();
    (globalThis as any).__SIBU_DEVTOOLS_GLOBAL_HOOK__ = { emit };
    try {
      expect(() =>
        effect(() => {
          throw new Error("boom");
        }),
      ).toThrow("boom");
    } finally {
      delete (globalThis as any).__SIBU_DEVTOOLS_GLOBAL_HOOK__;
    }
    const events = emit.mock.calls.map((c) => c[0]);
    expect(events).not.toContain("effect:create");
    expect(events).not.toContain("effect:destroy");
  });
});

describe("derived() whose initial getter throws", () => {
  it("rethrows and leaves its sources with no subscriber", () => {
    const [source, setSource] = signal(1);
    let evaluations = 0;
    expect(() =>
      derived(() => {
        evaluations++;
        source();
        throw new Error("boom");
      }),
    ).toThrow("boom");

    expect(subscribers(source)).toBe(0);
    setSource(2);
    expect(subscribers(source)).toBe(0);
    expect(evaluations).toBe(1);
  });

  it("repeated failed constructions do not accumulate subscribers", () => {
    const [source] = signal(1);
    for (let i = 0; i < 50; i++) {
      expect(() =>
        derived(() => {
          source();
          throw new Error("boom");
        }),
      ).toThrow("boom");
    }
    expect(subscribers(source)).toBe(0);
  });
});

describe("mount() of a throwing component", () => {
  it("rolls back bindings created before the throw", () => {
    const [source, setSource] = signal("a");
    const reads = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);

    expect(() =>
      mount(() => {
        div({
          "data-value": () => {
            reads();
            return source();
          },
        });
        throw new Error("render failed");
      }, container),
    ).toThrow("render failed");

    expect(subscribers(source)).toBe(0);
    reads.mockClear();
    setSource("b");
    expect(reads).not.toHaveBeenCalled();
    expect(container.childNodes.length).toBe(0);
  });

  it("does not roll back a pre-built node owned by the caller", () => {
    const [source, setSource] = signal("a");
    const node = div({ "data-value": () => source() }) as HTMLElement;
    const container = document.createElement("div");
    const app = mount(node, container);
    setSource("b");
    expect(node.getAttribute("data-value")).toBe("b");
    app.unmount();
    expect(subscribers(source)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Fragment: reactive children, and mounting one.
// ---------------------------------------------------------------------------
describe("Fragment() function children", () => {
  it("are reactive, like a tag factory's", () => {
    const [count, setCount] = signal(0);
    const host = div([Fragment([() => `Count: ${count()}`])]) as HTMLElement;
    expect(host.textContent).toBe("Count: 0");
    setCount(1);
    expect(host.textContent).toBe("Count: 1");
  });

  it("stop when the parent they were appended to is disposed", () => {
    const [count, setCount] = signal(0);
    const host = div([Fragment([() => `Count: ${count()}`])]) as HTMLElement;
    dispose(host);
    expect(subscribers(count)).toBe(0);
    setCount(1);
    expect(host.textContent).toBe("Count: 0");
  });
});

describe("mount() of a DocumentFragment", () => {
  it("unmount() disposes and removes every mounted child", () => {
    const [value, setValue] = signal("x");
    const container = document.createElement("div");
    const before = document.createElement("span");
    container.appendChild(before);

    const app = mount(Fragment([div("one"), div({ "data-v": () => value() }, "two")]), container);
    expect(container.textContent).toBe("onetwo");

    app.unmount();
    expect(Array.from(container.childNodes)).toEqual([before]);
    expect(subscribers(value)).toBe(0);
    setValue("y");
  });

  it("also removes nodes a reactive child rendered after mounting", () => {
    const [items, setItems] = signal(["a"]);
    const container = document.createElement("div");
    const app = mount(Fragment([() => items().map((t) => div(t))]), container);
    setItems(["b", "c"]);
    expect(container.textContent).toBe("bc");

    app.unmount();
    expect(container.childNodes.length).toBe(0);
    expect(subscribers(items)).toBe(0);
  });

  it("unmount() is idempotent", () => {
    const container = document.createElement("div");
    const app = mount(Fragment([div("one")]), container);
    app.unmount();
    expect(() => app.unmount()).not.toThrow();
  });
});

describe("mount() of a DocumentFragment whose markers outside code disturbed", () => {
  it("never removes siblings beyond the range if the end marker was lost", () => {
    const container = document.createElement("div");
    const app = mount(Fragment([document.createElement("main")]), container);

    // Outside code removes the closing marker, then appends its own content.
    (container.lastChild as ChildNode).remove();
    const foreign = document.createElement("aside");
    foreign.textContent = "not owned by Sibu";
    container.appendChild(foreign);
    const foreignTeardown = vi.fn();
    registerDisposer(foreign, foreignTeardown);

    app.unmount();

    expect(foreign.parentNode).toBe(container);
    expect(foreignTeardown).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][1]).toMatchObject({ phase: "cleanup", name: "mount" });
  });

  it("reports a lost start marker instead of silently doing nothing", () => {
    const container = document.createElement("div");
    const app = mount(Fragment([document.createElement("main")]), container);
    (container.firstChild as ChildNode).remove(); // the start marker

    app.unmount();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][1]).toMatchObject({ phase: "cleanup", name: "mount" });
    // The end marker is released; a second unmount() is a silent no-op.
    expect(Array.from(container.childNodes).some((n) => n.nodeType === Node.COMMENT_NODE)).toBe(false);
    app.unmount();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("never removes siblings when the markers were reordered", () => {
    const container = document.createElement("div");
    const app = mount(Fragment([document.createElement("main")]), container);
    const start = container.firstChild as ChildNode;
    const foreign = document.createElement("aside");
    container.appendChild(foreign);
    container.appendChild(start); // start now after end and after foreign

    app.unmount();
    expect(foreign.parentNode).toBe(container);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("unmounts a fragment with more top-level nodes than the teardown ceiling", () => {
    const [value] = signal("v");
    const container = document.createElement("div");
    const count = MAX_DRAIN_TEARDOWNS + 5;
    const rows: Node[] = [];
    for (let i = 0; i < count; i++) rows.push(document.createTextNode("x"));
    rows.push(div({ "data-v": () => value() }));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const app = mount(Fragment(rows as NodeChildren[]), container);
    app.unmount();

    expect(container.childNodes.length).toBe(0);
    expect(subscribers(value)).toBe(0);
    expect(errors).not.toHaveBeenCalled();
  });

  it("checks marker order a constant number of times, not once per node", () => {
    const container = document.createElement("div");
    const rows = Array.from({ length: 2000 }, () => document.createElement("p"));
    const app = mount(Fragment(rows), container);
    const order = vi.spyOn(Node.prototype, "compareDocumentPosition");

    app.unmount();

    expect(container.childNodes.length).toBe(0);
    expect(order.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("keeps its markers when a runaway teardown hits the ceiling", () => {
    const container = document.createElement("div");
    const owned = document.createElement("main");
    const app = mount(Fragment([owned]), container);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    // Every inserted node registers another insertion when disposed.
    const grow = (node: Node) => {
      registerDisposer(node, () => {
        const next = document.createElement("ins");
        (node as ChildNode).after(next);
        grow(next);
      });
    };
    grow(owned);

    app.unmount();
    expect(errors).toHaveBeenCalledTimes(1);
    expect(String(errors.mock.calls[0][0])).toContain("runaway cleanup");
    // Both markers remain, so what is left stays reachable.
    const comments = Array.from(container.childNodes).filter((n) => n.nodeType === Node.COMMENT_NODE);
    expect(comments).toHaveLength(2);
  });

  it("drains nodes inserted into the range by teardown", () => {
    const container = document.createElement("div");
    const outside = document.createElement("footer");
    const owned = document.createElement("main");
    const app = mount(Fragment([owned]), container);
    container.appendChild(outside);
    registerDisposer(owned, () => {
      owned.after(document.createElement("ins"));
    });

    app.unmount();
    expect(Array.from(container.childNodes)).toEqual([outside]);
    expect(handler).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// DevTools hook failures never alter the lifecycle.
// ---------------------------------------------------------------------------
describe("a throwing DevTools hook", () => {
  const installHook = (failOn: string) => {
    (globalThis as any).__SIBU_DEVTOOLS_GLOBAL_HOOK__ = {
      emit(event: string) {
        if (event === failOn) throw new Error("devtools");
      },
    };
  };
  afterEach(() => {
    delete (globalThis as any).__SIBU_DEVTOOLS_GLOBAL_HOOK__;
  });

  it("on effect:create does not strand a subscribed effect", () => {
    const [n, setN] = signal(0);
    let runs = 0;
    installHook("effect:create");
    const stop = effect(() => {
      n();
      runs++;
    });
    setN(1);
    expect(runs).toBe(2);
    stop();
    expect(subscribers(n)).toBe(0);
  });

  it("on computed:create still returns a disposable accessor", () => {
    const [source, setSource] = signal(1);
    installHook("computed:create");
    const double = derived(() => source() * 2);
    setSource(2);
    expect(double()).toBe(4);
    double.dispose();
    expect(subscribers(source)).toBe(0);
  });

  it("on computed:update does not break the read", () => {
    const [source, setSource] = signal(1);
    installHook("computed:update"); // derived() captures the hook when created
    const double = derived(() => source() * 2);
    setSource(3);
    expect(double()).toBe(6);
    double.dispose();
  });

  it("on app:init still returns a working unmount()", () => {
    const [value] = signal("x");
    const container = document.createElement("div");
    installHook("app:init");
    const app = mount(() => div({ "data-v": () => value() }) as HTMLElement, container);
    expect(container.childNodes.length).toBe(1);
    app.unmount();
    expect(container.childNodes.length).toBe(0);
    expect(subscribers(value)).toBe(0);
  });

  it("on signal:create and signal:update still creates, sets and notifies", () => {
    installHook("signal:create");
    const [n, setN] = signal(0);
    installHook("signal:update");
    const seen: number[] = [];
    const stop = effect(() => {
      seen.push(n());
    });
    setN(1);
    expect(n()).toBe(1);
    expect(seen).toEqual([0, 1]);
    stop();
  });
});

// ---------------------------------------------------------------------------
// onMount cleanup on native removal.
// ---------------------------------------------------------------------------
describe("onMount() returned cleanup", () => {
  it("runs when the element is removed natively", async () => {
    const cleanup = vi.fn();
    const el = document.createElement("div");
    document.body.appendChild(el);
    onMount(() => cleanup, el);
    await settle();

    el.remove();
    await settle();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("runs once when the element is disposed and then removed", async () => {
    const cleanup = vi.fn();
    const el = document.createElement("div");
    document.body.appendChild(el);
    onMount(() => cleanup, el);
    await settle();

    dispose(el);
    el.remove();
    await settle();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("does not run on a synchronous re-parent", async () => {
    const cleanup = vi.fn();
    const el = document.createElement("div");
    const other = document.createElement("section");
    document.body.append(el, other);
    onMount(() => cleanup, el);
    await settle();

    other.appendChild(el);
    await settle();
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("runs immediately when the mount callback removed its own element", async () => {
    const cleanup = vi.fn();
    const el = document.createElement("div");
    document.body.appendChild(el);
    onMount(() => {
      el.remove();
      return cleanup;
    }, el);
    await settle();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// catchError with a then-only PromiseLike.
// ---------------------------------------------------------------------------
describe("catchError() with a PromiseLike", () => {
  it("observes a rejection from an object with only then()", async () => {
    const onError = vi.fn();
    const failure = new Error("failure");
    const thenable = {
      // biome-ignore lint/suspicious/noThenProperty: a then-only PromiseLike is the subject under test
      then(_resolve: unknown, reject?: (err: unknown) => void) {
        reject?.(failure);
      },
    };
    const result = catchError(() => thenable, onError);
    expect(result).toBe(thenable);
    await settle();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(failure, "async");
  });
});
