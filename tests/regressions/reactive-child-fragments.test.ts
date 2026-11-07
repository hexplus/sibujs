import { afterEach, describe, expect, it } from "vitest";
import { when } from "../../src/core/rendering/directives";
import { dispose, registerDisposer } from "../../src/core/rendering/dispose";
import { each } from "../../src/core/rendering/each";
import { Fragment } from "../../src/core/rendering/fragment";
import { div, span } from "../../src/core/rendering/html";
import { signal } from "../../src/core/signals/signal";

// A reactive child that renders a fragment owns the fragment's CHILDREN, not
// the (emptied-on-insertion) fragment object, plus whatever ranges those
// children render after insertion (`each()` rows, nested directive branches,
// fragment function children). Replacing it removes and disposes all of it,
// exactly once.

const tick = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

afterEach(() => {
  document.body.replaceChildren();
});

function mount(host: HTMLElement): HTMLElement {
  document.body.append(host);
  return host;
}

/** A div whose text binding counts its runs, with a cleanup counter. */
function counted(label: string, source: () => unknown, stats: { runs: number; cleanups: number }) {
  const el = div(() => {
    stats.runs++;
    source();
    return label;
  });
  registerDisposer(el, () => stats.cleanups++);
  return el;
}

describe("reactive child replacing a fragment", () => {
  it("fragment → element leaves only the element", async () => {
    const [show, setShow] = signal(true);
    const host = mount(div(() => (show() ? Fragment([div("A"), div("B")]) : div("C"))));
    await tick();
    expect(host.textContent).toBe("AB");
    setShow(false);
    await tick();
    expect(host.textContent).toBe("C");
    setShow(true);
    await tick();
    expect(host.textContent).toBe("AB");
    dispose(host);
  });

  it("fragment → null removes every child", async () => {
    const [show, setShow] = signal(true);
    const host = mount(div(() => (show() ? Fragment([span("A"), span("B")]) : null)));
    expect(host.textContent).toBe("AB");
    setShow(false);
    expect(host.textContent).toBe("");
    // Only the placeholder remains.
    expect(host.childNodes.length).toBe(1);
  });

  it("an array containing fragments is replaced completely", () => {
    const [step, setStep] = signal(0);
    const host = mount(
      div(() => (step() === 0 ? [Fragment([span("A"), span("B")]), span("C"), Fragment([span("D")])] : [span("E")])),
    );
    expect(host.textContent).toBe("ABCD");
    setStep(1);
    expect(host.textContent).toBe("E");
    setStep(0);
    expect(host.textContent).toBe("ABCD");
  });

  it("disposes the old fragment children exactly once, and stops their bindings", () => {
    const [value, setValue] = signal(0);
    const [show, setShow] = signal(true);
    const a = { runs: 0, cleanups: 0 };
    const b = { runs: 0, cleanups: 0 };
    const host = mount(div(() => (show() ? Fragment([counted("A", value, a), counted("B", value, b)]) : div("C"))));
    expect(a.runs).toBe(1);
    setShow(false);
    expect(host.textContent).toBe("C");
    expect(a.cleanups).toBe(1);
    expect(b.cleanups).toBe(1);
    // Bindings of the replaced children end with the replacement, not with
    // some later ancestor disposal.
    setValue(1);
    expect(a.runs).toBe(1);
    expect(b.runs).toBe(1);
    dispose(host);
    expect(a.cleanups).toBe(1);
    expect(b.cleanups).toBe(1);
  });

  it("runs cleanup registered on the fragment itself once, after its children", () => {
    const [show, setShow] = signal(true);
    const order: string[] = [];
    const host = mount(
      div(() => {
        if (!show()) return null;
        const child = span("A");
        registerDisposer(child, () => order.push("child"));
        const frag = Fragment([child]);
        registerDisposer(frag, () => order.push("fragment"));
        return frag;
      }),
    );
    setShow(false);
    expect(order).toEqual(["child", "fragment"]);
    dispose(host);
    expect(order).toEqual(["child", "fragment"]);
  });

  it("releases the fragment's own cleanup once when the host is disposed", () => {
    const order: string[] = [];
    const host = mount(
      div(() => {
        const child = span("A");
        registerDisposer(child, () => order.push("child"));
        const frag = Fragment([child]);
        registerDisposer(frag, () => order.push("fragment"));
        return frag;
      }),
    );
    dispose(host);
    expect(order).toEqual(["child", "fragment"]);
    dispose(host);
    expect(order).toEqual(["child", "fragment"]);
  });

  it("releases the fragment's own cleanup when a Fragment function child is torn down", () => {
    let cleanups = 0;
    const host = mount(
      div([
        Fragment([
          () => {
            const frag = Fragment([span("A")]);
            registerDisposer(frag, () => cleanups++);
            return frag;
          },
        ]),
      ]),
    );
    expect(host.textContent).toBe("A");
    dispose(host);
    expect(cleanups).toBe(1);
  });

  it("removes the rows a fragment's each() rendered and added after insertion", async () => {
    const [rows, setRows] = signal([1, 2]);
    const [show, setShow] = signal(true);
    const stats = { runs: 0, cleanups: 0 };
    const host = mount(
      div(() =>
        show()
          ? Fragment([
              span("head"),
              each(
                rows,
                (n) => {
                  const el = span(() => `r${n()}`);
                  registerDisposer(el, () => stats.cleanups++);
                  return el;
                },
                { key: (n) => n },
              ),
            ])
          : div("C"),
      ),
    );
    await tick();
    expect(host.textContent).toBe("headr1r2");
    setRows([1, 2, 3]);
    await tick();
    expect(host.textContent).toBe("headr1r2r3");
    setShow(false);
    await tick();
    expect(host.textContent).toBe("C");
    expect(stats.cleanups).toBe(3);
    setRows([1, 2, 3, 4]);
    await tick();
    expect(host.textContent).toBe("C");
  });

  it("removes what a fragment's nested directive and function child render after insertion", async () => {
    const [inner, setInner] = signal(false);
    const [label, setLabel] = signal("x");
    const [show, setShow] = signal(true);
    const host = mount(
      div(() =>
        show()
          ? Fragment([
              when(
                inner,
                () => span("W"),
                () => span("w"),
              ),
              () => span(label()),
            ])
          : div("C"),
      ),
    );
    await tick();
    expect(host.textContent).toBe("wx");
    setInner(true);
    setLabel("y");
    await tick();
    expect(host.textContent).toBe("Wy");
    setShow(false);
    await tick();
    expect(host.textContent).toBe("C");
  });

  it("removes a bare each() anchor's rows when replaced", async () => {
    const [show, setShow] = signal(true);
    const host = mount(
      div(() =>
        show()
          ? each(
              () => [1, 2],
              (n) => span(() => String(n())),
              { key: (n) => n },
            )
          : div("C"),
      ),
    );
    await tick();
    expect(host.textContent).toBe("12");
    setShow(false);
    await tick();
    expect(host.textContent).toBe("C");
  });

  it("keeps the children of the same fragment returned again", () => {
    const [tick2, setTick] = signal(0);
    const stats = { runs: 0, cleanups: 0 };
    let cleanups = 0;
    const frag = Fragment([span("A"), counted("B", () => undefined, stats)]);
    registerDisposer(frag, () => cleanups++);
    const host = mount(
      div(() => {
        tick2();
        return frag;
      }),
    );
    const before = Array.from(host.childNodes);
    setTick(1);
    expect(host.textContent).toBe("AB");
    expect(Array.from(host.childNodes)).toEqual(before);
    expect(stats.cleanups).toBe(0);
    expect(cleanups).toBe(0);
  });

  it("keeps a reused element in order next to fragment children", () => {
    const shared = span("S");
    const [step, setStep] = signal(0);
    const host = mount(div(() => (step() === 0 ? [shared, Fragment([span("A")])] : [Fragment([span("B")]), shared])));
    expect(host.textContent).toBe("SA");
    setStep(1);
    expect(host.textContent).toBe("BS");
    expect(shared.isConnected).toBe(true);
    setStep(0);
    expect(host.textContent).toBe("SA");
  });

  it("a fragment function child that renders a fragment is released as a when branch", async () => {
    const [on, setOn] = signal(true);
    const [which, setWhich] = signal(0);
    const host = mount(
      div([
        when(on, () =>
          Fragment([() => (which() === 0 ? Fragment([span("x"), span("y")]) : Fragment([span("p"), span("q")]))]),
        ),
      ]),
    );
    await tick();
    expect(host.textContent).toBe("xy");
    setWhich(1);
    await tick();
    expect(host.textContent).toBe("pq");
    setOn(false);
    await tick();
    expect(host.textContent).toBe("");
  });
});
