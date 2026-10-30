import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStubFetch } from "../fixtures/ssr-app/src/api";
import { head, routes } from "../fixtures/ssr-app/src/routes";
import { type AdoptScope, type AdoptSink, keyedScope } from "../src/core/rendering/adoptScope";
import { each } from "../src/core/rendering/each";
import { div, input, li, span, ul } from "../src/core/rendering/html";
import { signal } from "../src/core/signals/signal";
import type { AdoptResult } from "../src/platform/hydrateAdopt";
import { renderRoute } from "../src/platform/renderRoute";
import { hydrate } from "../src/platform/ssr";
import { renderToStringAsync } from "../src/platform/ssrAsync";
import { destroyRouter } from "../src/plugins/router";
import { __resetTransfer } from "../src/utils/transfer";

// An `each` row (and a route record) opens a creation scope identified by its
// key. The segment must encode the key without loss: `1` and `"1"` are two
// rows to the reconciler, so they must be two scopes to the hydration, and no
// two distinct keys may ever share one.

const sink: AdoptSink = { on: true, el: () => null };
const root: AdoptScope = { p: "", n: 0, s: sink };
const prefix = (key: unknown, parent: AdoptScope = root) => (keyedScope(parent, key) as AdoptScope).p;
const ATTRIBUTE_SAFE = /^[A-Za-z0-9_.~-]*$/;

/** Two distinct keys with the same 32-bit FNV-1a hash (the previous segment). */
const FNV_COLLISION = ["item-352798", "item-1023240"] as const;

describe("keyedScope", () => {
  it("keeps the number 1 and the string '1' apart", () => {
    expect(prefix(1)).not.toBe(prefix("1"));
    expect(prefix(1)).toBe("-1.");
    expect(prefix("1")).toBe("_1.");
  });

  it("separates keys that collided under the previous 32-bit hash", () => {
    const fnv = (text: string) => {
      let h = 0x811c9dc5;
      for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
      return h >>> 0;
    };
    expect(fnv(FNV_COLLISION[0])).toBe(fnv(FNV_COLLISION[1]));
    expect(prefix(FNV_COLLISION[0])).not.toBe(prefix(FNV_COLLISION[1]));
  });

  it("follows the reconciler's key equality for numbers: 0 is -0, NaN is NaN, everything else differs", () => {
    const map = new Map<unknown, string>([
      [0, "zero"],
      [Number.NaN, "nan"],
    ]);
    expect(map.get(-0)).toBe("zero");
    expect(map.get(Number.NaN)).toBe("nan");
    expect(prefix(-0)).toBe(prefix(0));
    expect(prefix(Number.NaN)).toBe(prefix(0 / 0));

    const keys: unknown[] = [0, 1, -1, 1.5, 0.1 + 0.2, 0.3, 1e21, 1e-7, Infinity, -Infinity, Number.NaN];
    keys.push(...keys.map((k) => String(k)), "+0", "-0", "1e21", "");
    const prefixes = keys.map((k) => prefix(k));
    expect(new Set(prefixes).size).toBe(keys.length);
    for (const p of prefixes) expect(p).toMatch(ATTRIBUTE_SAFE);
  });

  it("encodes punctuation, quotes, Unicode and separator-like text losslessly and attribute-safe", () => {
    const keys = [
      "a.b",
      "a~002eb",
      "a_b",
      "a-b",
      'quote"d',
      "single'q",
      "<tag>&amp;",
      "spa ce",
      "naïve",
      "日本語",
      "😀",
      "\ud83d", // a lone surrogate is still a valid string key
      "😀x",
      "~",
      ".",
      "..",
      "-1",
      "_1",
      "k1",
      "/products/:id",
    ];
    const prefixes = keys.map((k) => prefix(k));
    expect(new Set(prefixes).size).toBe(keys.length);
    for (const p of prefixes) {
      expect(p).toMatch(ATTRIBUTE_SAFE);
      // Exactly one "." — the one that ends the segment.
      expect(p.indexOf(".")).toBe(p.length - 1);
    }
  });

  it("never lets segments concatenate ambiguously across nesting", () => {
    const keys: unknown[] = ["a", "a.", "a.b", "b", 1, "1", "1.", 11, "_1", "-1", "1._1"];
    const seen = new Map<string, string>();
    for (const outer of keys) {
      for (const inner of keys) {
        const p = prefix(inner, keyedScope(root, outer) as AdoptScope);
        const label = `${typeof outer}:${String(outer)} / ${typeof inner}:${String(inner)}`;
        expect(seen.get(p) ?? label).toBe(label);
        seen.set(p, label);
      }
    }
    // A keyed segment never reads as a positional one (base 36, no "_" / "-" lead).
    for (const k of keys) expect(prefix(k)).toMatch(/^[_-]/);
  });

  it("scopes identical keys under different parents independently", () => {
    const listA: AdoptScope = { p: "0.", n: 0, s: sink };
    const listB: AdoptScope = { p: "1.", n: 0, s: sink };
    expect(prefix("x", listA)).toBe("0._x.");
    expect(prefix("x", listB)).toBe("1._x.");
  });

  it("rejects key types that have no lossless encoding, and does nothing outside a session", () => {
    for (const bad of [true, null, undefined, 1n, Symbol("k"), {}, [1]]) {
      expect(() => keyedScope(root, bad)).toThrow(TypeError);
    }
    expect(keyedScope(null, true)).toBeNull();
    expect(keyedScope({ p: "", n: 0, s: { on: false, el: () => null } }, {})).toBeNull();
  });

  it("gives route records (keyed by path) distinct, stable scopes", () => {
    const paths = ["/", "/products", "/products/:id", "/products/:id/", "*", "/:a.b"];
    const prefixes = paths.map((p) => prefix(p));
    expect(new Set(prefixes).size).toBe(paths.length);
    expect(prefix("/products/:id")).toBe(prefix("/products/:id"));
    expect(prefix("/")).toBe("_~002f.");
  });
});

