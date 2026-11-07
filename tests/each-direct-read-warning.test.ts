import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { each } from "../src/core/rendering/each";
import { img, li, span, ul } from "../src/core/rendering/html";
import { effect } from "../src/core/signals/effect";
import { signal } from "../src/core/signals/signal";

// ---------------------------------------------------------------------------
// `each()` runs `render` once per key, untracked. A value read DIRECTLY in the
// render body is therefore captured once, and goes stale when reconciliation
// later hands the same key a replacement item: `img({ src: p().url })` keeps
// the first url forever. Dev builds now say so, at the moment it happens, with
// the key and the render call site.
//
// THE INVARIANT: the warning fires only when a direct read actually went
// stale. A read inside a binding or an effect (tracked), an immutable list, and
// an explicit `peek()` never warn.
// ---------------------------------------------------------------------------

interface Product {
  name: string;
  url: string;
}

let warn: MockInstance;
let host: HTMLElement;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  host.remove();
  vi.restoreAllMocks();
});

function staleWarnings(): string[] {
  return warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("directly while rendering"));
}

/** Mount a keyed list and flush its first reconciliation. */
function mount<T>(
  initial: T[],
  render: Parameters<typeof each<T>>[1],
  key: (item: T) => string | number,
): (next: T[]) => void {
  const [items, setItems] = signal<T[]>(initial);
  host.appendChild(ul([each(items, render, { key })]));
  // The anchor is connected now; a same-value copy flushes the first pass.
  setItems([...initial]);
  return setItems;
}

// One render function per call site, so the once-per-site deduplication of one
// test does not swallow another test's warning.
const directSrc = (p: () => Product) => li([img({ src: p().url })]);
const boundSrc = (p: () => Product) => li([img({ src: () => p().url })]);

describe("each(): a direct item() read in render that goes stale", () => {
  it("warns once, naming the key and the render call site", () => {
    const set = mount<Product>([{ name: "cola", url: "/a.png" }], directSrc, (p) => p.name);
    expect(staleWarnings()).toEqual([]);

    set([{ name: "cola", url: "/b.png" }]);
    const messages = staleWarnings();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('the row for key "cola" read item() directly while rendering');
    expect(messages[0]).toContain("() => item().x");
    expect(messages[0]).toContain("item.peek()");
    expect(messages[0]).toMatch(/render at .*each-direct-read-warning\.test\.ts/);
    // The DOM really is stale, which is what the warning is about.
    expect(host.querySelector("img")?.getAttribute("src")).toBe("/a.png");

    // Further replacements, and other rows rendered by the same call site,
    // do not repeat it.
    set([
      { name: "cola", url: "/c.png" },
      { name: "lime", url: "/d.png" },
    ]);
    set([
      { name: "cola", url: "/e.png" },
      { name: "lime", url: "/f.png" },
    ]);
    expect(staleWarnings()).toHaveLength(1);
  });

  it("warns for a direct index() read when the row moves", () => {
    const set = mount<Product>(
      [
        { name: "a", url: "" },
        { name: "b", url: "" },
      ],
      (p, i) => li({ "data-pos": String(i()) }, () => p().name),
      (p) => p.name,
    );
    const [a, b] = [
      { name: "a", url: "" },
      { name: "b", url: "" },
    ];
    set([b, a]);
    const messages = staleWarnings();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("read index() directly while rendering");
  });
});

describe("each(): reads that do not go stale never warn", () => {
  it("a read inside a binding updates the DOM and does not warn", () => {
    const set = mount<Product>([{ name: "cola", url: "/a.png" }], boundSrc, (p) => p.name);
    set([{ name: "cola", url: "/b.png" }]);
    expect(host.querySelector("img")?.getAttribute("src")).toBe("/b.png");
    expect(staleWarnings()).toEqual([]);
  });

  it("a read inside an effect created by the row does not warn", () => {
    const seen: string[] = [];
    const set = mount<Product>(
      [{ name: "cola", url: "/a.png" }],
      (p) => {
        effect(() => {
          seen.push(p().url);
        });
        return li();
      },
      (p) => p.name,
    );
    set([{ name: "cola", url: "/b.png" }]);
    expect(seen).toEqual(["/a.png", "/b.png"]);
    expect(staleWarnings()).toEqual([]);
  });

  it("an immutable list with direct reads never warns, however it is re-set", () => {
    const a = { name: "a", url: "/a.png" };
    const b = { name: "b", url: "/b.png" };
    const set = mount<Product>(
      [a, b],
      (p) => li([img({ src: p().url })]),
      (p) => p.name,
    );
    set([a, b]);
    set([a, b, { name: "c", url: "/c.png" }]);
    set([a]);
    expect(staleWarnings()).toEqual([]);
  });

  it("peek() is an explicit one-time read and never warns", () => {
    const set = mount<Product>(
      [{ name: "cola", url: "/a.png" }],
      (p, i) => li({ "data-pos": String(i.peek()) }, [img({ src: p.peek().url })]),
      (p) => p.name,
    );
    set([
      { name: "lime", url: "" },
      { name: "cola", url: "/b.png" },
    ]);
    expect(staleWarnings()).toEqual([]);
  });

  it("peek() returns the current value without subscribing", () => {
    let item!: { (): Product; peek(): Product };
    const set = mount<Product>(
      [{ name: "cola", url: "/a.png" }],
      (p) => {
        item = p;
        return span();
      },
      (p) => p.name,
    );
    expect(item.peek().url).toBe("/a.png");
    set([{ name: "cola", url: "/b.png" }]);
    expect(item.peek().url).toBe("/b.png");
  });
});
