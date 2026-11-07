import { afterEach, describe, expect, it } from "vitest";
import { setRuntimeErrorHandler } from "../../src/core/errors";
import { dispose, registerDisposer } from "../../src/core/rendering/dispose";
import { each } from "../../src/core/rendering/each";
import { Fragment } from "../../src/core/rendering/fragment";
import { div, span } from "../../src/core/rendering/html";
import { KeepAlive } from "../../src/core/rendering/keepAlive";
import { Portal } from "../../src/core/rendering/portal";
import { signal } from "../../src/core/signals/signal";

// Disposal from application code that runs during a commit (a factory, a
// custom element's connected/disconnected callback, an evicted case's
// cleanup) is final: nothing is inserted or kept subscribed after it, and
// what the interrupted commit built is released exactly once.

const tick = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

afterEach(() => {
  document.body.replaceChildren();
  setRuntimeErrorHandler(null);
});

interface Stats {
  runs: number;
  cleanups: number;
}

/** A reactive element with a cleanup, counting both. */
function tracked(label: string, value: () => number, stats: Stats): HTMLElement {
  const el = div(() => {
    stats.runs++;
    return `${label}${value()}`;
  });
  registerDisposer(el, () => stats.cleanups++);
  return el;
}

let tagId = 0;
/** Define a custom element that runs `on` when connected (or disconnected). */
function reactiveTag(kind: "connectedCallback" | "disconnectedCallback", on: () => void): string {
  const tag = `f5-${kind === "connectedCallback" ? "conn" : "disc"}-${++tagId}`;
  customElements.define(
    tag,
    class extends HTMLElement {
      [kind]() {
        on();
      }
    },
  );
  return tag;
}

describe("Portal disposed during its commit", () => {
  it("does not append content after its factory disposed the anchor", async () => {
    const [value, setValue] = signal(0);
    const stats = { runs: 0, cleanups: 0 };
    const target = div();
    document.body.append(target);
    let anchor: Comment | undefined;
    anchor = Portal(() => {
      dispose(anchor as Comment);
      return tracked("orphan", value, stats);
    }, target);
    document.body.append(anchor);
    await tick();
    expect(target.textContent).toBe("");
    expect(stats.cleanups).toBe(1);
    const before = stats.runs;
    setValue(1);
    expect(stats.runs).toBe(before);
    dispose(anchor);
    expect(stats.cleanups).toBe(1);
  });

  it("releases content whose connectedCallback disposed the anchor, once", async () => {
    const [value, setValue] = signal(0);
    const stats = { runs: 0, cleanups: 0 };
    const target = div();
    document.body.append(target);
    let anchor: Comment | undefined;
    const tag = reactiveTag("connectedCallback", () => dispose(anchor as Comment));
    anchor = Portal(() => {
      const el = document.createElement(tag);
      el.append(tracked("x", value, stats));
      return el;
    }, target);
    document.body.append(anchor);
    await tick();
    expect(target.textContent).toBe("");
    expect(stats.cleanups).toBe(1);
    const before = stats.runs;
    setValue(1);
    expect(stats.runs).toBe(before);
  });

  it("rolls back a factory that disposed the anchor and then threw", async () => {
    setRuntimeErrorHandler(() => {});
    const [value, setValue] = signal(0);
    const stats = { runs: 0, cleanups: 0 };
    const target = div();
    document.body.append(target);
    let anchor: Comment | undefined;
    anchor = Portal(() => {
      dispose(anchor as Comment);
      tracked("x", value, stats);
      throw new Error("after dispose");
    }, target);
    document.body.append(anchor);
    await tick();
    expect(target.textContent).toBe("");
    expect(stats.cleanups).toBe(1);
    const before = stats.runs;
    setValue(1);
    expect(stats.runs).toBe(before);
  });
});

