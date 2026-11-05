import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { match, when } from "../src/core/rendering/directives";
import { dispose, registerDisposer } from "../src/core/rendering/dispose";
import { each } from "../src/core/rendering/each";
import { Fragment } from "../src/core/rendering/fragment";
import { button, span } from "../src/core/rendering/html";
import { signal } from "../src/core/signals/signal";

// ---------------------------------------------------------------------------
// What a `when` / `match` branch OWNS, beyond the nodes it inserted.
//
// 1. An owned fragment is a lifetime of its own: cleanup registered on the
//    fragment object (`registerDisposer(fragment, …)`, `onCleanup(fn, fragment)`)
//    runs when the branch is released, after its nodes, exactly once — also
//    when the fragment rendered nothing, and only once a leave has finished.
//    A fragment the caller handed in keeps its cleanup.
// 2. A branch is a RANGE, not the list of nodes it was inserted with: an
//    `each()` (or a nested `when` / `match`) at its top level renders siblings
//    that appear, move and disappear after insertion. Every one of them is made
//    inert, animated, removed and re-attached with the branch.
// ---------------------------------------------------------------------------

let host: HTMLElement;

beforeAll(() => {
  const sheet = document.createElement("style");
  sheet.textContent = ".out { animation-name: fade; animation-duration: 0.3s; }";
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
});

const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const end = (el: Element | null | undefined) => el?.dispatchEvent(new Event("animationend"));

/** Host content with comments shown as `<!>`. */
function shape(): string {
  return Array.from(host.childNodes)
    .map((n) => (n.nodeType === 8 ? "<!>" : n.nodeType === 3 ? n.textContent : (n as Element).outerHTML))
    .join("|");
}

