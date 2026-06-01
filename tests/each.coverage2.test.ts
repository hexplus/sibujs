import { describe, expect, it, vi } from "vitest";
import { each } from "../src/core/rendering/each";
import { signal } from "../src/core/signals/signal";

/** Mount the anchor into a connected host and flush the microtask fallback. */
async function mount(anchor: Comment): Promise<HTMLElement> {
  const host = document.createElement("div");
  host.appendChild(anchor);
  document.body.appendChild(host);
  await Promise.resolve();
  await Promise.resolve();
  return host;
}

describe("each coverage2 — node resolution", () => {
  it("resolves a function-returning child recursively", async () => {
    const [items] = signal([{ id: 1 }, { id: 2 }]);
    const anchor = each(
      () => items(),
      (item) => () => {
        const el = document.createElement("span");
        el.textContent = String(item().id);
        return el;
      },
      { key: (i) => i.id },
    );
    const host = await mount(anchor);
    expect(host.querySelectorAll("span").length).toBe(2);
  });

  it("resolves a primitive child to a text node", async () => {
    const [items] = signal([{ id: 1, label: "x" }]);
    const anchor = each(
      () => items(),
      (item) => item().label,
      { key: (i) => i.id },
    );
    const host = await mount(anchor);
    expect(host.textContent).toContain("x");
  });
});

describe("each coverage2 — empty array", () => {
  it("renders then clears when array becomes empty", async () => {
    const [items, setItems] = signal([{ id: 1 }, { id: 2 }]);
    const anchor = each(
      () => items(),
      (item) => {
        const el = document.createElement("div");
        el.className = "row";
        el.textContent = String(item().id);
        return el;
      },
      { key: (i) => i.id },
    );
    const host = await mount(anchor);
    expect(host.querySelectorAll(".row").length).toBe(2);
    setItems([]);
    expect(host.querySelectorAll(".row").length).toBe(0);
  });
});

describe("each coverage2 — reordering & removal", () => {
  it("reorders keyed nodes without re-creating them", async () => {
    const [items, setItems] = signal([{ id: "a" }, { id: "b" }, { id: "c" }]);
    const created: string[] = [];
    const anchor = each(
      () => items(),
      (item) => {
        const el = document.createElement("li");
        created.push(item().id);
        el.dataset.id = item().id;
        return el;
      },
      { key: (i) => i.id },
    );
    const host = await mount(anchor);
    expect(created).toEqual(["a", "b", "c"]);
    setItems([{ id: "c" }, { id: "a" }, { id: "b" }]);
    expect(created).toEqual(["a", "b", "c"]); // reused, no new creations
    const order = Array.from(host.querySelectorAll("li")).map((el) => (el as HTMLElement).dataset.id);
    expect(order).toEqual(["c", "a", "b"]);
  });

  it("removes nodes whose keys disappear", async () => {
    const [items, setItems] = signal([{ id: 1 }, { id: 2 }, { id: 3 }]);
    const anchor = each(
      () => items(),
      (item) => {
        const el = document.createElement("p");
        el.textContent = String(item().id);
        return el;
      },
      { key: (i) => i.id },
    );
    const host = await mount(anchor);
    expect(host.querySelectorAll("p").length).toBe(3);
    setItems([{ id: 1 }, { id: 3 }]);
    expect(host.querySelectorAll("p").length).toBe(2);
  });
});

describe("each coverage2 — duplicate keys warning", () => {
  it("warns on duplicate keys in dev", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const [items] = signal([{ id: 1 }, { id: 1 }]);
    const anchor = each(
      () => items(),
      (item) => {
        const el = document.createElement("div");
        el.textContent = String(item().id);
        return el;
      },
      { key: (i) => i.id },
    );
    await mount(anchor);
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("duplicate key"))).toBe(true);
    warnSpy.mockRestore();
  });
});

describe("each coverage2 — render throws", () => {
  it("renders a placeholder comment and warns when render throws", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const [items] = signal([{ id: 1 }]);
    const anchor = each(
      () => items(),
      () => {
        throw new Error("render boom");
      },
      { key: (i) => i.id },
    );
    const host = await mount(anchor);
    expect(warnSpy).toHaveBeenCalled();
    const hasErrorComment = Array.from(host.childNodes).some(
      (n) => n.nodeType === 8 && String(n.textContent).includes("each:error"),
    );
    expect(hasErrorComment).toBe(true);
    warnSpy.mockRestore();
  });

  it("dispatches sibu:error-propagate on the parent element", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const [items] = signal([{ id: 1 }]);
    const anchor = each(
      () => items(),
      () => {
        throw new Error("render boom 2");
      },
      { key: (i) => i.id },
    );
    const host = document.createElement("div");
    const caught: unknown[] = [];
    host.addEventListener("sibu:error-propagate", (e) => {
      caught.push((e as CustomEvent).detail.error);
    });
    host.appendChild(anchor);
    document.body.appendChild(host);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(caught.length).toBeGreaterThan(0);
    warnSpy.mockRestore();
  });
});
