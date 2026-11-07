import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { match, when } from "../src/core/rendering/directives";
import { dispose, registerDisposer } from "../src/core/rendering/dispose";
import { each } from "../src/core/rendering/each";
import { Fragment } from "../src/core/rendering/fragment";
import { button, span } from "../src/core/rendering/html";
import { signal } from "../src/core/signals/signal";

// ---------------------------------------------------------------------------
// Deferred work around a branch's nested ranges.
//
// 1. A nested renderer's deferred first render (`each`, `when` / `match`)
//    must not run inside a branch that froze before it got to run: it would
//    read state the outgoing branch no longer owns.
// 2. Rows that join a leaving range late are enrolled in the running leave:
//    the branch waits for their animation too, within the original deadline.
// 3. A caller-owned range keeps reconciling while it is hidden, so it comes
//    back showing its latest state.
// 4. An enter waits for the nested ranges' first render, so rows rendered by a
//    top-level `each()` enter with the branch.
// ---------------------------------------------------------------------------

let host: HTMLElement;

beforeAll(() => {
  const sheet = document.createElement("style");
  sheet.textContent = [
    ".out { animation-name: fade; animation-duration: 0.3s; }",
    ".in { animation-name: rise; animation-duration: 0.2s; }",
  ].join("\n");
  document.head.appendChild(sheet);
});

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  vi.useRealTimers();
  dispose(host);
  host.remove();
  vi.restoreAllMocks();
  delete (Element.prototype as { getAnimations?: unknown }).getAnimations;
});

const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const end = (el: Element | null | undefined) => el?.dispatchEvent(new Event("animationend"));
const quiet = () => vi.spyOn(console, "warn").mockImplementation(() => {});

describe("1. deferred first renders respect a frozen branch", () => {
  it("a nested each() does not read state after its branch froze", async () => {
    const [selected, setSelected] = signal<{ items: number[] } | null>(null);
    let invalid = 0;
    host.appendChild(
      when(
        selected,
        () =>
          Fragment([
            span("heading"),
            each(
              () => {
                const s = selected();
                if (s === null) {
                  invalid++;
                  return [];
                }
                return s.items;
              },
              (item) => span(String(item.peek())),
              { key: (item) => item },
            ),
          ]),
        { transition: { leaveClass: "out" } },
      ),
    );
    await flush();
    // One task: build the branch (queuing the list's first render), then freeze it.
    setSelected({ items: [1] });
    setSelected(null);
    await flush();
    expect(invalid).toBe(0);
    expect(host.querySelector(".out")?.textContent).toBe("heading");
  });

  it("a nested when()'s deferred first render is held the same way", async () => {
    const [selected, setSelected] = signal<{ flag: boolean } | null>(null);
    let invalid = 0;
    host.appendChild(
      when(
        selected,
        () =>
          Fragment([
            span("heading"),
            when(
              () => {
                const s = selected();
                if (s === null) invalid++;
                return s?.flag ?? false;
              },
              () => span("inner"),
            ),
          ]),
        { transition: { leaveClass: "out" } },
      ),
    );
    await flush();
    setSelected({ flag: true });
    setSelected(null);
    await flush();
    expect(invalid).toBe(0);
    expect(host.textContent).toBe("heading");
  });

  it("a live branch's nested first renders still run", async () => {
    const [selected, setSelected] = signal<{ items: number[] } | null>(null);
    host.appendChild(
      when(
        selected,
        () =>
          Fragment([
            each(
              () => selected()?.items ?? [],
              (item) => span(String(item.peek())),
              { key: (item) => item },
            ),
            match(() => String(selected()?.items.length ?? 0), { "2": () => span("two") }),
          ]),
        { transition: { leaveClass: "out" } },
      ),
    );
    await flush();
    setSelected({ items: [1, 2] });
    await flush();
    expect(host.textContent).toBe("12two");
  });

  it("disposal before the first render stays terminal", async () => {
    const [items] = signal([1]);
    let renders = 0;
    const list = each(
      items,
      (item) => {
        renders++;
        return span(String(item.peek()));
      },
      { key: (item) => item },
    );
    host.appendChild(list);
    dispose(list);
    await flush();
    expect(renders).toBe(0);
    expect(host.textContent).toBe("");
  });

  it("a frozen branch still runs its owed cleanup exactly once when it is released", async () => {
    const [selected, setSelected] = signal<{ items: number[] } | null>(null);
    const cleanup = vi.fn();
    host.appendChild(
      when(
        selected,
        () => {
          const heading = span("heading");
          registerDisposer(heading, cleanup);
          return Fragment([
            heading,
            each(
              () => selected()?.items ?? [],
              (i) => span(String(i.peek())),
              { key: (i) => i },
            ),
          ]);
        },
        { transition: { leaveClass: "out" } },
      ),
    );
    await flush();
    setSelected({ items: [1] });
    setSelected(null);
    await flush();
    expect(cleanup).not.toHaveBeenCalled();
    end(host.querySelector(".out"));
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(host.textContent).toBe("");
  });
});

