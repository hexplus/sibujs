import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "../src/components/ErrorBoundary";
import { type RuntimeErrorContext, setRuntimeErrorHandler } from "../src/core/errors";
import { div } from "../src/core/rendering/html";
import { type DerivedAccessor, derived } from "../src/core/signals/derived";
import { effect } from "../src/core/signals/effect";
import { signal } from "../src/core/signals/signal";
import { writable } from "../src/core/signals/writable";
import { infiniteQuery } from "../src/data/infiniteQuery";
import { clearQueryCache, query } from "../src/data/query";
import { getActiveDevTools, initDevTools } from "../src/devtools/devtools";
import { getSubscriberCount } from "../src/devtools/introspect";
import { bindBoolAttr } from "../src/ui/reactiveAttr";

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};
const tick = () => new Promise((r) => setTimeout(r, 0));

const reports: Array<{ error: unknown; context: RuntimeErrorContext }> = [];
let host: HTMLElement | null = null;

function mount(node: Node): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  container.appendChild(node);
  host = container;
  return container;
}

type Hook = { nodes: Map<number, { type: string }> };
const computedCount = (): number =>
  [
    ...(globalThis as unknown as { __SIBU_DEVTOOLS_GLOBAL_HOOK__: Hook }).__SIBU_DEVTOOLS_GLOBAL_HOOK__.nodes.values(),
  ].filter((n) => n.type === "computed").length;

afterEach(() => {
  setRuntimeErrorHandler(null);
  reports.length = 0;
  host?.remove();
  host = null;
  getActiveDevTools()?.destroy();
  const g = globalThis as unknown as Record<string, unknown>;
  delete g.__SIBU_DEVTOOLS_GLOBAL_HOOK__;
  delete g.__SIBU__;
  delete (window as unknown as Record<string, unknown>).__SIBU_DEVTOOLS__;
  clearQueryCache();
  vi.restoreAllMocks();
});

