import { afterEach, describe, expect, it } from "vitest";
import { setRuntimeErrorHandler } from "../../src/core/errors";
import { match, when } from "../../src/core/rendering/directives";
import { dispose, registerDisposer } from "../../src/core/rendering/dispose";
import { each } from "../../src/core/rendering/each";
import { Fragment } from "../../src/core/rendering/fragment";
import { div, span } from "../../src/core/rendering/html";
import { KeepAlive } from "../../src/core/rendering/keepAlive";
import { onCleanup } from "../../src/core/rendering/lifecycle";
import { rangeEnd } from "../../src/core/rendering/range";
import { signal } from "../../src/core/signals/signal";

// KeepAlive caches a case's COMPLETE rendered range, not just its root node: a
// `when()` / `each()` root is a comment whose visible content follows it as
// siblings, and a fragment contributes all of its children.

const tick = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

afterEach(() => {
  document.body.replaceChildren();
  setRuntimeErrorHandler(null);
});

function mount(anchor: Comment): HTMLElement {
  const host = div();
  document.body.append(host);
  host.append(anchor);
  return host;
}

describe("KeepAlive caches complete ranges", () => {
  it("detaches the complete range of a directive root", async () => {
    const [key, setKey] = signal("a");
    const host = mount(
      KeepAlive(key, {
        a: () =>
          when(
            () => true,
            () => div("A"),
          ),
        b: () => div("B"),
      }),
    );
    await tick();
    expect(host.textContent).toBe("A");
    setKey("b");
    await tick();
    expect(host.textContent).toBe("B");
  });

  it("detaches the complete range of an each root", async () => {
    const [key, setKey] = signal("a");
    const host = mount(
      KeepAlive(key, {
        a: () =>
          each(
            () => [1, 2],
            (n) => div(() => String(n())),
            { key: (n) => n },
          ),
        b: () => div("B"),
      }),
    );
    await tick();
    expect(host.textContent).toBe("12");
    setKey("b");
    await tick();
    expect(host.textContent).toBe("B");
  });

  it("switches element, fragment, each and nested-directive roots repeatedly without orphans", async () => {
    const [key, setKey] = signal("el");
    const [rows] = signal([1, 2]);
    const anchor = KeepAlive(key, {
      el: () => div("E"),
      frag: () => Fragment([span("F1"), span("F2")]),
      list: () => each(rows, (n) => span(() => `L${n()}`), { key: (n) => n }),
      nested: () =>
        Fragment([
          when(
            () => true,
            () =>
              Fragment([
                span("N1"),
                when(
                  () => true,
                  () => span("N2"),
                ),
              ]),
          ),
        ]),
    });
    const host = mount(anchor);
    await tick();
    const expected: Record<string, string> = { el: "E", frag: "F1F2", list: "L1L2", nested: "N1N2" };
    for (let round = 0; round < 3; round++) {
      for (const k of ["el", "frag", "list", "nested"]) {
        setKey(k);
        await tick();
        expect(host.textContent).toBe(expected[k]);
        // Only the anchor and this case's range are present.
        expect(host.firstChild).toBe(anchor);
      }
    }
    dispose(anchor);
    expect(host.textContent).toBe("");
  });

  it("keeps node identity while cached and keeps the cached range live", async () => {
    const [key, setKey] = signal("a");
    const [rows, setRows] = signal([1]);
    const anchor = KeepAlive(key, {
      a: () => each(rows, (n) => span(() => String(n())), { key: (n) => n }),
      b: () => div("B"),
    });
    const host = mount(anchor);
    await tick();
    const first = host.querySelector("span");
    setKey("b");
    await tick();
    // Rows added while parked render next to their (parked) anchor.
    setRows([1, 2, 3]);
    await tick();
    expect(host.textContent).toBe("B");
    setKey("a");
    await tick();
    expect(host.textContent).toBe("123");
    expect(host.querySelector("span")).toBe(first);
    setKey("b");
    await tick();
    expect(host.textContent).toBe("B");
    dispose(anchor);
  });

  it("disposes every owned node of an evicted range, and a fragment's own cleanups, exactly once", async () => {
    const [key, setKey] = signal("a");
    const counts = { anchor: 0, row: 0, fragment: 0 };
    const anchor = KeepAlive(
      key,
      {
        a: () => {
          const list = each(
            () => [1, 2],
            (n) => {
              const row = span(() => String(n()));
              registerDisposer(row, () => counts.row++);
              return row;
            },
            { key: (n) => n },
          );
          registerDisposer(list, () => counts.anchor++);
          const frag = Fragment([list]);
          onCleanup(() => counts.fragment++, frag);
          return frag;
        },
        b: () => div("B"),
        c: () => div("C"),
      },
      { max: 1 },
    );
    const host = mount(anchor);
    await tick();
    expect(host.textContent).toBe("12");
    setKey("b"); // evicts "a"
    await tick();
    expect(host.textContent).toBe("B");
    expect(counts).toEqual({ anchor: 1, row: 2, fragment: 1 });
    setKey("c");
    await tick();
    dispose(anchor);
    expect(counts).toEqual({ anchor: 1, row: 2, fragment: 1 });
    expect(host.textContent).toBe("");
  });

  it("disposes a parked range when the anchor is disposed", async () => {
    const [key, setKey] = signal("a");
    let rows = 0;
    const anchor = KeepAlive(key, {
      a: () =>
        when(
          () => true,
          () => {
            const el = div("A");
            registerDisposer(el, () => rows++);
            return el;
          },
        ),
      b: () => div("B"),
    });
    const host = mount(anchor);
    await tick();
    setKey("b");
    await tick();
    dispose(anchor);
    expect(rows).toBe(1);
    expect(host.textContent).toBe("");
  });

  it("updates a parked root directive and returns only its latest branch", async () => {
    const [key, setKey] = signal("a");
    const [view, setView] = signal("one");
    const anchor = KeepAlive(key, {
      a: () => match(view, { one: () => Fragment([span("1"), span("2")]), two: () => span("3") }),
      b: () => span("B"),
    });
    const host = mount(anchor);
    await tick();
    setKey("b");
    setView("two");
    await tick();
    expect(host.textContent).toBe("B");
    setKey("a");
    expect(host.textContent).toBe("3");
    dispose(anchor);
  });

  it("lets a nested KeepAlive switch while the outer case is parked", async () => {
    const [key, setKey] = signal("a");
    const [inner, setInner] = signal("one");
    const anchor = KeepAlive(key, {
      a: () =>
        KeepAlive(inner, {
          one: () =>
            when(
              () => true,
              () => span("1"),
            ),
          two: () => Fragment([span("2"), span("3")]),
        }),
      b: () => span("B"),
    });
    const host = mount(anchor);
    await tick();
    setKey("b");
    setInner("two");
    await tick();
    expect(host.textContent).toBe("B");
    setKey("a");
    expect(host.textContent).toBe("23");
    expect(rangeEnd(anchor).textContent).toBe("3");
    dispose(anchor);
    expect(host.textContent).toBe("");
  });

  it("is removed with its complete active range by an enclosing when()", async () => {
    const [show, setShow] = signal(true);
    const [key, setKey] = signal("a");
    const root = when(show, () =>
      KeepAlive(key, {
        a: () =>
          each(
            () => [1, 2],
            (n) => span(() => String(n())),
            { key: (n) => n },
          ),
        b: () => span("B"),
      }),
    );
    const host = mount(root);
    await tick();
    expect(host.textContent).toBe("12");
    setKey("b");
    setShow(false);
    await tick();
    expect(host.textContent).toBe("");
    dispose(root);
  });

  it("adopts a directive root that rendered before it was handed over", async () => {
    const content = when(
      () => true,
      () => span("A"),
    );
    await tick();
    const [key, setKey] = signal("a");
    const anchor = KeepAlive(key, { a: () => content, b: () => span("B") });
    const host = mount(anchor);
    await tick();
    expect(host.textContent).toBe("A");
    setKey("b");
    expect(host.textContent).toBe("B");
    setKey("a");
    expect(host.textContent).toBe("A");
    dispose(anchor);
  });

  it("runs an empty fragment's own cleanup once on eviction", async () => {
    let cleanups = 0;
    const [key, setKey] = signal("a");
    const anchor = KeepAlive(
      key,
      {
        a: () => {
          const frag = Fragment([]);
          registerDisposer(frag, () => cleanups++);
          return frag;
        },
        b: () => span("B"),
      },
      { max: 1 },
    );
    const host = mount(anchor);
    await tick();
    setKey("b");
    expect(host.textContent).toBe("B");
    expect(cleanups).toBe(1);
    dispose(anchor);
    expect(cleanups).toBe(1);
  });

  it("switches away from a case whose nested range is playing its leave", async () => {
    let end!: () => void;
    const [key, setKey] = signal("a");
    const [on, setOn] = signal(true);
    const anchor = KeepAlive(key, {
      a: () =>
        when(
          on,
          () => span("A"),
          () => span("C"),
          { transition: { leave: () => new Promise<void>((r) => (end = r)), maxDuration: 1000 } },
        ),
      b: () => span("B"),
    });
    const host = mount(anchor);
    await tick();
    setOn(false);
    setKey("b");
    await tick();
    expect(host.textContent).toBe("B");
    end();
    await tick();
    setKey("a");
    expect(host.textContent).toBe("C");
    dispose(anchor);
  });

  it("never resurrects a reactive fragment child replaced while the case is shown", async () => {
    const [key, setKey] = signal("a");
    const [text, setText] = signal("A");
    let cleanups = 0;
    const built: Node[] = [];
    const anchor = KeepAlive(key, {
      a: () =>
        Fragment([
          () => {
            const el = span(text());
            registerDisposer(el, () => cleanups++);
            built.push(el);
            return el;
          },
        ]),
      b: () => span("X"),
    });
    const host = mount(anchor);
    await tick();
    expect(host.textContent).toBe("A");
    setText("B");
    expect(host.textContent).toBe("B");
    expect(cleanups).toBe(1);
    for (let round = 0; round < 3; round++) {
      setKey("b");
      expect(host.textContent).toBe("X");
      setKey("a");
      expect(host.textContent).toBe("B");
      expect(built[0].parentNode).toBeNull();
    }
    dispose(anchor);
    expect(cleanups).toBe(2);
  });

  it("never resurrects a reactive fragment child replaced while the case is parked", async () => {
    const [key, setKey] = signal("a");
    const [text, setText] = signal("A");
    const built: Node[] = [];
    const anchor = KeepAlive(key, {
      a: () =>
        Fragment([
          () => {
            const el = span(text());
            built.push(el);
            return el;
          },
        ]),
      b: () => span("X"),
    });
    const host = mount(anchor);
    await tick();
    setKey("b");
    setText("B");
    await tick();
    expect(host.textContent).toBe("X");
    for (let round = 0; round < 3; round++) {
      setKey("a");
      expect(host.textContent).toBe("B");
      expect(built[0].parentNode).toBeNull();
      setKey("b");
      expect(host.textContent).toBe("X");
    }
    dispose(anchor);
  });

  it("parks and re-shows a large fragment without hitting the engine's argument limit", async () => {
    const [key, setKey] = signal("b");
    const errors: unknown[] = [];
    setRuntimeErrorHandler((e) => {
      errors.push(e);
    });
    let first: Node | null = null;
    let last: Node | null = null;
    const anchor = KeepAlive(key, {
      a: () => {
        const frag = document.createDocumentFragment();
        for (let i = 0; i < 130_000; i++) frag.appendChild(document.createTextNode("x"));
        first = frag.firstChild;
        last = frag.lastChild;
        return frag;
      },
      b: () => span("B"),
    });
    const host = mount(anchor);
    await tick();
    setKey("a");
    expect(errors).toEqual([]);
    expect(host.textContent?.length).toBe(130_000);
    setKey("b");
    expect(host.textContent).toBe("B");
    setKey("a");
    expect(errors).toEqual([]);
    expect(anchor.nextSibling).toBe(first);
    expect(host.lastChild).toBe(last);
    dispose(anchor);
  }, 30_000);
});
