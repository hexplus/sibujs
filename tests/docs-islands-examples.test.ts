import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { when } from "../src/core/rendering/directives";
import { each } from "../src/core/rendering/each";
import { div, li, ol, p } from "../src/core/rendering/html";
import { mount } from "../src/core/rendering/mount";
import { external, signal } from "../src/core/signals/signal";
import { enhance } from "../src/platform/enhance";
import { mountIslands, registerIsland, unregisterIsland } from "../src/platform/islands";

// ---------------------------------------------------------------------------
// The islands documentation, executed.
//
// Two kinds of check:
//
//   1. The load-bearing snippets from docs/islands.md are run here, close to
//      verbatim. A snippet that stops working fails a test instead of quietly
//      teaching the wrong thing.
//   2. Every `ctx.*` helper and every `sibujs` import the docs name is checked
//      against the real surface, so a renamed export cannot leave the guide
//      pointing at something that no longer exists.
// ---------------------------------------------------------------------------

const DOCS = resolve(__dirname, "..", "docs");
const read = (file: string) => readFileSync(resolve(DOCS, file), "utf8");

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

afterEach(() => {
  for (const name of ["counter", "chess"]) unregisterIsland(name);
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("docs/islands.md — the snippets run", () => {
  it("the counter from `enhance(target, setup)`", () => {
    document.body.innerHTML = `
      <div data-counter>
        <output data-ref="n">0</output>
        <button data-ref="inc">+1</button>
      </div>`;

    const [n, setN] = signal(0);
    enhance("[data-counter]", (ctx) => {
      ctx.text("@n", () => n());
      ctx.on("@inc", "click", () => setN((v) => v + 1));
    });

    (document.querySelector('[data-ref="inc"]') as HTMLButtonElement).click();
    expect(document.querySelector('[data-ref="n"]')?.textContent).toBe("1");
  });

  it("the zero-build island registration", async () => {
    document.body.innerHTML = `
      <div data-sibu-island="counter">
        <output data-ref="n">0</output>
        <button data-ref="inc">+1</button>
      </div>`;

    registerIsland("counter", (ctx) => {
      const [n, setN] = signal(0);
      ctx.text("@n", () => n());
      ctx.on("@inc", "click", () => setN((v) => v + 1));
    });
    const stop = mountIslands(document);
    await flush();

    (document.querySelector('[data-ref="inc"]') as HTMLButtonElement).click();
    expect(document.querySelector('[data-ref="n"]')?.textContent).toBe("1");
    stop();
  });

  it("the `external()` engine snippet", () => {
    // Stands in for the documented Chess instance: an object SibuJS cannot see
    // written, with the same shape of read used in the doc.
    const game = { turn: () => turn, isCheckmate: () => false };
    let turn = "w";

    document.body.innerHTML = `<div id="w"><b data-ref="status">…</b></div>`;
    const moved = external();

    enhance("#w", (ctx) => {
      ctx.text("@status", () => {
        moved.track();
        return game.isCheckmate() ? "Checkmate" : `${game.turn()} to move`;
      });
    });

    expect(document.querySelector('[data-ref="status"]')?.textContent).toBe("w to move");
    turn = "b";
    moved.invalidate();
    expect(document.querySelector('[data-ref="status"]')?.textContent).toBe("b to move");
  });

  it("the `ctx.each` descriptor, with the documented field set", () => {
    document.body.innerHTML = `
      <div id="w">
        <button data-ref="square" data-square="a1"></button>
        <button data-ref="square" data-square="a2"></button>
      </div>`;

    const [selected, setSelected] = signal<string | null>(null);
    const clicks: string[] = [];

    enhance("#w", (ctx) => {
      ctx.each<HTMLButtonElement>("@square", (el) => {
        const square = el.dataset.square as string;
        return {
          text: () => (selected() === square ? "x" : ""),
          class: { selected: () => selected() === square },
          attr: { "aria-selected": () => selected() === square },
          show: () => true,
          on: { click: () => clicks.push(square) },
          cleanup: () => clicks.push(`bye:${square}`),
        };
      });
    });

    setSelected("a2");
    const a2 = document.querySelector('[data-square="a2"]') as HTMLButtonElement;
    expect(a2.classList.contains("selected")).toBe(true);
    expect(a2.getAttribute("aria-selected")).toBe("true");
    a2.click();
    expect(clicks).toEqual(["a2"]);
  });

  it("the enhance + mount composition, including the `when()` wrapper gotcha", async () => {
    document.body.innerHTML = `
      <section data-sibu-island="chess">
        <b data-ref="status">idle</b>
        <button data-ref="square" data-square="a1"></button>
        <div data-ref="history"></div>
      </section>`;

    const rows: Array<{ n: number; san: string }> = [];
    const changed = external();

    registerIsland("chess", (ctx) => {
      ctx.text("@status", () => {
        changed.track();
        return rows.length === 0 ? "idle" : `${rows.length} moves`;
      });
      ctx.each<HTMLButtonElement>("@square", (el) => ({
        on: {
          click: () => {
            rows.push({ n: rows.length + 1, san: el.dataset.square as string });
            changed.invalidate();
          },
        },
      }));

      const slot = ctx.ref("@history") as HTMLElement;
      slot.textContent = "";
      const history = mount(
        () =>
          // Wrapped, exactly as the doc says: `when` inserts its branch as a
          // SIBLING of its anchor, so the mount must own an element containing
          // both or unmounting leaves the branch behind.
          div(
            when(
              () => {
                changed.track();
                return rows.length > 0;
              },
              () =>
                ol(
                  { "data-ref": "moves" },
                  each(
                    () => {
                      changed.track();
                      return rows.slice();
                    },
                    (row) => li(() => row().san),
                    { key: (row) => row.n },
                  ),
                ),
              () => p({ "data-ref": "empty" }, "No moves yet."),
            ),
          ),
        slot,
      );
      ctx.cleanup(history.unmount);
    });

    const stop = mountIslands(document);
    await flush();

    const root = document.querySelector("[data-sibu-island]") as HTMLElement;
    expect(root.querySelector('[data-ref="empty"]')).not.toBe(null);

    (root.querySelector('[data-square="a1"]') as HTMLButtonElement).click();
    await flush();
    expect(root.querySelector('[data-ref="status"]')?.textContent).toBe("1 moves");
    expect(Array.from(root.querySelectorAll('[data-ref="moves"] li'), (n) => n.textContent)).toEqual(["a1"]);

    stop();
    // The wrapper is what makes this assertion pass: anchor AND branch are gone,
    // while every server-rendered node around them is untouched.
    expect(root.querySelector('[data-ref="history"]')?.innerHTML).toBe("");
    expect(root.querySelectorAll("[data-square]")).toHaveLength(1);
  });
});

describe("the islands docs name only things that exist", () => {
  const files = ["islands.md", "interop.md", "architecture/external-state.md"];

  /** Fenced code blocks, so prose mentioning a name is not mistaken for code. */
  function codeBlocks(source: string): string[] {
    return [...source.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1]);
  }

  it("every documented `ctx.*` helper is a real EnhanceContext member", () => {
    // The runtime shape, taken from a real context rather than a hand-written list.
    document.body.innerHTML = `<div id="probe"></div>`;
    let members: string[] = [];
    enhance("#probe", (ctx) => {
      members = Object.keys(ctx);
    })();

    const used = new Set<string>();
    for (const file of files) {
      for (const block of codeBlocks(read(file))) {
        for (const m of block.matchAll(/\bctx\.([a-zA-Z]+)/g)) used.add(m[1]);
      }
    }

    expect(used.size).toBeGreaterThan(5);
    expect([...used].filter((name) => !members.includes(name))).toEqual([]);
  });

  it("every value imported from `sibujs` in the docs is exported by it", async () => {
    const index = await import("../index");
    const ui = await import("../ui");
    const patterns = await import("../patterns");
    const barrels: Record<string, Record<string, unknown>> = {
      sibujs: index as unknown as Record<string, unknown>,
      "sibujs/ui": ui as unknown as Record<string, unknown>,
      "sibujs/patterns": patterns as unknown as Record<string, unknown>,
    };

    const missing: string[] = [];
    for (const file of files) {
      for (const block of codeBlocks(read(file))) {
        for (const m of block.matchAll(/import\s*\{([^}]+)\}\s*from\s*"(sibujs(?:\/[a-z]+)?)"/g)) {
          const barrel = barrels[m[2]];
          if (!barrel) continue; // a subpath this test does not load
          for (const raw of m[1].split(",")) {
            const name = raw
              .trim()
              .replace(/^type\s+/, "")
              .split(/\s+as\s+/)[0];
            if (!name) continue;
            if (!(name in barrel)) missing.push(`${file}: ${name} is not exported by ${m[2]}`);
          }
        }
      }
    }

    expect(missing).toEqual([]);
  });

  it("the guides link only to files that exist", () => {
    const root = resolve(__dirname, "..");
    const broken: string[] = [];
    for (const file of files) {
      const dir = resolve(DOCS, file, "..");
      for (const m of read(file).matchAll(/\]\((\.\.?\/[^)#\s]+)/g)) {
        const target = resolve(dir, m[1]);
        try {
          readFileSync(target);
        } catch {
          // A directory link (e.g. `examples/chess/`) is fine if it resolves.
          try {
            readFileSync(resolve(target, "README.md"));
          } catch {
            broken.push(`${file} → ${m[1]}`);
          }
        }
      }
      expect(root.length).toBeGreaterThan(0);
    }
    expect(broken).toEqual([]);
  });
});
