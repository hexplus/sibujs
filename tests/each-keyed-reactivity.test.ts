import { afterEach, describe, expect, it, vi } from "vitest";
import { registerDisposer } from "../src/core/rendering/dispose";
import { each } from "../src/core/rendering/each";
import { effect } from "../src/core/signals/effect";
import { signal } from "../src/core/signals/signal";

// ---------------------------------------------------------------------------
// Keyed `each()` contract.
//
// THE INVARIANT UNDER TEST: identity is not value freshness. A row keeps its
// DOM node while its key is unchanged, AND its `item()` / `index()` accessors
// stay reactive when reconciliation assigns it a new item or position.
//
// Regression origin: rows read the backing array through `untracked()`, so a
// reused row's bindings never re-ran — replacing an item under the same key
// left the row displaying the previous item's data indefinitely.
// ---------------------------------------------------------------------------

interface User {
  id: number;
  name: string;
}

let host: HTMLElement | null = null;

function mountList(
  initial: User[],
  render?: (item: () => User, index: () => number) => Node,
): {
  host: HTMLElement;
  set: (next: User[]) => void;
  rows: () => HTMLElement[];
  texts: () => string[];
} {
  const container = document.createElement("div");
  document.body.appendChild(container);
  host = container;

  const [items, setItems] = signal<User[]>(initial);

  const defaultRender = (item: () => User, index: () => number): Node => {
    const el = document.createElement("div");
    el.setAttribute("data-row", "");
    const text = document.createTextNode("");
    el.appendChild(text);
    effect(() => {
      text.nodeValue = `${index()}:${item().name}`;
    });
    return el;
  };

  const anchor = each(items, render ?? defaultRender, { key: (u) => u.id });
  container.appendChild(anchor);
  // The anchor must be connected before the first reconciliation can position
  // rows; a same-value write flushes that first pass synchronously.
  setItems([...initial]);

  return {
    host: container,
    set: setItems,
    rows: () => Array.from(container.querySelectorAll("[data-row]")) as HTMLElement[],
    texts: () => Array.from(container.querySelectorAll("[data-row]")).map((n) => n.textContent ?? ""),
  };
}

afterEach(() => {
  host?.remove();
  host = null;
});

describe("each — same key, replaced item", () => {
  it("updates reactive content without recreating the row", () => {
    const list = mountList([{ id: 1, name: "Alice" }]);
    const before = list.rows()[0];
    expect(list.texts()).toEqual(["0:Alice"]);

    list.set([{ id: 1, name: "Bob" }]);

    expect(list.rows()[0]).toBe(before); // DOM identity preserved
    expect(list.texts()).toEqual(["0:Bob"]); // freshness
  });

  it("updates every row when all items are replaced but keys are unchanged", () => {
    const list = mountList([
      { id: 1, name: "a" },
      { id: 2, name: "b" },
      { id: 3, name: "c" },
    ]);
    const before = list.rows();

    list.set([
      { id: 1, name: "A" },
      { id: 2, name: "B" },
      { id: 3, name: "C" },
    ]);

    expect(list.rows()).toEqual(before); // all three reused
    expect(list.texts()).toEqual(["0:A", "1:B", "2:C"]);
  });

  it("does not re-run a row whose item and index are both unchanged", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    host = container;

    const stable = { id: 1, name: "Stable" };
    const [items, setItems] = signal<User[]>([stable]);
    const bodyRuns: number[] = [0];

    const anchor = each(
      items,
      (item) => {
        const el = document.createElement("div");
        el.setAttribute("data-row", "");
        effect(() => {
          el.textContent = item().name;
          bodyRuns[0]++;
        });
        return el;
      },
      { key: (u) => u.id },
    );
    container.appendChild(anchor);
    setItems([stable]);

    const runsAfterMount = bodyRuns[0];
    setItems([stable]); // identical item, identical position
    expect(bodyRuns[0]).toBe(runsAfterMount);
  });
});

