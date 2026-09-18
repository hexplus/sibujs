import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type RuntimeErrorContext, setRuntimeErrorHandler } from "../src/core/errors";
import { registerDisposer } from "../src/core/rendering/dispose";
import { div } from "../src/core/rendering/html";
import { effect } from "../src/core/signals/effect";
import { signal } from "../src/core/signals/signal";
import { getSubscriberCount } from "../src/devtools/introspect";
import { defineElement } from "../src/platform/customElement";
import { createISR } from "../src/platform/incrementalRegeneration";
import { createCypressAdapter, createJestAdapter, createUniversalAdapter } from "../src/testing/adapters";
import { createTimerMock, testComponent } from "../src/testing/e2e";
import { snapshotComponent } from "../src/testing/snapshot";
import { createListbox } from "../src/ui/a11yPrimitives";

afterEach(() => {
  setRuntimeErrorHandler(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

const flush = async () => {
  for (let i = 0; i < 3; i++) await Promise.resolve();
};

// ---------------------------------------------------------------------------
// 50. A failing custom-element rerender keeps the working component.
//
// THE DEFECT: _render() tore the current subtree down before calling the
// component factory, so a throwing rerender (e.g. an invalid attribute value)
// left the element permanently blank with its live state already disposed.
// ---------------------------------------------------------------------------
describe("defineElement rerender transaction", () => {
  let counter = 0;
  const uniqueName = (base: string) => `${base}-${++counter}-${Math.random().toString(36).slice(2, 7)}`;

  it("a throwing attribute rerender preserves the old DOM and subscriptions, and is reported", async () => {
    const reports: Array<{ error: unknown; context: RuntimeErrorContext }> = [];
    setRuntimeErrorHandler((error, context) => reports.push({ error, context }));
    const [label, setLabel] = signal("working");
    const teardown = vi.fn();
    const name = uniqueName("x-profile");

    defineElement(
      name,
      (props) => {
        if (props.mode === "invalid") throw new Error("bad props");
        const el = div(() => label()) as HTMLElement;
        registerDisposer(el, teardown);
        return el;
      },
      { observedAttributes: ["mode"], shadow: false },
    );

    const host = document.createElement(name);
    document.body.append(host);
    expect(host.textContent).toBe("working");
    const liveNode = host.firstElementChild;
    expect(getSubscriberCount(label)).toBe(1);

    host.setAttribute("mode", "invalid");

    expect(host.firstElementChild).toBe(liveNode);
    expect(teardown).not.toHaveBeenCalled();
    setLabel("still live");
    expect(host.textContent).toBe("still live");
    expect(reports).toHaveLength(1);
    expect((reports[0].error as Error).message).toBe("bad props");
    expect(reports[0].context.node).toBe(host);
  });

  it("a successful rerender disposes the old tree exactly once", () => {
    const teardowns: string[] = [];
    const name = uniqueName("x-mode");
    defineElement(
      name,
      (props) => {
        const el = document.createElement("span");
        el.textContent = String(props.mode ?? "none");
        registerDisposer(el, () => teardowns.push(el.textContent ?? ""));
        return el;
      },
      { observedAttributes: ["mode"], shadow: false },
    );

    const host = document.createElement(name);
    document.body.append(host);
    host.setAttribute("mode", "a");
    host.setAttribute("mode", "b");

    expect(host.textContent).toBe("b");
    expect(teardowns).toEqual(["none", "a"]);
    expect(host.children).toHaveLength(1);
  });

  it("keeps exactly one style node across successful and failed rerenders", () => {
    setRuntimeErrorHandler(() => {});
    const name = uniqueName("x-styled");
    defineElement(
      name,
      (props) => {
        if (props.mode === "invalid") throw new Error("bad");
        const el = document.createElement("p");
        el.textContent = String(props.mode ?? "ok");
        return el;
      },
      { observedAttributes: ["mode"], styles: "p { color: red; }" },
    );

    const host = document.createElement(name);
    document.body.append(host);
    const root = host.shadowRoot!;
    host.setAttribute("mode", "second");
    expect(root.querySelectorAll("style")).toHaveLength(1);
    expect(root.querySelector("p")?.textContent).toBe("second");

    host.setAttribute("mode", "invalid");
    expect(root.querySelectorAll("style")).toHaveLength(1);
    expect(root.querySelector("p")?.textContent).toBe("second");
  });

  it("rolls back reactive resources the failing factory created before throwing", () => {
    setRuntimeErrorHandler(() => {});
    const [value] = signal(1);
    const name = uniqueName("x-partial");
    defineElement(
      name,
      (props) => {
        const el = div(() => String(value())) as HTMLElement;
        if (props.mode === "invalid") throw new Error("failed after creating a binding");
        return el;
      },
      { observedAttributes: ["mode"], shadow: false },
    );

    const host = document.createElement(name);
    document.body.append(host);
    expect(getSubscriberCount(value)).toBe(1);

    host.setAttribute("mode", "invalid");

    // Only the live render's binding remains; the abandoned one was released.
    expect(getSubscriberCount(value)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 52. Testing utilities run framework disposal on teardown.
// ---------------------------------------------------------------------------
describe("testing utilities dispose what they render", () => {
  function tracked() {
    const [value, setValue] = signal(0);
    let runs = 0;
    const teardown = vi.fn();
    const component = () => {
      const el = div(() => {
        runs++;
        return String(value());
      }) as HTMLElement;
      registerDisposer(el, teardown);
      return el;
    };
    return { value, setValue, component, teardown, runs: () => runs };
  }

  it("snapshotComponent disposes its temporary render", () => {
    const t = tracked();
    snapshotComponent(t.component);
    const runsAfter = t.runs();

    t.setValue(1);

    expect(t.runs()).toBe(runsAfter);
    expect(t.teardown).toHaveBeenCalledTimes(1);
    expect(getSubscriberCount(t.value)).toBe(0);
  });

  it("snapshotComponent still disposes when serialization throws", () => {
    const t = tracked();
    const component = () => {
      const el = t.component();
      Object.defineProperty(el, "attributes", {
        get() {
          throw new Error("serialize exploded");
        },
      });
      return el;
    };

    expect(() => snapshotComponent(component)).toThrow("serialize exploded");
    expect(t.teardown).toHaveBeenCalledTimes(1);
    expect(getSubscriberCount(t.value)).toBe(0);
  });

  for (const [label, make] of [
    ["Jest adapter", createJestAdapter],
    ["universal adapter", createUniversalAdapter],
  ] as const) {
    it(`${label} teardown disposes rendered components once`, () => {
      const adapter = make();
      const t = tracked();
      adapter.setup();
      adapter.render(t.component);
      expect(getSubscriberCount(t.value)).toBe(1);

      adapter.teardown();
      t.setValue(5);

      expect(t.teardown).toHaveBeenCalledTimes(1);
      expect(getSubscriberCount(t.value)).toBe(0);
    });

    it(`${label}: repeated render/teardown does not accumulate subscribers`, () => {
      const adapter = make();
      const t = tracked();
      for (let i = 0; i < 10; i++) {
        adapter.setup();
        adapter.render(t.component);
        adapter.teardown();
      }
      expect(getSubscriberCount(t.value)).toBe(0);
      expect(t.teardown).toHaveBeenCalledTimes(10);
    });
  }

  it("testComponent destroy() disposes the component", () => {
    const t = tracked();
    const tc = testComponent(t.component);
    tc.destroy();
    t.setValue(3);
    expect(t.teardown).toHaveBeenCalledTimes(1);
    expect(getSubscriberCount(t.value)).toBe(0);
    expect(tc.container.isConnected).toBe(false);
  });

  it("the Cypress adapter mount exposes a disposal-aware unmount", () => {
    const t = tracked();
    const mounted = createCypressAdapter().mount(t.component);
    mounted.unmount();
    mounted.unmount();
    expect(t.teardown).toHaveBeenCalledTimes(1);
    expect(getSubscriberCount(t.value)).toBe(0);
    expect(mounted.container.isConnected).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 53. The fake timer keeps zero-delay intervals recurring.
// ---------------------------------------------------------------------------
describe("createTimerMock intervals", () => {
  let timers: ReturnType<typeof createTimerMock>;

  beforeEach(() => {
    timers = createTimerMock();
    timers.install();
  });

  afterEach(() => {
    timers.restore();
  });

  for (const delay of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
    it(`an interval with delay ${delay} stays recurring`, () => {
      let calls = 0;
      setInterval(() => calls++, delay);

      timers.advance(10);

      expect(calls).toBeGreaterThan(1);
      expect(timers.pendingCount()).toBe(1);
    });
  }

  it("clearInterval() from inside the callback stops it", () => {
    let calls = 0;
    const id = setInterval(() => {
      calls++;
      if (calls === 3) clearInterval(id);
    }, 0);

    timers.advance(100);
    timers.flush();

    expect(calls).toBe(3);
    expect(timers.pendingCount()).toBe(0);
  });

  it("timeouts remain one-shot, including zero-delay ones", () => {
    let calls = 0;
    setTimeout(() => calls++, 0);
    setTimeout(() => calls++, 10);
    timers.flush();
    expect(calls).toBe(2);
    expect(timers.pendingCount()).toBe(0);
  });

  it("flush reports hitting its runaway limit on a recurring interval", () => {
    const reports: unknown[] = [];
    setRuntimeErrorHandler((error) => reports.push(error));
    setInterval(() => {}, 0);

    timers.flush();

    expect(reports).toHaveLength(1);
    expect(String((reports[0] as Error).message)).toMatch(/flush/i);
  });
});

// ---------------------------------------------------------------------------
// 56. ISR isStale() is reactive as time passes.
// ---------------------------------------------------------------------------
describe("createISR staleness", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  function deferredFetcher<T>() {
    const calls: Array<{ resolve: (v: T) => void; reject: (e: Error) => void }> = [];
    const fetcher = vi.fn(
      () =>
        new Promise<T>((resolve, reject) => {
          calls.push({ resolve, reject });
        }),
    );
    return { fetcher, calls };
  }

  it("becomes stale reactively at the deadline", async () => {
    const { fetcher } = deferredFetcher<string>();
    const isr = createISR({ initialData: "cached", revalidateAfter: 1000, fetcher });
    const seen: boolean[] = [];
    const stop = effect(() => {
      seen.push(isr.isStale());
    });

    expect(seen).toEqual([false]);
    vi.advanceTimersByTime(999);
    expect(seen).toEqual([false]);
    vi.advanceTimersByTime(1);
    expect(seen).toEqual([false, true]);

    stop();
    isr.dispose();
  });

  it("stays stale during a slow revalidation and after it fails", async () => {
    const { fetcher, calls } = deferredFetcher<string>();
    const isr = createISR({ initialData: "cached", revalidateAfter: 1000, fetcher });

    vi.advanceTimersByTime(1000);
    expect(isr.isStale()).toBe(true);
    expect(calls).toHaveLength(1);

    calls[0].reject(new Error("offline"));
    await flush();
    expect(isr.isStale()).toBe(true);
    expect(isr.data()).toBe("cached");
    isr.dispose();
  });

  it("resets after a successful revalidation and re-arms the deadline", async () => {
    const { fetcher, calls } = deferredFetcher<string>();
    const isr = createISR({ initialData: "cached", revalidateAfter: 1000, fetcher });

    vi.advanceTimersByTime(1000);
    calls[0].resolve("fresh");
    await flush();
    expect(isr.data()).toBe("fresh");
    expect(isr.isStale()).toBe(false);

    vi.advanceTimersByTime(1000);
    expect(isr.isStale()).toBe(true);
    isr.dispose();
  });

  it("with no initial data it is stale until the first fetch succeeds", async () => {
    const { fetcher, calls } = deferredFetcher<string>();
    const isr = createISR<string>({ revalidateAfter: 1000, fetcher });
    expect(isr.isStale()).toBe(true);
    calls[0].resolve("first");
    await flush();
    expect(isr.isStale()).toBe(false);
    isr.dispose();
  });

  it("disposal cancels the deadline", () => {
    const { fetcher } = deferredFetcher<string>();
    const isr = createISR({ initialData: "cached", revalidateAfter: 1000, fetcher });
    isr.dispose();

    vi.advanceTimersByTime(5000);

    expect(isr.isStale()).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects an invalid revalidateAfter", () => {
    const fetcher = async () => "x";
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => createISR({ revalidateAfter: bad, fetcher, initialData: "x" })).toThrow(RangeError);
    }
  });
});

// ---------------------------------------------------------------------------
// 57. Dynamically added listbox options get complete ARIA state.
// ---------------------------------------------------------------------------
describe("createListbox dynamic options", () => {
  function makeListbox(values: string[]) {
    const ul = document.createElement("ul");
    for (const v of values) ul.insertAdjacentHTML("beforeend", `<li role="option" data-value="${v}">${v}</li>`);
    document.body.appendChild(ul);
    return ul;
  }
  const key = (el: HTMLElement, k: string) => el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));

  it("an option added after creation gets an id and becomes a valid active descendant", () => {
    const ul = makeListbox([]);
    const lb = createListbox(ul);
    ul.insertAdjacentHTML("beforeend", '<li role="option" data-value="new">New</li>');

    key(ul, "ArrowDown");

    const option = ul.querySelector("li")!;
    expect(option.id).not.toBe("");
    expect(lb.activeDescendantId()).toBe(option.id);
    expect(ul.getAttribute("aria-activedescendant")).toBe(option.id);
    expect(option.getAttribute("aria-selected")).toBe("false");
    lb.dispose();
  });

  it("new options are initialized without interaction, reflecting current selection", async () => {
    const ul = makeListbox(["a"]);
    const lb = createListbox(ul, { multiple: true });
    ul.querySelector("li")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    ul.innerHTML = "";
    ul.insertAdjacentHTML("beforeend", '<li role="option" data-value="a">A again</li>');
    ul.insertAdjacentHTML("beforeend", '<li role="option" data-value="b">B</li>');
    await flush();

    const [a, b] = Array.from(ul.querySelectorAll("li"));
    expect(a.id).not.toBe("");
    expect(b.id).not.toBe("");
    expect(a.getAttribute("aria-selected")).toBe("true");
    expect(b.getAttribute("aria-selected")).toBe("false");
    lb.dispose();
  });

  it("removing the active option clears the active descendant", async () => {
    const ul = makeListbox(["a", "b"]);
    const lb = createListbox(ul);
    key(ul, "ArrowDown");
    expect(lb.activeValue()).toBe("a");

    ul.querySelector('[data-value="a"]')!.remove();
    await flush();

    expect(lb.activeValue()).toBeNull();
    expect(lb.activeDescendantId()).toBeNull();
    expect(ul.hasAttribute("aria-activedescendant")).toBe(false);
    lb.dispose();
  });

  it("refresh() reconciles synchronously", () => {
    const ul = makeListbox([]);
    const lb = createListbox(ul);
    ul.insertAdjacentHTML("beforeend", '<li role="option" data-value="x">X</li>');
    lb.refresh();
    expect(ul.querySelector("li")!.id).not.toBe("");
    lb.dispose();
  });

  it("dispose() stops observing option changes", async () => {
    const ul = makeListbox([]);
    const lb = createListbox(ul);
    lb.dispose();
    ul.insertAdjacentHTML("beforeend", '<li role="option" data-value="late">Late</li>');
    await flush();
    expect(ul.querySelector("li")!.id).toBe("");
  });
});
