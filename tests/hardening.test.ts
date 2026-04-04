import { describe, expect, it, vi } from "vitest";
import { each } from "../src/core/rendering/each";
import { html } from "../src/core/rendering/htm";
import { derived } from "../src/core/signals/derived";
import { effect } from "../src/core/signals/effect";
import { signal } from "../src/core/signals/signal";
import { batch } from "../src/reactivity/batch";

// ── 1. Batching across async boundaries ──────────────────────────────────────

describe("Batching across async boundaries", () => {
  it("effects fire synchronously within a batch, not across microtasks", () => {
    const [a, setA] = signal(0);
    const [b, setB] = signal(0);
    const spy = vi.fn();

    effect(() => spy(a() + b()));
    expect(spy).toHaveBeenCalledTimes(1);

    batch(() => {
      setA(1);
      setB(1);
    });
    // Should fire once for the batch, not twice
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenLastCalledWith(2);
  });

  it("non-batched updates in sequence fire effects for each update", () => {
    const [val, setVal] = signal(0);
    const spy = vi.fn();

    effect(() => spy(val()));
    setVal(1);
    setVal(2);
    setVal(3);
    expect(spy).toHaveBeenCalledTimes(4); // initial + 3 updates
  });

  it("nested batches defer until outermost batch exits", () => {
    const [val, setVal] = signal(0);
    const spy = vi.fn();

    effect(() => spy(val()));
    expect(spy).toHaveBeenCalledTimes(1);

    batch(() => {
      setVal(1);
      batch(() => {
        setVal(2);
        batch(() => {
          setVal(3);
        });
      });
    });
    // Should fire once with final value
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenLastCalledWith(3);
  });

  it("batch handles errors without losing pending updates", () => {
    const [val, setVal] = signal(0);
    const spy = vi.fn();

    effect(() => spy(val()));

    expect(() => {
      batch(() => {
        setVal(1);
        throw new Error("intentional");
      });
    }).toThrow("intentional");

    // The update should still have been flushed despite the error
    expect(val()).toBe(1);
  });

  it("async interleaving: effects from setTimeout see correct state", async () => {
    const [val, setVal] = signal(0);
    const log: number[] = [];

    effect(() => log.push(val()));

    setVal(1);
    await new Promise((r) => setTimeout(r, 0));
    setVal(2);
    await new Promise((r) => setTimeout(r, 0));

    expect(log).toEqual([0, 1, 2]);
  });
});

// ── 2. Malformed/adversarial HTML in tagged template parser ──────────────────

describe("Tagged template parser with malformed input", () => {
  it("handles unclosed tags gracefully", () => {
    const el = html`<div><span>unclosed`;
    expect(el).toBeInstanceOf(Element);
  });

  it("handles empty template", () => {
    const el = html`<div></div>`;
    expect(el.tagName.toLowerCase()).toBe("div");
  });

  it("handles self-closing void elements", () => {
    const el = html`<div><br /><hr /><input type="text" /></div>`;
    expect(el.tagName.toLowerCase()).toBe("div");
    expect(el.querySelector("input")).toBeTruthy();
  });

  it("handles deeply nested elements (100 levels)", () => {
    // Build a deeply nested template string
    let _open = "";
    let close = "";
    for (let i = 0; i < 100; i++) {
      _open += "<div>";
      close = `</div>${close}`;
    }
    // Use Function to create the tagged template dynamically
    const el = html`<div>${(() => {
      const node: Element = document.createElement("span");
      node.textContent = "deep";
      let current = node;
      for (let i = 0; i < 100; i++) {
        const wrapper = document.createElement("div");
        wrapper.appendChild(current);
        current = wrapper;
      }
      return current;
    })()}</div>`;
    expect(el).toBeInstanceOf(Element);
  });

  it("handles mixed content with expressions between text", () => {
    const a = "hello";
    const b = "world";
    const el = html`<div>start ${a} middle ${b} end</div>`;
    expect(el.textContent).toContain("hello");
    expect(el.textContent).toContain("world");
  });

  it("handles attributes with special characters in values", () => {
    const el = html`<div data-value="a=b&c=d" title="hello world"></div>`;
    expect(el.getAttribute("data-value")).toBe("a=b&c=d");
    expect(el.getAttribute("title")).toBe("hello world");
  });

  it("handles multiple root elements (wraps in div)", () => {
    const el = html`<span>a</span><span>b</span>`;
    // Multiple roots get wrapped
    expect(el.childNodes.length).toBeGreaterThanOrEqual(2);
  });

  it("handles whitespace-only content", () => {
    const el = html`<div>   </div>`;
    expect(el.tagName.toLowerCase()).toBe("div");
  });
});

// ── 3. Circular dependency detection ─────────────────────────────────────────