describe("2. rows that join a leaving range are enrolled in the leave", () => {
  /** Per-element fake animations whose `finished` the test settles. */
  function mockAnimations() {
    const settle = new Map<Element, () => void>();
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation((el: Element) =>
      el.classList.contains("out")
        ? ({
            display: "block",
            transitionProperty: "all",
            transitionDuration: "0s",
            transitionDelay: "0s",
            animationName: "fade",
            animationDuration: "0.3s",
            animationDelay: "0s",
            animationIterationCount: "1",
          } as CSSStyleDeclaration)
        : real(el),
    );
    const cache = new Map<Element, Animation[]>();
    (Element.prototype as { getAnimations?: () => Animation[] }).getAnimations = function (this: Element) {
      if (!this.classList.contains("out")) return [];
      let list = cache.get(this);
      if (!list) {
        let resolve!: () => void;
        const finished = new Promise<void>((r) => {
          resolve = r;
        });
        settle.set(this, resolve);
        list = [{ finished } as unknown as Animation];
        cache.set(this, list);
      }
      return list;
    };
    return settle;
  }

  async function mountLeavingWithLateRow(maxDuration?: number) {
    quiet();
    const settle = mockAnimations();
    const [visible, setVisible] = signal(true);
    const [items, setItems] = signal([1]);
    const fragment = Fragment([each(items, (item) => button(String(item.peek())), { key: (item) => item })]);
    host.appendChild(when(visible, fragment, { transition: { leaveClass: "out", maxDuration } }));
    await flush();
    vi.useFakeTimers();
    setVisible(false);
    await vi.advanceTimersByTimeAsync(100);
    setItems([1, 2]);
    await vi.advanceTimersByTimeAsync(0); // the range watch runs
    const [first, late] = Array.from(host.querySelectorAll("button"));
    return { settle, first, late, setItems };
  }

  it("waits for the late row's own animation", async () => {
    const { settle, first, late } = await mountLeavingWithLateRow();
    expect(late.classList.contains("out")).toBe(true);
    expect(late.hasAttribute("inert")).toBe(true);
    settle.get(first)?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(late.isConnected).toBe(true);
    settle.get(late)?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(first.isConnected).toBe(false);
    expect(late.isConnected).toBe(false);
  });

  it("the late row's computed timing extends the fallback, but never past the original cap", async () => {
    // Never settled: the fallback decides. Phase started at t=0 with a 300 ms
    // animation (deadline 350); the late row joins at t=100 with its own 300 ms
    // (would end at 450); maxDuration 400 caps it at t=400.
    const { first, late } = await mountLeavingWithLateRow(400);
    await vi.advanceTimersByTimeAsync(299); // t = 399
    expect(first.isConnected).toBe(true);
    await vi.advanceTimersByTimeAsync(1); // t = 400
    expect(late.isConnected).toBe(false);
  });

  it("without a cap, the late row's timing moves the fallback deadline", async () => {
    const { late } = await mountLeavingWithLateRow();
    await vi.advanceTimersByTimeAsync(300); // t = 400: past the original 350 ms deadline
    expect(late.isConnected).toBe(true);
    await vi.advanceTimersByTimeAsync(50); // t = 450: the late row's 100 + 300 + 50
    expect(late.isConnected).toBe(false);
  });

  it("repeated additions cannot push the end past the 5 s ceiling", async () => {
    const { late, setItems } = await mountLeavingWithLateRow();
    let next = 3;
    for (let t = 0; t < 6000; t += 250) {
      setItems((prev) => [...prev, next++]);
      await vi.advanceTimersByTimeAsync(250);
      if (!late.isConnected) break;
    }
    // Gone within the 5 s ceiling from the switch (100 ms before the first
    // addition, then 250 ms per addition): at most 20 additions.
    expect(late.isConnected).toBe(false);
    expect(next - 3).toBeLessThanOrEqual(20);
  });
});

