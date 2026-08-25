import { beforeEach, describe, expect, it, vi } from "vitest";
import { dispose } from "../src/core/rendering/dispose";
import { each } from "../src/core/rendering/each";
import { div, span } from "../src/core/rendering/html";
import { Suspense } from "../src/core/rendering/lazy";
import { onCleanup } from "../src/core/rendering/lifecycle";
import { signal } from "../src/core/signals/signal";
import { bindChildNode } from "../src/reactivity/bindChildNode";

const tick = () => new Promise<void>((r) => queueMicrotask(() => r()));

describe("hardening: each() logical range disposal", () => {
  let host: HTMLElement;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  it("removes every row and the end sentinel when the anchor is disposed", async () => {
    const [items] = signal([
      { id: 1, name: "A" },
      { id: 2, name: "B" },
      { id: 3, name: "C" },
    ]);

    const anchor = each(
      items,
      (item) => {
        const el = document.createElement("div");
        el.textContent = item().name;
        return el;
      },
      { key: (item) => item.id },
    );

    host.appendChild(anchor);
    await tick();
    expect(host.querySelectorAll("div")).toHaveLength(3);

    dispose(anchor);
    anchor.remove();

    expect(host.querySelectorAll("div")).toHaveLength(0);
    // The `each:end` sentinel must not survive the range teardown.
    const comments = Array.from(host.childNodes).filter((n) => n.nodeType === Node.COMMENT_NODE);
    expect(comments).toHaveLength(0);
    expect(host.childNodes).toHaveLength(0);
  });

  it("leaves no rows behind when a conditional branch swaps each() away", async () => {
    const [visible, setVisible] = signal(true);
    const [items] = signal([
      { id: 1, name: "A" },
      { id: 2, name: "B" },
      { id: 3, name: "C" },
    ]);

    const placeholder = document.createComment("branch");
    host.appendChild(placeholder);

    bindChildNode(placeholder, () =>
      visible()
        ? each(
            items,
            (item) => {
              const el = document.createElement("div");
              el.textContent = item().name;
              return el;
            },
            { key: (item) => item.id },
          )
        : (span("gone") as Node),
    );

    await tick();
    expect(host.querySelectorAll("div")).toHaveLength(3);

    setVisible(false);
    await tick();

    expect(host.querySelectorAll("div")).toHaveLength(0);
    expect(host.querySelector("span")?.textContent).toBe("gone");
  });

  it("runs row cleanup hooks exactly once when the range is disposed", async () => {
    const cleanups: string[] = [];
    const [items] = signal([{ id: 1 }, { id: 2 }]);

    const anchor = each(
      items,
      (item) => {
        const el = document.createElement("div");
        const id = item().id;
        onCleanup(() => cleanups.push(`row-${id}`), el);
        return el;
      },
      { key: (item) => item.id },
    );

    host.appendChild(anchor);
    await tick();
    expect(host.querySelectorAll("div")).toHaveLength(2);

    dispose(anchor);
    expect(cleanups.sort()).toEqual(["row-1", "row-2"]);

    // Idempotent: disposing again must not re-run cleanups.
    dispose(anchor);
    expect(cleanups).toHaveLength(2);
  });

  it("stops reacting to array changes after the range is disposed", async () => {
    const [items, setItems] = signal([{ id: 1 }]);
    let renders = 0;

    const anchor = each(
      items,
      (item) => {
        renders++;
        const el = document.createElement("div");
        el.dataset.id = String(item().id);
        return el;
      },
      { key: (item) => item.id },
    );

    host.appendChild(anchor);
    await tick();
    const initial = renders;
    expect(initial).toBe(1);

    dispose(anchor);
    anchor.remove();

    setItems([{ id: 1 }, { id: 2 }, { id: 3 }]);
    await tick();

    expect(renders).toBe(initial);
    expect(host.querySelectorAll("div")).toHaveLength(0);
  });

  it("tolerates a parent that already detached the rows", async () => {
    const [items] = signal([{ id: 1 }, { id: 2 }]);

    const anchor = each(items, () => document.createElement("div"), { key: (item) => item.id });

    host.appendChild(anchor);
    await tick();
    expect(host.querySelectorAll("div")).toHaveLength(2);
    // Simulate a hostile parent wiping the subtree natively first.
    host.replaceChildren();

    expect(() => dispose(anchor)).not.toThrow();
  });
});

describe("hardening: Suspense fallback disposal", () => {
  let host: HTMLElement;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  it("stops updating the fallback once content replaces it", async () => {
    const [progress, setProgress] = signal(0);

    const fallbackEl = div(() => `${progress()}%`) as HTMLElement;
    const container = Suspense({
      nodes: () => div({ id: "loaded" }, "done") as HTMLElement,
      fallback: () => fallbackEl,
    });
    host.appendChild(container);

    expect(fallbackEl.textContent).toBe("0%");

    await tick();
    await tick();
    expect(container.querySelector("#loaded")).not.toBeNull();
    expect(fallbackEl.parentNode).toBeNull();

    const before = fallbackEl.textContent;
    setProgress(10);
    await tick();

    // The detached fallback must not receive reactive DOM updates.
    expect(fallbackEl.textContent).toBe(before);
  });

  it("runs fallback cleanup exactly once after resolution", async () => {
    const cleanup = vi.fn();

    const container = Suspense({
      nodes: () => div({ id: "loaded" }, "done") as HTMLElement,
      fallback: () => {
        const el = div("loading") as HTMLElement;
        onCleanup(cleanup, el);
        return el;
      },
    });
    host.appendChild(container);

    await tick();
    await tick();

    expect(container.querySelector("#loaded")).not.toBeNull();
    expect(cleanup).toHaveBeenCalledTimes(1);

    // Disposing the boundary afterwards must not double-fire it.
    dispose(container);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("does not dispose the newly inserted content", async () => {
    const contentCleanup = vi.fn();

    const container = Suspense({
      nodes: () => {
        const el = div({ id: "loaded" }, "done") as HTMLElement;
        onCleanup(contentCleanup, el);
        return el;
      },
      fallback: () => div("loading") as HTMLElement,
    });
    host.appendChild(container);

    await tick();
    await tick();

    expect(container.querySelector("#loaded")).not.toBeNull();
    expect(contentCleanup).not.toHaveBeenCalled();
  });

  it("disposes the fallback when the boundary itself is torn down first", async () => {
    const cleanup = vi.fn();

    const container = Suspense({
      nodes: () => div("late") as HTMLElement,
      fallback: () => {
        const el = div("loading") as HTMLElement;
        onCleanup(cleanup, el);
        return el;
      },
    });
    host.appendChild(container);

    dispose(container);
    container.remove();
    await tick();
    await tick();

    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
