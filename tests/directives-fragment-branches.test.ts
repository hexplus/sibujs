import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { match, when } from "../src/core/rendering/directives";
import { dispose, registerDisposer } from "../src/core/rendering/dispose";
import { each } from "../src/core/rendering/each";
import { Fragment } from "../src/core/rendering/fragment";
import { button, div, li, span, ul } from "../src/core/rendering/html";
import { signal } from "../src/core/signals/signal";

// ---------------------------------------------------------------------------
// A `when` / `match` branch may be SEVERAL sibling nodes: a `Fragment([...])`
// or a raw `DocumentFragment`.
//
// A DocumentFragment empties itself when inserted, so a directive that only
// kept a reference to the fragment had nothing to remove on the next switch:
// the old branch's nodes stayed on the page next to the new ones, with their
// bindings live. The directive now records the fragment's child nodes before
// inserting it and releases exactly those.
// ---------------------------------------------------------------------------

let host: HTMLElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  dispose(host);
  host.remove();
});

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/** Host content as text, with comments shown as `<!>` so orphans are visible. */
function shape(el: Node = host): string {
  return Array.from(el.childNodes)
    .map((n) => (n.nodeType === 8 ? "<!>" : n.nodeType === 3 ? n.textContent : (n as Element).outerHTML))
    .join("|");
}

describe("when(): fragment branches", () => {
  it("toggles a Fragment([a, b]) branch without leaving nodes behind", async () => {
    const [on, setOn] = signal(true);
    host.appendChild(
      when(
        () => on(),
        () => Fragment([button("Yes"), button("No")]),
        () => span("off"),
      ),
    );
    await flush();
    expect(shape()).toBe("<!>|<button>Yes</button>|<button>No</button>");

    for (let i = 0; i < 4; i++) {
      setOn(false);
      expect(shape()).toBe("<!>|<span>off</span>");
      setOn(true);
      expect(shape()).toBe("<!>|<button>Yes</button>|<button>No</button>");
    }
  });

  it("stops and removes a reactive function child when its branch goes away", async () => {
    const [on, setOn] = signal(true);
    const [label, setLabel] = signal("one");
    let runs = 0;
    host.appendChild(
      when(
        () => on(),
        () =>
          Fragment([
            span("a"),
            () => {
              runs++;
              return label() === "two" ? [span("x"), span("y")] : span(label());
            },
          ]),
      ),
    );
    await flush();
    expect(host.textContent).toBe("aone");

    // The reactive child re-renders AFTER insertion, into the live DOM, so the
    // nodes it now holds were never part of the fragment.
    setLabel("two");
    expect(host.textContent).toBe("axy");

    const before = runs;
    setOn(false);
    expect(shape()).toBe("<!>");
    setLabel("three");
    expect(runs).toBe(before);

    setOn(true);
    expect(host.textContent).toBe("athree");
  });

  it("toggles a raw DocumentFragment returned by a factory", async () => {
    const [on, setOn] = signal(true);
    const disposed: string[] = [];
    host.appendChild(
      when(
        () => on(),
        () => {
          const frag = document.createDocumentFragment();
          const a = span("a");
          const b = span("b");
          registerDisposer(a, () => disposed.push("a"));
          registerDisposer(b, () => disposed.push("b"));
          frag.append(a, b);
          return frag;
        },
      ),
    );
    await flush();
    expect(host.textContent).toBe("ab");

    setOn(false);
    expect(shape()).toBe("<!>");
    expect(disposed.sort()).toEqual(["a", "b"]);

    setOn(true);
    setOn(false);
    setOn(true);
    expect(host.textContent).toBe("ab");
    expect(host.querySelectorAll("span")).toHaveLength(2);
  });

  it("re-attaches a bare DocumentFragment branch's nodes, without disposing them", async () => {
    const [on, setOn] = signal(true);
    const [count, setCount] = signal(1);
    const frag = Fragment([span("a"), span(() => String(count()))]);
    host.appendChild(
      when(
        () => on(),
        frag,
        () => span("off"),
      ),
    );
    await flush();
    expect(host.textContent).toBe("a1");

    setOn(false);
    expect(host.textContent).toBe("off");
    setOn(true);
    expect(host.textContent).toBe("a1");
    expect(host.querySelectorAll("span")).toHaveLength(2);
    // Not owned by the directive, so its bindings were left alive.
    setCount(2);
    expect(host.textContent).toBe("a2");
  });

  it("renders an each() inside a fragment branch and disposes it with the branch", async () => {
    const [on, setOn] = signal(true);
    const [items, setItems] = signal([1, 2]);
    host.appendChild(
      when(
        () => on(),
        () => Fragment([span("list:"), each(items, (n) => li(() => String(n())), { key: (n) => n })]),
      ),
    );
    await flush();
    expect(host.textContent).toBe("list:12");

    setItems([1, 2, 3]);
    expect(host.textContent).toBe("list:123");

    setOn(false);
    expect(shape()).toBe("<!>");
    setItems([4]);
    expect(shape()).toBe("<!>");

    setOn(true);
    await flush();
    expect(host.textContent).toBe("list:4");
  });

  it("removes every fragment node when the directive itself is disposed", async () => {
    const [on] = signal(true);
    const wrap = div([
      when(
        () => on(),
        () => Fragment([span("a"), span("b")]),
      ),
    ]);
    host.appendChild(wrap);
    await flush();
    expect(wrap.textContent).toBe("ab");
    dispose(wrap.firstChild as Node);
    expect(shape(wrap)).toBe("<!>");
  });
});

describe("match(): fragment cases", () => {
  it("switches between fragment cases without duplicates or orphans", async () => {
    const [key, setKey] = signal<"a" | "b" | "c">("a");
    host.appendChild(
      ul([
        match(() => key(), {
          a: () => Fragment([li("a1"), li("a2")]),
          b: () => Fragment([li("b1"), () => li(`b:${key()}`), li("b3")]),
          c: () => li("c"),
        }),
      ]),
    );
    await flush();
    const list = host.firstChild as HTMLElement;
    expect(list.textContent).toBe("a1a2");

    for (const k of ["b", "c", "a", "b", "a", "c"] as const) {
      setKey(k);
      expect(list.querySelectorAll("li").length).toBe(k === "a" ? 2 : k === "b" ? 3 : 1);
    }
    setKey("b");
    expect(list.textContent).toBe("b1b:bb3");
    setKey("a");
    expect(list.textContent).toBe("a1a2");
    expect(shape(list)).toBe("<!>|<li>a1</li>|<li>a2</li>");
  });

  it("accepts a raw DocumentFragment case", async () => {
    const [key, setKey] = signal("x");
    host.appendChild(
      match(() => key(), {
        x: () => {
          const frag = document.createDocumentFragment();
          frag.append(span("1"), span("2"), span("3"));
          return frag;
        },
        y: () => span("y"),
      }),
    );
    await flush();
    expect(host.textContent).toBe("123");
    setKey("y");
    expect(shape()).toBe("<!>|<span>y</span>");
    setKey("x");
    expect(shape()).toBe("<!>|<span>1</span>|<span>2</span>|<span>3</span>");
  });
});