// ─── Through a real server render and adopting hydration ──────────────────

let container: HTMLElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  __resetTransfer();
  delete (window as unknown as Record<string, unknown>).__SIBU_TRANSFER__;
  destroyRouter();
});

interface Row {
  key: string | number;
  label: string;
}

function List(rows: () => Row[]): HTMLElement {
  return ul({ class: "list" }, [
    each(
      rows,
      (row) => li({ class: "row" }, [span(() => row().label), input({ class: "field", value: row().label })]),
      { key: (r) => r.key },
    ),
  ]);
}

async function serve(app: () => Node): Promise<string> {
  const { html } = await renderToStringAsync(app, { hydration: "adopt" });
  container.innerHTML = html;
  return html;
}

const ids = (html: string) => Array.from(html.matchAll(/data-sibu-h="([^"]*)"/g), (m) => m[1]);

function expectClean(result: AdoptResult): void {
  expect(result.mismatches).toEqual([]);
  expect(result.created).toBe(0);
  expect(result.removed).toBe(0);
}

describe("adopting keyed rows", () => {
  it("adopts rows keyed 1 and '1' and keeps what was typed into the second", async () => {
    const rows: Row[] = [
      { key: 1, label: "number" },
      { key: "1", label: "string" },
    ];
    const html = await serve(() => List(() => rows));
    expect(new Set(ids(html)).size).toBe(ids(html).length);
    const serverLis = Array.from(container.querySelectorAll("li"));
    const serverInputs = Array.from(container.querySelectorAll("input")) as HTMLInputElement[];
    serverInputs[1].value = "typed before takeover";

    const [list, setList] = signal(rows);
    const result = await hydrate(() => List(list), container, { strategy: "adopt" });
    expectClean(result);
    expect(Array.from(container.querySelectorAll("li"))).toEqual(serverLis);
    expect(Array.from(container.querySelectorAll("input"))).toEqual(serverInputs);
    expect(serverInputs[1].value).toBe("typed before takeover");
    expect(serverInputs[0].value).toBe("number");

    // Normal keyed reconciliation afterwards: reordering moves the same nodes.
    setList([rows[1], rows[0]]);
    expect(Array.from(container.querySelectorAll("li"))).toEqual([serverLis[1], serverLis[0]]);
    expect((container.querySelector("input") as HTMLInputElement).value).toBe("typed before takeover");
    setList([rows[1], { key: 2, label: "two" }]);
    const after = Array.from(container.querySelectorAll("li"));
    expect(after[0]).toBe(serverLis[1]);
    expect(serverLis[0].isConnected).toBe(false);
    expect(after[1].textContent).toBe("two");
  });

  it("adopts rows whose string keys collided under the previous hash", async () => {
    const rows: Row[] = FNV_COLLISION.map((key) => ({ key, label: key }));
    const html = await serve(() => List(() => rows));
    expect(new Set(ids(html)).size).toBe(ids(html).length);
    const serverInputs = Array.from(container.querySelectorAll("input")) as HTMLInputElement[];
    serverInputs[1].value = "kept";

    const result = await hydrate(() => List(() => rows), container, { strategy: "adopt" });
    expectClean(result);
    expect(Array.from(container.querySelectorAll("input"))).toEqual(serverInputs);
    expect(serverInputs[1].value).toBe("kept");
  });

  it("adopts Unicode and punctuation keys, with attribute-safe ids", async () => {
    const rows: Row[] = ['quote"d', "a.b", "a~002eb", "日本語", "😀", "<x>&", "spa ce"].map((key, i) => ({
      key,
      label: `r${i}`,
    }));
    const html = await serve(() => List(() => rows));
    const all = ids(html);
    expect(new Set(all).size).toBe(all.length);
    for (const id of all) expect(id).toMatch(ATTRIBUTE_SAFE);
    const serverLis = Array.from(container.querySelectorAll("li"));

    const result = await hydrate(() => List(() => rows), container, { strategy: "adopt" });
    expectClean(result);
    expect(Array.from(container.querySelectorAll("li"))).toEqual(serverLis);
  });

  it("adopts numeric edge-case keys next to their string spellings; -0 on one side is 0 on the other", async () => {
    const numbers = [0, -1, 1.5, 1e21, Infinity, -Infinity, Number.NaN];
    const rows: Row[] = [
      ...numbers.map((key, i) => ({ key, label: `n${i}` })),
      ...numbers.map((key, i) => ({ key: String(key), label: `s${i}` })),
    ];
    const html = await serve(() => List(() => rows));
    expect(new Set(ids(html)).size).toBe(ids(html).length);
    const serverLis = Array.from(container.querySelectorAll("li"));

    // The browser computes the first key as -0: the same key, to the reconciler and to the scope.
    const client = rows.map((r, i) => (i === 0 ? { ...r, key: -0 } : r));
    const result = await hydrate(() => List(() => client), container, { strategy: "adopt" });
    expectClean(result);
    expect(Array.from(container.querySelectorAll("li"))).toEqual(serverLis);
  });

  it("scopes the same keys in two separate lists independently", async () => {
    const rows: Row[] = [
      { key: "a", label: "a" },
      { key: 1, label: "1" },
    ];
    const App = () => div([List(() => rows), List(() => rows)]);
    const html = await serve(App);
    expect(new Set(ids(html)).size).toBe(ids(html).length);
    const serverInputs = Array.from(container.querySelectorAll("input")) as HTMLInputElement[];
    serverInputs[3].value = "second list, second row";

    const result = await hydrate(App, container, { strategy: "adopt" });
    expectClean(result);
    expect(Array.from(container.querySelectorAll("input"))).toEqual(serverInputs);
    expect(serverInputs[3].value).toBe("second list, second row");
  });

  it("adopts nested keyed lists whose inner keys repeat across outer rows", async () => {
    interface Group {
      id: string | number;
      rows: Row[];
    }
    const groups: Group[] = [
      {
        id: 1,
        rows: [
          { key: 1, label: "1/1" },
          { key: "1", label: "1/'1'" },
        ],
      },
      {
        id: "1",
        rows: [
          { key: 1, label: "'1'/1" },
          { key: "1", label: "'1'/'1'" },
        ],
      },
    ];
    const App = () =>
      div([
        each(
          () => groups,
          (g) => div({ class: "group" }, [List(() => g().rows)]),
          { key: (g) => g.id },
        ),
      ]);
    const html = await serve(App);
    expect(new Set(ids(html)).size).toBe(ids(html).length);
    const serverInputs = Array.from(container.querySelectorAll("input")) as HTMLInputElement[];
    expect(serverInputs).toHaveLength(4);
    serverInputs[3].value = "deep";

    const result = await hydrate(App, container, { strategy: "adopt" });
    expectClean(result);
    expect(Array.from(container.querySelectorAll("input"))).toEqual(serverInputs);
    expect(serverInputs.map((i) => i.value)).toEqual(["1/1", "1/'1'", "'1'/1", "deep"]);
  });

  it("numbers route scopes by the encoded record path", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    vi.stubGlobal("fetch", createStubFetch());
    const server = await renderRoute(routes, "/", { router: { head }, hydration: "adopt" });
    const all = ids(server.html);
    expect(all.length).toBeGreaterThan(0);
    // The landing route's record ("/") opens the scope its elements are numbered in.
    expect(all.some((id) => id.includes("_~002f."))).toBe(true);
    for (const id of all) expect(id).toMatch(ATTRIBUTE_SAFE);
    expect(new Set(all).size).toBe(all.length);
  });
});