describe("bindBoolAttr() routes getter failures through the error pipeline", () => {
  it("reports an ordinary getter error as a binding failure on its element and keeps the last value", () => {
    setRuntimeErrorHandler((error, context) => reports.push({ error, context }));
    const el = document.createElement("div");
    const [fail, setFail] = signal(false);
    const boom = new Error("getter failed");
    bindBoolAttr(el, "hidden", () => {
      if (fail()) throw boom;
      return true;
    });
    expect(el.hasAttribute("hidden")).toBe(true);

    setFail(true);

    expect(reports).toHaveLength(1);
    expect(reports[0].error).toBe(boom);
    expect(reports[0].context.phase).toBe("binding");
    expect(reports[0].context.name).toBe("bindBoolAttr");
    expect(reports[0].context.node).toBe(el);
    expect(el.hasAttribute("hidden")).toBe(true);
  });

  it("lets the enclosing ErrorBoundary claim the error", async () => {
    const handler = vi.fn();
    setRuntimeErrorHandler(handler);
    const [fail, setFail] = signal(false);

    const boundary = ErrorBoundary({ fallback: () => div({ class: "fallback" }, "caught") }, () => {
      const el = div({ class: "content" }) as HTMLElement;
      bindBoolAttr(el, "aria-busy", () => {
        if (fail()) throw new Error("getter failed");
        return false;
      });
      return el;
    });
    const container = mount(boundary);
    await flush();
    expect(container.querySelector(".content")?.getAttribute("aria-busy")).toBe("false");

    setFail(true);
    await flush();

    expect(container.querySelector(".fallback")?.textContent).toBe("caught");
    expect(handler).not.toHaveBeenCalled();
  });

  it("delivers a deferred derived failure to the boundary", async () => {
    const handler = vi.fn();
    setRuntimeErrorHandler(handler);
    const [source, setSource] = signal(1);
    let armed = false;
    const busy: DerivedAccessor<boolean> = derived(() => {
      const next = source();
      if (armed) {
        busy.dispose();
        throw new Error("derived failed");
      }
      return next > 5;
    });

    const boundary = ErrorBoundary({ fallback: () => div({ class: "fallback" }, "caught") }, () => {
      const el = div({ class: "content" }) as HTMLElement;
      bindBoolAttr(el, "hidden", busy);
      return el;
    });
    const container = mount(boundary);
    await flush();

    armed = true;
    setSource(2);
    await flush();

    expect(container.querySelector(".fallback")?.textContent).toBe("caught");
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("writable() exposes the derived disposer", () => {
  it("returns a getter whose dispose() releases the upstream signals", () => {
    const [first, setFirst] = signal("Ada");
    const [fullName, setFullName] = writable(
      () => `${first()} Lovelace`,
      (name) => setFirst(name.split(" ")[0]),
    );
    expect(fullName()).toBe("Ada Lovelace");
    expect(getSubscriberCount(first)).toBe(1);

    fullName.dispose();
    expect(getSubscriberCount(first)).toBe(0);
    setFullName("Grace Hopper");
    expect(first()).toBe("Grace");
    expect(fullName()).toBe("Ada Lovelace");
  });
});

describe("composite disposers release the deriveds they own", () => {
  it("query().dispose() disposes loading and isStale", async () => {
    initDevTools();
    const result = query("integration-disposal", async () => 42);
    expect(result.loading()).toBe(true);
    await tick();
    expect(result.data()).toBe(42);
    expect(result.isStale()).toBe(true);
    expect(computedCount()).toBe(2);
    expect(getSubscriberCount(result.fetching)).toBeGreaterThan(0);
    expect(getSubscriberCount(result.data)).toBeGreaterThan(0);

    result.dispose();

    expect(computedCount()).toBe(0);
    expect(getSubscriberCount(result.fetching)).toBe(0);
    expect(getSubscriberCount(result.data)).toBe(0);
    expect(() => result.dispose()).not.toThrow();
  });

  it("infiniteQuery().dispose() disposes data, loading, hasNextPage and hasPreviousPage", async () => {
    initDevTools();
    const result = infiniteQuery("integration-disposal-pages", async ({ pageParam }) => ({ items: [pageParam] }), {
      getNextPageParam: () => undefined,
      initialPageParam: 0,
    });
    await tick();
    expect(result.pages()).toHaveLength(1);
    expect(computedCount()).toBe(4);
    expect(getSubscriberCount(result.pages)).toBeGreaterThan(0);

    result.dispose();

    expect(computedCount()).toBe(0);
    expect(getSubscriberCount(result.pages)).toBe(0);
    expect(getSubscriberCount(result.fetching)).toBe(0);
  });
});

describe("a reader keeps its subscription to a live derived after receiving its error", () => {
  function liveThrower() {
    const [source, setSource] = signal(1);
    const value = derived(() => {
      const next = source();
      if (next < 0) throw new Error(`negative: ${next}`);
      return next;
    });
    return { source, setSource, value };
  }

  it("bindBoolAttr reports the failure, then updates again once the source recovers", () => {
    setRuntimeErrorHandler((error, context) => reports.push({ error, context }));
    const { setSource, value } = liveThrower();
    const el = document.createElement("div");
    bindBoolAttr(el, "hidden", () => value() > 5);
    expect(el.hasAttribute("hidden")).toBe(false);

    setSource(-1);
    expect(reports).toHaveLength(1);
    expect(reports[0].context.name).toBe("bindBoolAttr");
    expect(el.hasAttribute("hidden")).toBe(false);

    setSource(10);
    expect(el.hasAttribute("hidden")).toBe(true);
    setSource(2);
    expect(el.hasAttribute("hidden")).toBe(false);
    expect(reports).toHaveLength(1);
  });

  it("an effect reports the failure, then runs again once the source recovers", () => {
    setRuntimeErrorHandler((error, context) => reports.push({ error, context }));
    const { setSource, value } = liveThrower();
    const seen: number[] = [];
    const stop = effect(() => {
      seen.push(value());
    });

    setSource(-1);
    expect(reports).toHaveLength(1);
    expect(reports[0].context.phase).toBe("effect");

    setSource(7);
    expect(seen).toEqual([1, 7]);
    stop();
  });

  it("a derived chain delivers the failure, then recovers", () => {
    setRuntimeErrorHandler((error, context) => reports.push({ error, context }));
    const { setSource, value } = liveThrower();
    const doubled = derived(() => value() * 2);
    const el = document.createElement("div");
    bindBoolAttr(el, "hidden", () => doubled() > 10);

    setSource(-1);
    expect(reports).toHaveLength(1);

    setSource(6);
    expect(el.hasAttribute("hidden")).toBe(true);
    setSource(1);
    expect(el.hasAttribute("hidden")).toBe(false);
    expect(reports).toHaveLength(1);
  });
});
