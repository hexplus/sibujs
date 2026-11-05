import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { match, when } from "../src/core/rendering/directives";
import { dispose, registerDisposer } from "../src/core/rendering/dispose";
import { each } from "../src/core/rendering/each";
import { Fragment } from "../src/core/rendering/fragment";
import { div, span } from "../src/core/rendering/html";
import { signal } from "../src/core/signals/signal";
import { createRouter, destroyRouter, lazy, Route, Suspense } from "../src/plugins/router";

// ---------------------------------------------------------------------------
// Work that was already under way when a branch froze.
//
// 1. An async render suspended at an `await` (a `Suspense` boundary's content,
//    a lazy route) resumes after its enclosing branch has frozen for its
//    leave: it must not commit into that branch, nor run a component factory
//    that may read state the branch no longer owns. The outgoing snapshot
//    (its fallback or page) stays as it is until the branch is released.
// 2. A nested directive's pending enter must not start once an ancestor froze.
// 3. An anchor whose range already rendered elsewhere (an `each()` built in
//    another parent) moves with its whole range on its first attachment.
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
  dispose(host);
  host.remove();
  destroyRouter();
  vi.restoreAllMocks();
});

const flush = async (turns = 4) => {
  for (let i = 0; i < turns; i++) await new Promise<void>((r) => setTimeout(r, 0));
};
const end = (el: Element | null | undefined) => el?.dispatchEvent(new Event("animationend"));
const quiet = () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("1a. Suspense inside a leaving branch", () => {
  function mountSuspense() {
    const [visible, setVisible] = signal(true);
    const content = deferred<HTMLElement>();
    const fallbackCleanup = vi.fn();
    const anchor = when(
      visible,
      () =>
        div([
          Suspense({
            nodes: () => content.promise,
            fallback: () => {
              const fallback = span("loading");
              registerDisposer(fallback, fallbackCleanup);
              return fallback;
            },
          }),
        ]),
      { transition: { leaveClass: "out" } },
    );
    host.appendChild(anchor);
    return { anchor, setVisible, content, fallbackCleanup };
  }

  it("keeps the fallback, holds the late content while paused, and disposes it once at release", async () => {
    const { setVisible, content, fallbackCleanup } = mountSuspense();
    await flush();
    expect(host.textContent).toBe("loading");
    setVisible(false);
    expect(host.querySelector("div.out[inert]")).not.toBeNull();

    const loaded = span("loaded");
    const loadedCleanup = vi.fn();
    registerDisposer(loaded, loadedCleanup);
    content.resolve(loaded);
    await flush();
    expect({ text: host.textContent, cleanups: fallbackCleanup.mock.calls.length }).toEqual({
      text: "loading",
      cleanups: 0,
    });
    // Held for adoption (the branch could still be taken back), not disposed.
    expect(loadedCleanup).not.toHaveBeenCalled();

    // The branch ends: the fallback and the held content are released, once each.
    end(host.querySelector("div.out"));
    expect(host.textContent).toBe("");
    expect(fallbackCleanup).toHaveBeenCalledTimes(1);
    expect(loadedCleanup).toHaveBeenCalledTimes(1);
  });

  it("a rejection settling during the leave shows no error content and keeps the fallback", async () => {
    quiet();
    const { setVisible, content, fallbackCleanup } = mountSuspense();
    await flush();
    setVisible(false);
    content.reject(new Error("boom"));
    await flush();
    expect(host.textContent).toBe("loading");
    expect(host.querySelector(".suspense-error")).toBeNull();
    expect(fallbackCleanup).not.toHaveBeenCalled();
    end(host.querySelector("div.out"));
    expect(fallbackCleanup).toHaveBeenCalledTimes(1);
  });

  it("disposal before the resolution arrives: the late content is disposed once", async () => {
    const { anchor, content, fallbackCleanup } = mountSuspense();
    await flush();
    dispose(anchor);
    expect(fallbackCleanup).toHaveBeenCalledTimes(1);
    const loaded = span("loaded");
    const loadedCleanup = vi.fn();
    registerDisposer(loaded, loadedCleanup);
    content.resolve(loaded);
    await flush();
    expect(host.textContent).toBe("");
    expect(loadedCleanup).toHaveBeenCalledTimes(1);
    expect(fallbackCleanup).toHaveBeenCalledTimes(1);
  });

  it("completes normally while its owner is live", async () => {
    const { content, fallbackCleanup } = mountSuspense();
    await flush();
    content.resolve(span("loaded"));
    await flush();
    expect(host.textContent).toBe("loaded");
    expect(fallbackCleanup).toHaveBeenCalledTimes(1);
  });
});

describe("1b. a lazy route inside a leaving branch", () => {
  it("does not run the loaded component factory after the branch froze", async () => {
    const pending = deferred<{ default: () => HTMLElement }>();
    window.history.replaceState({}, "", "/");
    createRouter([{ path: "/", component: lazy(() => pending.promise) }], { mode: "history" });
    const [visible, setVisible] = signal(true);
    host.appendChild(when(visible, () => div([Route()]), { transition: { leaveClass: "out" } }));
    await flush();

    setVisible(false);
    expect(host.querySelector("div.out[inert]")).not.toBeNull();
    const factory = vi.fn(() => span("page"));
    pending.resolve({ default: factory });
    await flush(6);
    expect(factory).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("page");
    end(host.querySelector("div.out"));
    expect(host.textContent).toBe("");
  });

  it("runs it once while the owner is live", async () => {
    const pending = deferred<{ default: () => HTMLElement }>();
    window.history.replaceState({}, "", "/");
    createRouter([{ path: "/", component: lazy(() => pending.promise) }], { mode: "history" });
    const [visible] = signal(true);
    host.appendChild(when(visible, () => div([Route()]), { transition: { leaveClass: "out" } }));
    await flush();
    const factory = vi.fn(() => span("page"));
    pending.resolve({ default: factory });
    await flush(6);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain("page");
  });
});