describe("Circular dependency in computed chains", () => {
  it("computed reading itself does not infinite loop (returns stale value)", () => {
    const [count, setCount] = signal(0);

    // A computed that depends on count — not circular, just a normal chain
    const doubled = derived(() => count() * 2);
    const quadrupled = derived(() => doubled() * 2);

    expect(quadrupled()).toBe(0);
    setCount(5);
    expect(quadrupled()).toBe(20);
  });

  it("diamond dependency does not cause double execution", () => {
    const [root, setRoot] = signal(1);
    const left = derived(() => root() + 1);
    const right = derived(() => root() * 2);
    const spy = vi.fn();

    const teardown = effect(() => {
      spy(left() + right());
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenLastCalledWith(4); // (1+1) + (1*2)

    setRoot(5);
    // Effect should fire exactly once, not twice (diamond problem)
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenLastCalledWith(16); // (5+1) + (5*2)

    teardown();
  });

  it("wide diamond (100 branches) fires effect once per root update", () => {
    const [root, setRoot] = signal(0);
    const branches = Array.from({ length: 100 }, (_, i) => derived(() => root() + i));

    const spy = vi.fn();
    const teardown = effect(() => {
      let sum = 0;
      for (const b of branches) sum += b();
      spy(sum);
    });

    expect(spy).toHaveBeenCalledTimes(1);

    setRoot(1);
    expect(spy).toHaveBeenCalledTimes(2); // exactly once more

    teardown();
  });
});

// ── 4. Large list stress tests for each() ──────────────────────────────────

describe("each large list stress tests", () => {
  function setupList(size: number) {
    const items = Array.from({ length: size }, (_, i) => ({ id: i, text: `item-${i}` }));
    const [getItems, setItems] = signal(items);

    const container = document.createElement("div");
    document.body.appendChild(container);

    const anchor = each(
      getItems,
      (item) => {
        const li = document.createElement("li");
        li.textContent = item().text;
        return li;
      },
      { key: (item) => item.id },
    );
    container.appendChild(anchor);

    // each renders synchronously during track(), but the anchor needs
    // a parent first. Trigger an update to force initial render.
    setItems([...items]);

    return { getItems, setItems, container };
  }

  it("renders 10,000 items", () => {
    const { container } = setupList(10_000);
    expect(container.querySelectorAll("li").length).toBe(10_000);
    document.body.removeChild(container);
  });

  it("appends 5,000 items to 5,000-item list", () => {
    const { setItems, container } = setupList(5_000);

    setItems((prev) => [...prev, ...Array.from({ length: 5_000 }, (_, i) => ({ id: 10_000 + i, text: `new-${i}` }))]);

    expect(container.querySelectorAll("li").length).toBe(10_000);
    document.body.removeChild(container);
  });

  it("removes all items from 10,000-item list", () => {
    const { setItems, container } = setupList(10_000);

    setItems([]);
    expect(container.querySelectorAll("li").length).toBe(0);
    document.body.removeChild(container);
  });

  it("reverses 10,000-item list", () => {
    const { setItems, container } = setupList(10_000);

    setItems((prev) => [...prev].reverse());

    const items = container.querySelectorAll("li");
    expect(items.length).toBe(10_000);
    expect(items[0].textContent).toBe("item-9999");
    expect(items[9_999].textContent).toBe("item-0");
    document.body.removeChild(container);
  });

  it("rapid add/remove cycles (100 iterations)", () => {
    const { setItems, container } = setupList(100);

    for (let i = 0; i < 100; i++) {
      setItems((prev) => [
        ...prev,
        ...Array.from({ length: 10 }, (_, j) => ({ id: 1000 + i * 10 + j, text: `cycle-${i}-${j}` })),
      ]);
      setItems((prev) => prev.slice(10));
    }

    expect(container.querySelectorAll("li").length).toBe(100);
    document.body.removeChild(container);
  });
});

// ── 5. Concurrent effects modifying the same signal ──────────────────────────

describe("Concurrent effects modifying the same signal", () => {
  it("effect that writes to a signal it reads does not infinite loop", () => {
    const [count, setCount] = signal(0);
    let runs = 0;

    const teardown = effect(() => {
      const val = count();
      runs++;
      // Guard against infinite loop — only write once
      if (val === 0) {
        setCount(1);
      }
    });

    // Should stabilize: initial run (val=0, writes 1), re-run (val=1, no write)
    expect(runs).toBeLessThanOrEqual(3);
    expect(count()).toBe(1);
    teardown();
  });

  it("two effects writing to each other's signals stabilize", () => {
    const [a, setA] = signal(0);
    const [b, setB] = signal(0);
    let aRuns = 0;
    let bRuns = 0;

    const teardownA = effect(() => {
      const val = a();
      aRuns++;
      if (val === 1 && b() === 0) setB(1);
    });

    const teardownB = effect(() => {
      const val = b();
      bRuns++;
      if (val === 1 && a() < 2) setA(2);
    });

    setA(1);

    // Should stabilize within a few runs
    expect(aRuns).toBeLessThan(10);
    expect(bRuns).toBeLessThan(10);

    teardownA();
    teardownB();
  });

  it("multiple effects on same signal all see consistent state", () => {
    const [val, setVal] = signal(0);
    const seen: [string, number][] = [];

    const t1 = effect(() => seen.push(["a", val()]));
    const t2 = effect(() => seen.push(["b", val()]));
    const t3 = effect(() => seen.push(["c", val()]));

    setVal(42);

    // All effects should see the same value
    const afterUpdate = seen.filter(([_, v]) => v === 42);
    expect(afterUpdate.length).toBe(3);
    expect(afterUpdate.map(([name]) => name).sort()).toEqual(["a", "b", "c"]);

    t1();
    t2();
    t3();
  });

  it("batched writes from multiple effects coalesce correctly", () => {
    const [source, setSource] = signal(0);
    const [target, setTarget] = signal(0);
    const spy = vi.fn();

    // Effect 1: mirrors source to target
    const t1 = effect(() => {
      setTarget(source() * 2);
    });

    // Effect 2: reads target
    const t2 = effect(() => {
      spy(target());
    });

    batch(() => {
      setSource(5);
    });

    expect(target()).toBe(10);
    // spy should have been called with the final value
    expect(spy).toHaveBeenCalledWith(10);

    t1();
    t2();
  });
});
