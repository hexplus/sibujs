// Regression tests for round-8 fixes (bindChildNode order + disposal).
import { describe, expect, it } from "vitest";
import { registerDisposer } from "../src/core/rendering/dispose";
import { signal } from "../src/core/signals/signal";
import { bindChildNode } from "../src/reactivity/bindChildNode";

function span(text: string): HTMLElement {
  const el = document.createElement("span");
  el.textContent = text;
  return el;
}

describe("bindChildNode: preserves order across re-renders", () => {
  it("a no-op re-render of the same node order stays in order (not reversed)", async () => {
    const a = span("A");
    const b = span("B");
    const parent = document.createElement("div");
    const ph = document.createComment("");
    parent.appendChild(ph);

    const [items, setItems] = signal<Node[]>([a, b]);
    bindChildNode(ph, () => items());
    await Promise.resolve();
    expect(parent.textContent).toBe("AB");

    // Re-render with a fresh array of the SAME nodes in the SAME order.
    setItems([a, b]);
    await Promise.resolve();
    expect(parent.textContent).toBe("AB"); // previously scrambled to "BA"
  });

  it("reorders reused nodes correctly", async () => {
    const a = span("A");
    const b = span("B");
    const c = span("C");
    const parent = document.createElement("div");
    const ph = document.createComment("");
    parent.appendChild(ph);

    const [items, setItems] = signal<Node[]>([a, b, c]);
    bindChildNode(ph, () => items());
    await Promise.resolve();
    expect(parent.textContent).toBe("ABC");

    setItems([a, c, b]);
    await Promise.resolve();
    expect(parent.textContent).toBe("ACB");

    setItems([c, b, a]);
    await Promise.resolve();
    expect(parent.textContent).toBe("CBA");
  });
});

describe("bindChildNode: disposes removed nodes", () => {
  it("disposes a node when the getter swaps it for null", async () => {
    const parent = document.createElement("div");
    const ph = document.createComment("");
    parent.appendChild(ph);

    const heavy = span("X");
    let disposed = false;
    registerDisposer(heavy, () => {
      disposed = true;
    });

    const [show, setShow] = signal(true);
    bindChildNode(ph, () => (show() ? heavy : null));
    await Promise.resolve();
    expect(parent.textContent).toBe("X");

    setShow(false);
    await Promise.resolve();
    expect(disposed).toBe(true); // removed AND disposed (no leak)
    expect(parent.textContent).toBe("");
  });

  it("disposes a node dropped from an array", async () => {
    const parent = document.createElement("div");
    const ph = document.createComment("");
    parent.appendChild(ph);

    const a = span("A");
    const b = span("B");
    let bDisposed = false;
    registerDisposer(b, () => {
      bDisposed = true;
    });

    const [items, setItems] = signal<Node[]>([a, b]);
    bindChildNode(ph, () => items());
    await Promise.resolve();

    setItems([a]); // drop b
    await Promise.resolve();
    expect(bDisposed).toBe(true);
    expect(parent.textContent).toBe("A");
  });
});