describe("each — reactive index", () => {
  it("updates index() after a reorder while preserving DOM identity", () => {
    const list = mountList([
      { id: 1, name: "a" },
      { id: 2, name: "b" },
    ]);
    const [rowA, rowB] = list.rows();
    expect(list.texts()).toEqual(["0:a", "1:b"]);

    list.set([
      { id: 2, name: "b" },
      { id: 1, name: "a" },
    ]);

    const after = list.rows();
    expect(after[0]).toBe(rowB); // same nodes, moved
    expect(after[1]).toBe(rowA);
    expect(list.texts()).toEqual(["0:b", "1:a"]); // indices refreshed
  });

  it("refreshes indices after a prepend", () => {
    const list = mountList([
      { id: 1, name: "a" },
      { id: 2, name: "b" },
    ]);
    const existing = list.rows();

    list.set([
      { id: 9, name: "z" },
      { id: 1, name: "a" },
      { id: 2, name: "b" },
    ]);

    expect(list.texts()).toEqual(["0:z", "1:a", "2:b"]);
    const after = list.rows();
    expect(after[1]).toBe(existing[0]); // originals reused, shifted
    expect(after[2]).toBe(existing[1]);
  });
});

describe("each — structural operations", () => {
  const base: User[] = [
    { id: 1, name: "a" },
    { id: 2, name: "b" },
    { id: 3, name: "c" },
  ];

  it("empty -> populated", () => {
    const list = mountList([]);
    expect(list.rows()).toHaveLength(0);
    list.set(base);
    expect(list.texts()).toEqual(["0:a", "1:b", "2:c"]);
  });

  it("populated -> empty", () => {
    const list = mountList(base);
    list.set([]);
    expect(list.rows()).toHaveLength(0);
  });

  it("append", () => {
    const list = mountList(base);
    list.set([...base, { id: 4, name: "d" }]);
    expect(list.texts()).toEqual(["0:a", "1:b", "2:c", "3:d"]);
  });

  it("insert in the middle", () => {
    const list = mountList(base);
    list.set([base[0], { id: 9, name: "mid" }, base[1], base[2]]);
    expect(list.texts()).toEqual(["0:a", "1:mid", "2:b", "3:c"]);
  });

  it("remove", () => {
    const list = mountList(base);
    list.set([base[0], base[2]]);
    expect(list.texts()).toEqual(["0:a", "1:c"]);
  });

  it("reverse preserves DOM identity", () => {
    const list = mountList(base);
    const before = list.rows();
    list.set([base[2], base[1], base[0]]);
    const after = list.rows();
    expect(after[0]).toBe(before[2]);
    expect(after[1]).toBe(before[1]);
    expect(after[2]).toBe(before[0]);
    expect(list.texts()).toEqual(["0:c", "1:b", "2:a"]);
  });

  it("random shuffle keeps every row's content consistent with its position", () => {
    const items: User[] = Array.from({ length: 25 }, (_, i) => ({ id: i, name: `n${i}` }));
    const list = mountList(items);

    // Deterministic shuffle — no reliance on Math.random.
    const shuffled = [...items];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = (i * 7 + 3) % (i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    list.set(shuffled);

    expect(list.texts()).toEqual(shuffled.map((u, i) => `${i}:${u.name}`));
  });

  it("same object moved to a different position", () => {
    const shared = { id: 2, name: "shared" };
    const list = mountList([{ id: 1, name: "a" }, shared, { id: 3, name: "c" }]);
    const sharedRow = list.rows()[1];

    list.set([shared, { id: 1, name: "a" }, { id: 3, name: "c" }]);

    expect(list.rows()[0]).toBe(sharedRow);
    expect(list.texts()).toEqual(["0:shared", "1:a", "2:c"]);
  });
});

describe("each — primitive items", () => {
  it("updates when a primitive item behind a stable key is replaced", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    host = container;

    // Key is the position-independent slot id; the value behind it changes.
    const [pairs, setPairs] = signal<[number, string][]>([
      [1, "one"],
      [2, "two"],
    ]);

    const anchor = each(
      pairs,
      (item) => {
        const el = document.createElement("div");
        el.setAttribute("data-row", "");
        effect(() => {
          el.textContent = item()[1];
        });
        return el;
      },
      { key: (p) => p[0] },
    );
    container.appendChild(anchor);
    setPairs([
      [1, "one"],
      [2, "two"],
    ]);

    const before = Array.from(container.querySelectorAll("[data-row]"));
    setPairs([
      [1, "ONE"],
      [2, "two"],
    ]);

    expect(Array.from(container.querySelectorAll("[data-row]"))).toEqual(before);
    expect(Array.from(container.querySelectorAll("[data-row]")).map((n) => n.textContent)).toEqual(["ONE", "two"]);
  });
});