describe("3. a hidden caller-owned range keeps reconciling", () => {
  function hiddenList(initial: { id: number; name: string }[]) {
    quiet();
    const [visible, setVisible] = signal(true);
    const [items, setItems] = signal(initial);
    const fragment = Fragment([each(items, (item) => span(() => item().name), { key: (item) => item.id })]);
    host.appendChild(when(visible, fragment, () => span("off")));
    return { setVisible, setItems };
  }

  const cases: [string, { id: number; name: string }[], { id: number; name: string }[]][] = [
    [
      "additions",
      [{ id: 1, name: "a" }],
      [
        { id: 1, name: "a" },
        { id: 2, name: "b" },
      ],
    ],
    [
      "removals",
      [
        { id: 1, name: "a" },
        { id: 2, name: "b" },
      ],
      [{ id: 2, name: "b" }],
    ],
    [
      "reordering",
      [
        { id: 1, name: "a" },
        { id: 2, name: "b" },
        { id: 3, name: "c" },
      ],
      [
        { id: 3, name: "c" },
        { id: 1, name: "a" },
        { id: 2, name: "b" },
      ],
    ],
    ["replacement under a stable key", [{ id: 1, name: "a" }], [{ id: 1, name: "A" }]],
    ["empty to nonempty", [], [{ id: 1, name: "a" }]],
    ["nonempty to empty", [{ id: 1, name: "a" }], []],
  ];

  for (const [label, before, after] of cases) {
    it(`shows ${label} made while hidden`, async () => {
      const { setVisible, setItems } = hiddenList(before);
      await flush();
      expect(host.textContent).toBe(before.map((i) => i.name).join(""));
      const firstRow = host.querySelector("span");
      setVisible(false);
      expect(host.textContent).toBe("off");
      setItems(after);
      setVisible(true);
      expect(host.textContent).toBe(after.map((i) => i.name).join(""));
      // Keyed identity survives: the row for a kept key is the same element.
      if (label === "replacement under a stable key") expect(host.querySelector("span")).toBe(firstRow);
      // And it keeps reacting afterwards.
      setItems([...after, { id: 99, name: "z" }]);
      expect(host.textContent).toBe(`${after.map((i) => i.name).join("")}z`);
    });
  }

  it("a caller-owned nested when()/match() switched while hidden comes back switched", async () => {
    quiet();
    const [visible, setVisible] = signal(true);
    const [mode, setMode] = signal<"a" | "b">("a");
    const [flag, setFlag] = signal(false);
    const fragment = Fragment([match(mode, { a: () => span("A"), b: () => span("B") }), when(flag, () => span("F"))]);
    host.appendChild(when(visible, fragment, () => span("off")));
    await flush();
    expect(host.textContent).toBe("A");
    setVisible(false);
    setMode("b");
    setFlag(true);
    setVisible(true);
    expect(host.textContent).toBe("BF");
  });
});

describe("4. an enter waits for the nested ranges' first render", () => {
  const listBranch = (items: () => number[]) => () =>
    Fragment([each(items, (item) => span(String(item.peek())), { key: (item) => item })]);

  it("appear: true animates rows from a top-level each()", async () => {
    const [visible] = signal(true);
    const [items] = signal([1, 2]);
    host.appendChild(when(visible, listBranch(items), { transition: { enterClass: "in", appear: true } }));
    await flush();
    expect(host.querySelectorAll("span.in")).toHaveLength(2);
    for (const el of Array.from(host.querySelectorAll("span.in"))) end(el);
    expect(host.querySelectorAll("span.in")).toHaveLength(0);
  });

  it("a later switch into such a branch applies its enter, with the custom enter seeing the rows", async () => {
    const [visible, setVisible] = signal(false);
    const [items] = signal([1]);
    const seen: string[][] = [];
    host.appendChild(
      when(visible, listBranch(items), () => span("off"), {
        transition: {
          enter: (nodes) => void seen.push(nodes.filter((n) => n.nodeType === 1).map((n) => n.textContent ?? "")),
        },
      }),
    );
    host.appendChild(when(visible, listBranch(items), () => span("off"), { transition: { enterClass: "in" } }));
    await flush();
    setVisible(true);
    await flush();
    expect(host.querySelectorAll("span.in")).toHaveLength(1);
    expect(seen).toEqual([["1"]]);
  });

  it("in-out starts the outgoing leave only after the incoming rows entered", async () => {
    const [visible, setVisible] = signal(false);
    const [items] = signal([1]);
    host.appendChild(
      when(visible, listBranch(items), () => span("off"), {
        transition: { enterClass: "in", leaveClass: "out", mode: "in-out" },
      }),
    );
    await flush();
    const off = host.querySelector("span") as HTMLElement;
    setVisible(true);
    await flush();
    const row = host.querySelector("span.in") as HTMLElement;
    expect(row?.textContent).toBe("1");
    expect(off.classList.contains("out")).toBe(false);
    end(row);
    expect(off.classList.contains("out")).toBe(true);
  });

  it("a switch or disposal before the deferred enter leaves no class and calls no callback", async () => {
    const enter = vi.fn();
    const [visible, setVisible] = signal(false);
    const [items] = signal([1]);
    const anchor = when(visible, listBranch(items), () => span("off"), {
      transition: { enter, enterClass: "in" },
    });
    host.appendChild(anchor);
    await flush();
    setVisible(true);
    setVisible(false); // before the list branch's deferred enter got to run
    await flush();
    // The "off" branch entered (synchronously); the list branch never did.
    const entered = enter.mock.calls.map(([nodes]) => (nodes as Node[]).map((n) => n.textContent).join(""));
    expect(entered).toEqual(["off"]);
    expect(host.querySelector(".in")).toBeNull();

    const [v2, setV2] = signal(false);
    const anchor2 = when(v2, listBranch(items), { transition: { enterClass: "in" } });
    host.appendChild(anchor2);
    await flush();
    setV2(true);
    dispose(anchor2);
    await flush();
    expect(host.querySelector(".in")).toBeNull();
    dispose(anchor);
  });

  it("an element branch still enters synchronously", async () => {
    const [visible, setVisible] = signal(false);
    host.appendChild(when(visible, () => span("A"), { transition: { enterClass: "in" } }));
    await flush();
    setVisible(true);
    expect(host.querySelector("span")?.classList.contains("in")).toBe(true);
  });
});