describe("an owned fragment's own cleanup", () => {
  /** A factory returning a fresh fragment with cleanup registered on the fragment itself. */
  function fragmentWithCleanup(log: string[], label: string, children = [span(label)]) {
    return () => {
      const fragment = Fragment(children.map((c) => c.cloneNode(true)));
      registerDisposer(fragment.firstChild ?? fragment, () => log.push(`child ${label}`));
      registerDisposer(fragment, () => log.push(`root ${label}`));
      return fragment;
    };
  }

  it("runs when the directive is disposed, after the fragment's nodes", async () => {
    const [visible] = signal(true);
    const cleanup = vi.fn();
    const anchor = when(visible, () => {
      const fragment = Fragment([span("A")]);
      registerDisposer(fragment, cleanup);
      return fragment;
    });
    host.appendChild(anchor);
    await flush();
    dispose(anchor);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(shape()).toBe("<!>");
  });

  it("runs on an ordinary switch, descendants first, exactly once", async () => {
    const [on, setOn] = signal(true);
    const log: string[] = [];
    const anchor = when(
      () => on(),
      fragmentWithCleanup(log, "A"),
      () => span("B"),
    );
    host.appendChild(anchor);
    await flush();
    setOn(false);
    expect(log).toEqual(["child A", "root A"]);
    dispose(anchor);
    expect(log).toEqual(["child A", "root A"]);
  });

  it("waits for the leave to finish", async () => {
    const [on, setOn] = signal(true);
    const log: string[] = [];
    host.appendChild(
      when(
        () => on(),
        fragmentWithCleanup(log, "A"),
        () => span("B"),
        { transition: { leaveClass: "out" } },
      ),
    );
    await flush();
    setOn(false);
    expect(log).toEqual([]);
    end(host.querySelector(".out"));
    expect(log).toEqual(["child A", "root A"]);
  });

  it("runs when the directive is disposed during an active leave", async () => {
    const [on, setOn] = signal(true);
    const log: string[] = [];
    const anchor = when(
      () => on(),
      fragmentWithCleanup(log, "A"),
      () => span("B"),
      {
        transition: { leaveClass: "out" },
      },
    );
    host.appendChild(anchor);
    await flush();
    setOn(false);
    expect(log).toEqual([]);
    dispose(anchor);
    expect(log).toEqual(["child A", "root A"]);
    expect(shape()).toBe("<!>");
  });

  it("is kept for a fragment that rendered nothing", async () => {
    const [on, setOn] = signal(true);
    const cleanup = vi.fn();
    const anchor = when(
      () => on(),
      () => {
        const fragment = Fragment([]);
        registerDisposer(fragment, cleanup);
        return fragment;
      },
      () => span("B"),
    );
    host.appendChild(anchor);
    await flush();
    expect(shape()).toBe("<!>");
    setOn(false);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(shape()).toBe("<!>|<span>B</span>");

    const [on2] = signal(true);
    const cleanup2 = vi.fn();
    const anchor2 = when(
      () => on2(),
      () => {
        const fragment = Fragment([]);
        registerDisposer(fragment, cleanup2);
        return fragment;
      },
    );
    host.appendChild(anchor2);
    await flush();
    dispose(anchor2);
    expect(cleanup2).toHaveBeenCalledTimes(1);
  });

  it("is left alone for a bare fragment the caller owns", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const [on, setOn] = signal(true);
    const cleanup = vi.fn();
    const fragment = Fragment([span("A")]);
    registerDisposer(fragment, cleanup);
    const anchor = when(
      () => on(),
      fragment,
      () => span("B"),
    );
    host.appendChild(anchor);
    await flush();
    setOn(false);
    setOn(true);
    setOn(false);
    dispose(anchor);
    expect(cleanup).not.toHaveBeenCalled();
    dispose(fragment);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});

describe("a branch is its whole range: each() rows", () => {
  it("makes rows rendered after insertion inert and animates them with the branch", async () => {
    const [visible, setVisible] = signal(true);
    const [items] = signal([1, 2]);
    host.appendChild(
      when(
        visible,
        () => Fragment([span("label"), each(items, (item) => button(String(item())), { key: (item) => item })]),
        { transition: { leaveClass: "out" } },
      ),
    );
    await flush();
    expect(host.querySelectorAll("button")).toHaveLength(2);

    setVisible(false);
    const label = host.querySelector("span") as HTMLElement;
    const buttons = Array.from(host.querySelectorAll("button"));
    expect(label.classList.contains("out")).toBe(true);
    expect(buttons).toHaveLength(2);
    for (const b of buttons) {
      expect(b.hasAttribute("inert")).toBe(true);
      expect(b.getAttribute("aria-hidden")).toBe("true");
      expect(b.classList.contains("out")).toBe(true);
    }

    // The branch ends only when every animated element has finished.
    end(label);
    end(buttons[0]);
    expect(buttons[1].isConnected).toBe(true);
    end(buttons[1]);
    expect(shape()).toBe("<!>");
  });

  it("animates a fragment whose only child is an each(), instead of removing it at once", async () => {
    const [visible, setVisible] = signal(true);
    const [items] = signal(["a", "b"]);
    host.appendChild(
      when(visible, () => Fragment([each(items, (item) => span(item()), { key: (item) => item })]), {
        transition: { leaveClass: "out" },
      }),
    );
    await flush();
    setVisible(false);
    const rows = Array.from(host.querySelectorAll("span"));
    expect(rows.map((r) => r.textContent)).toEqual(["a", "b"]);
    expect(rows.every((r) => r.classList.contains("out") && r.hasAttribute("inert"))).toBe(true);
    for (const r of rows) end(r);
    expect(shape()).toBe("<!>");
  });

  it("removes rows added after attaching a bare fragment when it is hidden", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const [visible, setVisible] = signal(true);
    const [items, setItems] = signal([1, 2]);
    const fragment = Fragment([each(items, (item) => span(String(item())), { key: (item) => item })]);
    host.appendChild(when(visible, fragment));
    await flush();
    expect(host.textContent).toBe("12");

    setItems([2, 3]);
    expect(host.textContent).toBe("23");

    setVisible(false);
    expect(host.textContent).toBe("");
    expect(shape()).toBe("<!>");
  });

  it("survives repeated hide/show of a bare fragment with rows added, removed and reordered", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const [visible, setVisible] = signal(true);
    const [items, setItems] = signal([1, 2]);
    const fragment = Fragment([
      span("head"),
      each(items, (item) => span(() => `r${item()}`), { key: (item) => item }),
      span("tail"),
    ]);
    host.appendChild(when(visible, fragment, () => span("off")));
    await flush();

    const sequence: number[][] = [[1, 2, 3], [3, 1], [4, 3, 1, 5], [5], []];
    for (const next of sequence) {
      setItems(next);
      const expected = `head${next.map((n) => `r${n}`).join("")}tail`;
      expect(host.textContent).toBe(expected);
      setVisible(false);
      expect(host.textContent).toBe("off");
      setVisible(true);
      expect(host.textContent).toBe(expected);
      expect(host.querySelectorAll("span")).toHaveLength(next.length + 2);
    }
  });

  it("disposes rows with an owned branch and leaves nothing behind after the leave or the disposal", async () => {
    const [visible, setVisible] = signal(true);
    const [items, setItems] = signal([1, 2]);
    const disposed: number[] = [];
    const anchor = when(
      visible,
      () =>
        Fragment([
          each(
            items,
            (item) => {
              const el = span(String(item()));
              registerDisposer(el, () => disposed.push(item.peek()));
              return el;
            },
            { key: (item) => item },
          ),
        ]),
      { transition: { leaveClass: "out" } },
    );
    host.appendChild(anchor);
    await flush();
    setItems([3, 1]);
    expect(disposed).toEqual([2]);
    setVisible(false);
    for (const r of Array.from(host.querySelectorAll("span"))) end(r);
    expect(shape()).toBe("<!>");
    expect(disposed.sort()).toEqual([1, 2, 3]);

    setVisible(true);
    await flush();
    expect(host.textContent).toBe("31");
    setVisible(false);
    dispose(anchor);
    expect(shape()).toBe("<!>");
  });
});