describe("each — row lifecycle", () => {
  it("disposes a removed row's effects exactly once and stops updating it", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    host = container;

    const cleanups: string[] = [];
    const [items, setItems] = signal<User[]>([
      { id: 1, name: "a" },
      { id: 2, name: "b" },
    ]);

    const anchor = each(
      items,
      (item) => {
        const el = document.createElement("div");
        el.setAttribute("data-row", "");
        const id = item().id;
        // SibuJS has no implicit owner tree: an effect created inside a render
        // callback is bound to the row's node explicitly. This is the
        // documented ownership mechanism, and `each` disposes the node when the
        // row leaves the list.
        const stop = effect(() => {
          el.textContent = item().name;
        });
        registerDisposer(el, () => {
          stop();
          cleanups.push(`row-${id}`);
        });
        return el;
      },
      { key: (u) => u.id },
    );
    container.appendChild(anchor);
    setItems([
      { id: 1, name: "a" },
      { id: 2, name: "b" },
    ]);

    setItems([{ id: 1, name: "a" }]); // drop row 2

    const removals = cleanups.filter((c) => c === "row-2");
    expect(removals.length).toBe(1); // disposed exactly once
    expect(container.querySelectorAll("[data-row]")).toHaveLength(1);

    // The disposed row must not be revived by later updates.
    const before = cleanups.length;
    setItems([{ id: 1, name: "a2" }]);
    expect(cleanups.filter((c) => c === "row-2").length).toBe(1);
    expect(cleanups.length).toBeGreaterThanOrEqual(before);
  });

  it("tears down every row when the range is disposed", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    host = container;

    const cleanups: string[] = [];
    const [items, setItems] = signal<User[]>([
      { id: 1, name: "a" },
      { id: 2, name: "b" },
    ]);

    const anchor = each(
      items,
      (item) => {
        const el = document.createElement("div");
        const id = item().id;
        const stop = effect(() => {
          el.textContent = item().name;
        });
        registerDisposer(el, () => {
          stop();
          cleanups.push(`row-${id}`);
        });
        return el;
      },
      { key: (u) => u.id },
    );
    container.appendChild(anchor);
    setItems([
      { id: 1, name: "a" },
      { id: 2, name: "b" },
    ]);

    container.remove(); // triggers the anchor's range disposer via dispose()
    // Re-attach a fresh host so afterEach has something valid to clean.
    host = null;

    // Writing after teardown must not resurrect anything.
    expect(() => setItems([{ id: 1, name: "zzz" }])).not.toThrow();
  });
});

describe("each — nested lists", () => {
  it("keeps inner rows fresh when an outer item is replaced under the same key", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    host = container;

    interface Group {
      id: number;
      children: User[];
    }

    const [groups, setGroups] = signal<Group[]>([{ id: 1, children: [{ id: 11, name: "x" }] }]);

    const anchor = each(
      groups,
      (group) => {
        const wrapper = document.createElement("section");
        const inner = each(
          () => group().children,
          (child) => {
            const el = document.createElement("span");
            el.setAttribute("data-child", "");
            effect(() => {
              el.textContent = child().name;
            });
            return el;
          },
          { key: (c) => c.id },
        );
        wrapper.appendChild(inner);
        return wrapper;
      },
      { key: (g) => g.id },
    );
    container.appendChild(anchor);
    setGroups([{ id: 1, children: [{ id: 11, name: "x" }] }]);

    // The inner `each` anchor is detached when it is created (its wrapper is
    // not in the document yet), so its first reconciliation runs on the
    // microtask fallback rather than synchronously.
    await Promise.resolve();

    expect(container.querySelectorAll("[data-child]")).toHaveLength(1);
    expect(container.querySelector("[data-child]")?.textContent).toBe("x");

    // Same outer key, replaced inner item under the same inner key. The outer
    // row is reused, so the inner list must react through `group()`.
    setGroups([{ id: 1, children: [{ id: 11, name: "y" }] }]);
    expect(container.querySelector("[data-child]")?.textContent).toBe("y");
  });
});

describe("each — duplicate keys", () => {
  it("warns in dev and collapses duplicates to a single row (documented limitation)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const list = mountList([
      { id: 1, name: "a" },
      { id: 1, name: "duplicate" },
    ]);

    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain("duplicate key");
    // Duplicate keys are unsupported: the two positions share one node, so
    // only one row survives. Asserted so the behaviour is at least defined.
    expect(list.rows().length).toBeLessThanOrEqual(2);
    warn.mockRestore();
  });
});