describe("2. a nested pending enter after an ancestor froze", () => {
  function mountNested(transition: Record<string, unknown>) {
    const [selected, setSelected] = signal<{ name: string } | null>(null);
    const [items] = signal([1]);
    const anchor = when(
      selected,
      () =>
        div([
          when(
            () => true,
            () =>
              Fragment([span("heading"), each(items, (item) => span(String(item.peek())), { key: (item) => item })]),
            { transition: { appear: true, ...transition } },
          ),
        ]),
      { transition: { leaveClass: "out" } },
    );
    host.appendChild(anchor);
    return { anchor, selected, setSelected };
  }

  it("does not run a custom enter", async () => {
    const entered: string[] = [];
    const { selected, setSelected } = mountNested({
      enter: () => {
        entered.push(selected()?.name ?? "invalid");
      },
    });
    await flush();
    setSelected({ name: "Ada" });
    queueMicrotask(() => setSelected(null));
    await flush();
    expect(host.querySelector("div.out[inert]")).not.toBeNull();
    expect(entered).toEqual([]);
  });

  it("does not apply an enter class", async () => {
    const { setSelected } = mountNested({ enterClass: "in" });
    await flush();
    setSelected({ name: "Ada" });
    queueMicrotask(() => setSelected(null));
    await flush();
    expect(host.querySelector(".in")).toBeNull();
    end(host.querySelector("div.out"));
    expect(host.textContent).toBe("");
  });

  it("a live nested enter still runs exactly once", async () => {
    const enter = vi.fn();
    const { setSelected } = mountNested({ enter });
    await flush();
    setSelected({ name: "Ada" });
    await flush();
    expect(enter).toHaveBeenCalledTimes(1);
  });

  it("disposal during the wait is terminal, and repeated switches leave no stale class", async () => {
    const enter = vi.fn();
    const { anchor, setSelected } = mountNested({ enter, enterClass: "in" });
    await flush();
    for (let i = 0; i < 3; i++) {
      setSelected({ name: `n${i}` });
      setSelected(null);
    }
    await flush();
    for (const el of Array.from(host.querySelectorAll(".out"))) end(el);
    expect(host.querySelector(".in")).toBeNull();
    expect(enter).not.toHaveBeenCalled();
    setSelected({ name: "x" });
    dispose(anchor);
    await flush();
    expect(enter).not.toHaveBeenCalled();
    expect(host.textContent).toBe("");
  });
});

describe("3. first attachment of an already-rendered anchor", () => {
  it("moves an each() with its rows out of the donor", async () => {
    quiet();
    const donor = document.createDocumentFragment();
    const [items] = signal([1, 2]);
    const list = each(items, (item) => span(String(item.peek())), { key: (item) => item });
    donor.appendChild(list);
    await flush();
    expect(donor.textContent).toBe("12");

    const [visible] = signal(true);
    host.appendChild(when(visible, list));
    await flush();
    expect(host.textContent).toBe("12");
    expect(donor.childNodes).toHaveLength(0);
  });

  it("leaves unrelated donor siblings behind, and keeps working afterwards", async () => {
    quiet();
    const donor = document.createElement("section");
    const [items, setItems] = signal([1, 2]);
    const list = each(items, (item) => span(String(item.peek())), { key: (item) => item });
    donor.append(span("before"), list, span("after"));
    await flush();
    expect(donor.textContent).toBe("before12after");

    const [visible, setVisible] = signal(true);
    host.appendChild(when(visible, list, () => span("off")));
    await flush();
    expect(host.textContent).toBe("12");
    expect(donor.textContent).toBe("beforeafter");

    setItems([3, 1]);
    expect(host.textContent).toBe("31");
    setVisible(false);
    expect(host.textContent).toBe("off");
    setVisible(true);
    expect(host.textContent).toBe("31");

    dispose(list);
    expect(host.textContent).toBe("");
  });

  it("moves an already-rendered conditional with its branch", async () => {
    quiet();
    const donor = document.createElement("section");
    const [mode] = signal("b");
    const inner = match(mode, { a: () => span("A"), b: () => Fragment([span("B1"), span("B2")]) });
    donor.appendChild(inner);
    await flush();
    expect(donor.textContent).toBe("B1B2");
    const [visible] = signal(true);
    host.appendChild(when(visible, inner));
    await flush();
    expect(host.textContent).toBe("B1B2");
    expect(donor.textContent).toBe("");
  });

  it("an owned already-rendered list is disposed with its branch, and leaves with transitions", async () => {
    const donor = document.createElement("section");
    const [items] = signal([1]);
    const disposed = vi.fn();
    const list = each(
      items,
      (item) => {
        const el = span(String(item.peek()));
        registerDisposer(el, disposed);
        return el;
      },
      { key: (item) => item },
    );
    donor.appendChild(list);
    await flush();
    const [visible, setVisible] = signal(true);
    host.appendChild(when(visible, () => list, { transition: { leaveClass: "out" } }));
    await flush();
    expect(host.textContent).toBe("1");
    setVisible(false);
    const row = host.querySelector("span.out[inert]");
    expect(row).not.toBeNull();
    end(row);
    expect(host.textContent).toBe("");
    expect(disposed).toHaveBeenCalledTimes(1);
  });

  it("an uninitialized anchor still renders into the destination", async () => {
    const [items] = signal([1, 2]);
    const list = each(items, (item) => span(String(item.peek())), { key: (item) => item });
    const [visible] = signal(true);
    host.appendChild(when(visible, () => list));
    await flush();
    expect(host.textContent).toBe("12");
  });
});