describe("a branch is its whole range: nested directives", () => {
  it("includes a nested when() rendered as a top-level fragment child", async () => {
    const [outer, setOuter] = signal(true);
    const [inner, setInner] = signal(false);
    host.appendChild(
      when(
        outer,
        () =>
          Fragment([
            span("x"),
            when(
              inner,
              () => Fragment([button("i1"), button("i2")]),
              () => button("none"),
            ),
          ]),
        () => span("off"),
        { transition: { leaveClass: "out" } },
      ),
    );
    await flush();
    setInner(true);
    expect(host.querySelectorAll("button")).toHaveLength(2);

    setOuter(false);
    const leaving = Array.from(host.querySelectorAll("button"));
    expect(leaving).toHaveLength(2);
    expect(leaving.every((b) => b.hasAttribute("inert") && b.classList.contains("out"))).toBe(true);
    for (const el of Array.from(host.querySelectorAll(".out"))) end(el);
    expect(shape()).toBe("<!>|<span>off</span>");
  });

  it("includes a match() at the top level of a bare fragment across hide/show", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const [visible, setVisible] = signal(true);
    const [mode, setMode] = signal<"a" | "b">("a");
    const fragment = Fragment([match(mode, { a: () => span("A"), b: () => Fragment([span("B1"), span("B2")]) })]);
    host.appendChild(when(visible, fragment));
    await flush();
    setMode("b");
    expect(host.textContent).toBe("B1B2");
    setVisible(false);
    expect(shape()).toBe("<!>");
    setVisible(true);
    expect(host.textContent).toBe("B1B2");
    setMode("a");
    expect(host.textContent).toBe("A");
    setVisible(false);
    expect(shape()).toBe("<!>");
  });

  it("an each() anchor returned as a single-node branch is released with its rows", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const [visible, setVisible] = signal(true);
    const [items, setItems] = signal([1]);
    const list = each(items, (item) => span(String(item())), { key: (item) => item });
    host.appendChild(when(visible, list, () => span("off")));
    await flush();
    setItems([1, 2]);
    setVisible(false);
    expect(host.textContent).toBe("off");
    setVisible(true);
    expect(host.textContent).toBe("12");
  });
});
