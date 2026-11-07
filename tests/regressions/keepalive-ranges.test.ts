import { afterEach, describe, expect, it } from "vitest";
import { when } from "../../src/core/rendering/directives";
import { dispose, registerDisposer } from "../../src/core/rendering/dispose";
import { each } from "../../src/core/rendering/each";
import { Fragment } from "../../src/core/rendering/fragment";
import { div, span } from "../../src/core/rendering/html";
import { KeepAlive } from "../../src/core/rendering/keepAlive";
import { onCleanup } from "../../src/core/rendering/lifecycle";
import { signal } from "../../src/core/signals/signal";

// KeepAlive caches a case's COMPLETE rendered range, not just its root node: a
// `when()` / `each()` root is a comment whose visible content follows it as
// siblings, and a fragment contributes all of its children.

const tick = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

afterEach(() => {
  document.body.replaceChildren();
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
});
