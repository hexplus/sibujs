import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { match, when } from "../src/core/rendering/directives";
import { dispose, registerDisposer } from "../src/core/rendering/dispose";
import { Fragment } from "../src/core/rendering/fragment";
import { div } from "../src/core/rendering/html";
import { signal } from "../src/core/signals/signal";

let host: HTMLElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  dispose(host);
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const flush = async (turns = 8) => {
  for (let i = 0; i < turns; i++) await Promise.resolve();
};

describe("1. reclaim reads the live range", () => {
  it.each([true, false])("when, microtasks between=%s", async (between) => {
    const [outer, setOuter] = signal(true);
    const [inner, setInner] = signal(true);
    const nested = when(inner, () => div("inner"));
    host.append(when(outer, nested, { transition: { leave: () => new Promise<void>(() => {}) } }));
    await flush();
    expect(host.textContent).toBe("inner");
    setOuter(false);
    if (between) await flush();
    setInner(false);
    if (between) await flush();
    setOuter(true);
    await flush();
    expect(host.textContent).toBe("");
  });
  it.each([true, false])("match, microtasks between=%s", async (between) => {
    const [outer, setOuter] = signal("a");
    const [inner, setInner] = signal("x");
    const nested = match(inner, { x: () => div("inner") });
    host.append(
      match(outer, { a: nested, b: () => div("b") }, { transition: { leave: () => new Promise<void>(() => {}) } }),
    );
    await flush();
    expect(host.textContent).toBe("inner");
    setOuter("b");
    if (between) await flush();
    setInner("y");
    if (between) await flush();
    setOuter("a");
    await flush();
    expect(host.textContent).not.toContain("inner");
  });
});

describe("2. disposal is terminal", () => {
  it("leave disposing the anchor", async () => {
    let anchor!: Comment;
    const [visible, setVisible] = signal(true);
    const replacement = vi.fn(() => div("replacement"));
    anchor = when(visible, () => div("initial"), replacement, {
      transition: {
        leave: () => {
          dispose(anchor);
          return new Promise<void>(() => {});
        },
      },
    });
    host.append(anchor);
    await flush();
    setVisible(false);
    await flush();
    expect(replacement).not.toHaveBeenCalled();
    expect(host.textContent).toBe("");
  });
  it("out-in sync leave disposing the anchor", async () => {
    let anchor!: Comment;
    const [visible, setVisible] = signal(true);
    const replacement = vi.fn(() => div("replacement"));
    anchor = when(visible, () => div("initial"), replacement, {
      transition: {
        mode: "out-in",
        leave: () => {
          dispose(anchor);
        },
      },
    });
    host.append(anchor);
    await flush();
    setVisible(false);
    await flush();
    expect(replacement).not.toHaveBeenCalled();
    expect(host.textContent).toBe("");
  });
  it("appear enter disposing the anchor leaves no timer", async () => {
    vi.useFakeTimers();
    let anchor!: Comment;
    anchor = when(
      () => true,
      () => div("x"),
      {
        transition: {
          appear: true,
          enter: () => {
            dispose(anchor);
            return new Promise<void>(() => {});
          },
        },
      },
    );
    const before = vi.getTimerCount();
    host.append(anchor);
    await flush();
    expect(host.textContent).toBe("");
    expect(vi.getTimerCount()).toBe(before);
  });
});

describe("3. incoming ownership before insertion", () => {
  it("connectedCallback disposing the anchor reaches the trailing node", async () => {
    let anchor!: Comment;
    const tag = `x-dispose-${Math.random().toString(36).slice(2)}`;
    customElements.define(
      tag,
      class extends HTMLElement {
        connectedCallback() {
          dispose(anchor);
        }
      },
    );
    const [n, setN] = signal(0);
    const headCleanup = vi.fn();
    const tailCleanup = vi.fn();
    const [on, setOn] = signal(false);
    anchor = when(on, () => {
      const head = document.createElement(tag);
      registerDisposer(head, headCleanup);
      const tail = div(() => `tail-${n()}`);
      registerDisposer(tail, tailCleanup);
      return Fragment([head, tail]);
    });
    host.append(anchor);
    await flush();
    setOn(true);
    await flush();
    expect(headCleanup).toHaveBeenCalledTimes(1);
    expect(tailCleanup).toHaveBeenCalledTimes(1);
    expect(host.children.length).toBe(0);
    setN(1);
    await flush();
    expect(host.textContent).not.toContain("tail-1");
  });
});