describe("KeepAlive disposed during a switch", () => {
  it("does not commit a case after its factory disposed the anchor", async () => {
    const [key, setKey] = signal("a");
    const [value, setValue] = signal(0);
    const a = { runs: 0, cleanups: 0 };
    const b = { runs: 0, cleanups: 0 };
    const host = div();
    document.body.append(host);
    let anchor: Comment | undefined;
    anchor = KeepAlive(key, {
      a: () => tracked("a", value, a),
      b: () => {
        dispose(anchor as Comment);
        return tracked("orphan b", value, b);
      },
    });
    host.append(anchor);
    await tick();
    expect(host.textContent).toBe("a0");
    setKey("b");
    await tick();
    expect(host.textContent).toBe("");
    expect(a.cleanups).toBe(1);
    expect(b.cleanups).toBe(1);
    const before = a.runs + b.runs;
    setValue(1);
    expect(a.runs + b.runs).toBe(before);
    dispose(anchor);
    expect(a.cleanups + b.cleanups).toBe(2);
  });

  it("does not build the next case after parking disposed the anchor", async () => {
    const [key, setKey] = signal("a");
    let built = 0;
    const host = div();
    document.body.append(host);
    let anchor: Comment | undefined;
    const tag = reactiveTag("disconnectedCallback", () => dispose(anchor as Comment));
    anchor = KeepAlive(key, {
      a: () => document.createElement(tag),
      b: () => {
        built++;
        return div("b");
      },
    });
    host.append(anchor);
    await tick();
    setKey("b");
    await tick();
    expect(built).toBe(0);
    expect(host.textContent).toBe("");
  });

  it("does not insert the new case after an evicted case's cleanup disposed the anchor", async () => {
    const [key, setKey] = signal("a");
    const [value, setValue] = signal(0);
    const b = { runs: 0, cleanups: 0 };
    const host = div();
    document.body.append(host);
    let anchor: Comment | undefined;
    anchor = KeepAlive(
      key,
      {
        a: () => {
          const el = div("a");
          registerDisposer(el, () => dispose(anchor as Comment));
          return el;
        },
        b: () => tracked("b", value, b),
      },
      { max: 1 },
    );
    host.append(anchor);
    await tick();
    setKey("b");
    await tick();
    expect(host.textContent).toBe("");
    expect(b.cleanups).toBe(1);
    const before = b.runs;
    setValue(1);
    expect(b.runs).toBe(before);
  });

  it("stops after the inserted case's connectedCallback disposed the anchor", async () => {
    const [key, setKey] = signal("a");
    const [rows, setRows] = signal([1, 2]);
    let rowBuilds = 0;
    const host = div();
    document.body.append(host);
    let anchor: Comment | undefined;
    const tag = reactiveTag("connectedCallback", () => dispose(anchor as Comment));
    anchor = KeepAlive(key, {
      a: () => div("a"),
      b: () =>
        Fragment([
          document.createElement(tag),
          each(
            rows,
            (n) => {
              rowBuilds++;
              return span(() => String(n()));
            },
            { key: (n) => n },
          ),
        ]),
    });
    host.append(anchor);
    await tick();
    setKey("b");
    await tick();
    // The case's nested first render never starts in a disposed case.
    expect(rowBuilds).toBe(0);
    expect(host.textContent).toBe("");
    setRows([1, 2, 3]);
    await tick();
    expect(rowBuilds).toBe(0);
  });

  it("shows only the newest case when a factory switches the key", async () => {
    const [key, setKey] = signal("a");
    const host = div();
    document.body.append(host);
    const anchor = KeepAlive(key, {
      a: () => div("a"),
      b: () => {
        setKey("c");
        return div("b");
      },
      c: () => div("c"),
    });
    host.append(anchor);
    await tick();
    setKey("b");
    await tick();
    expect(host.textContent).toBe("c");
    setKey("b");
    await tick();
    expect(host.textContent).toBe("b");
    dispose(anchor);
  });
});
