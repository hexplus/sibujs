import { beforeEach, describe, expect, it } from "vitest";
import { each } from "../src/core/rendering/each";
import { signal } from "../src/core/signals/signal";

const tick = () => new Promise<void>((r) => queueMicrotask(() => r()));

interface Row {
  id: number;
}

/**
 * Mulberry32 — a small deterministic PRNG. Seeded so any failure reported by
 * this suite can be replayed exactly.
 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ids = (n: number, from = 1): Row[] => Array.from({ length: n }, (_, i) => ({ id: from + i }));

describe("hardening: keyed reconciliation", () => {
  let host: HTMLElement;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  /** Mount an each() over `initial` and return helpers to drive and read it. */
  async function mount(initial: Row[]) {
    const [items, setItems] = signal(initial);
    const anchor = each(
      items,
      (item) => {
        const el = document.createElement("div");
        el.dataset.id = String(item().id);
        return el;
      },
      { key: (item) => item.id },
    );
    host.appendChild(anchor);
    await tick();

    const domIds = () => Array.from(host.querySelectorAll("div")).map((el) => Number(el.dataset.id));
    const nodeFor = (id: number) => host.querySelector(`div[data-id="${id}"]`);
    return { setItems, domIds, nodeFor };
  }

  describe("structural mutations", () => {
    const base = ids(5); // 1..5

    const cases: [string, Row[]][] = [
      ["append", [...base, { id: 6 }]],
      ["prepend", [{ id: 0 }, ...base]],
      ["insert middle", [...base.slice(0, 2), { id: 99 }, ...base.slice(2)]],
      ["remove first", base.slice(1)],
      ["remove middle", [...base.slice(0, 2), ...base.slice(3)]],
      ["remove last", base.slice(0, -1)],
      ["reverse", [...base].reverse()],
      ["rotate left", [...base.slice(1), base[0]]],
      ["rotate right", [base[4], ...base.slice(0, 4)]],
      ["swap adjacent", [base[0], base[2], base[1], base[3], base[4]]],
      ["swap distant", [base[4], base[1], base[2], base[3], base[0]]],
      ["sort descending", [...base].reverse()],
      ["replace all", ids(5, 100)],
      ["populated → empty", []],
      ["many → single", [base[2]]],
    ];

    for (const [name, next] of cases) {
      it(`produces the expected order after ${name}`, async () => {
        const { setItems, domIds } = await mount(base);
        expect(domIds()).toEqual([1, 2, 3, 4, 5]);

        setItems(next);
        await tick();

        expect(domIds()).toEqual(next.map((r) => r.id));
      });
    }

    it("goes from empty to populated", async () => {
      const { setItems, domIds } = await mount([]);
      expect(domIds()).toEqual([]);

      setItems(ids(4));
      await tick();
      expect(domIds()).toEqual([1, 2, 3, 4]);
    });

    it("goes from single to many", async () => {
      const { setItems, domIds } = await mount([{ id: 1 }]);
      setItems(ids(6));
      await tick();
      expect(domIds()).toEqual([1, 2, 3, 4, 5, 6]);
    });
  });

  describe("node identity", () => {
    it("preserves the DOM node instance for a key that survives a reorder", async () => {
      const { setItems, nodeFor } = await mount(ids(5));

      const before = [1, 2, 3, 4, 5].map(nodeFor);
      setItems([...ids(5)].reverse());
      await tick();
      const after = [1, 2, 3, 4, 5].map(nodeFor);

      for (let i = 0; i < 5; i++) {
        expect(after[i]).toBe(before[i]);
      }
    });

    it("preserves node identity for survivors across an insert and a removal", async () => {
      const { setItems, nodeFor } = await mount(ids(4));
      const node2 = nodeFor(2);
      const node4 = nodeFor(4);

      setItems([{ id: 9 }, { id: 2 }, { id: 4 }]);
      await tick();

      expect(nodeFor(2)).toBe(node2);
      expect(nodeFor(4)).toBe(node4);
      expect(nodeFor(1)).toBeNull();
    });

    it("does not re-run render for a key that is merely moved", async () => {
      const [items, setItems] = signal(ids(4));
      const rendered: number[] = [];
      const anchor = each(
        items,
        (item) => {
          rendered.push(item().id);
          const el = document.createElement("div");
          el.dataset.id = String(item().id);
          return el;
        },
        { key: (item) => item.id },
      );
      host.appendChild(anchor);
      await tick();
      expect(rendered).toEqual([1, 2, 3, 4]);

      setItems([...ids(4)].reverse());
      await tick();

      // A move must not re-render: no new render calls for existing keys.
      expect(rendered).toEqual([1, 2, 3, 4]);
    });
  });

  describe("key types", () => {
    it("supports string keys", async () => {
      const [items, setItems] = signal([{ k: "a" }, { k: "b" }, { k: "c" }]);
      const anchor = each(
        items,
        (item) => {
          const el = document.createElement("div");
          el.dataset.id = item().k;
          return el;
        },
        { key: (item) => item.k },
      );
      host.appendChild(anchor);
      await tick();
      expect(Array.from(host.querySelectorAll("div")).map((e) => e.dataset.id)).toEqual(["a", "b", "c"]);

      setItems([{ k: "c" }, { k: "a" }]);
      await tick();
      expect(Array.from(host.querySelectorAll("div")).map((e) => e.dataset.id)).toEqual(["c", "a"]);
    });

    it("treats the numeric and string forms of a key as distinct", async () => {
      const { setItems, domIds } = await mount([{ id: 1 }]);
      setItems([{ id: 1 }, { id: "1" as unknown as number }]);
      await tick();
      expect(domIds()).toHaveLength(2);
    });
  });

  describe("scale", () => {
    for (const size of [1, 10, 100, 1000]) {
      it(`reverses a ${size}-item list correctly`, async () => {
        const { setItems, domIds } = await mount(ids(size));
        const reversed = [...ids(size)].reverse();
        setItems(reversed);
        await tick();
        expect(domIds()).toEqual(reversed.map((r) => r.id));
      });
    }

    it("handles 10,000 items end to end", async () => {
      const { setItems, domIds } = await mount(ids(10_000));
      expect(domIds()).toHaveLength(10_000);

      setItems(ids(10_000).filter((_, i) => i % 2 === 0));
      await tick();
      expect(domIds()).toHaveLength(5000);

      setItems([]);
      await tick();
      expect(domIds()).toEqual([]);
    });
  });

  describe("randomized differential testing", () => {
    /**
     * Drives a long sequence of random mutations, comparing the DOM against a
     * reference array maintained outside the framework after every step. On
     * mismatch the failure message carries the seed and operation log needed
     * to replay it exactly.
     */
    async function fuzz(seed: number, operations: number) {
      const rand = rng(seed);
      const randInt = (n: number) => Math.floor(rand() * n);

      let model: Row[] = ids(10);
      let nextId = 11;
      const { setItems, domIds } = await mount(model);

      const log: string[] = [];

      for (let step = 0; step < operations; step++) {
        const next = [...model];
        const op = randInt(8);

        switch (op) {
          case 0: {
            next.push({ id: nextId++ });
            log.push("push");
            break;
          }
          case 1: {
            next.unshift({ id: nextId++ });
            log.push("unshift");
            break;
          }
          case 2: {
            if (next.length > 0) {
              const i = randInt(next.length);
              log.push(`remove@${i}`);
              next.splice(i, 1);
            }
            break;
          }
          case 3: {
            const i = randInt(next.length + 1);
            log.push(`insert@${i}`);
            next.splice(i, 0, { id: nextId++ });
            break;
          }
          case 4: {
            next.reverse();
            log.push("reverse");
            break;
          }
          case 5: {
            if (next.length > 1) {
              const i = randInt(next.length);
              const j = randInt(next.length);
              log.push(`swap ${i}<->${j}`);
              [next[i], next[j]] = [next[j], next[i]];
            }
            break;
          }
          case 6: {
            // Fisher-Yates shuffle
            for (let i = next.length - 1; i > 0; i--) {
              const j = randInt(i + 1);
              [next[i], next[j]] = [next[j], next[i]];
            }
            log.push("shuffle");
            break;
          }
          default: {
            log.push("clear");
            next.length = 0;
            break;
          }
        }

        model = next;
        setItems(model);
        await tick();

        const actual = domIds();
        const expected = model.map((r) => r.id);
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
          throw new Error(
            `Reconciliation mismatch at step ${step} (seed ${seed}).\n` +
              `Operations: ${log.join(" -> ")}\n` +
              `Expected: ${JSON.stringify(expected)}\n` +
              `Actual:   ${JSON.stringify(actual)}`,
          );
        }
      }
    }

    for (const seed of [123456, 987654, 42]) {
      it(`matches a reference array over 400 random operations (seed ${seed})`, async () => {
        await fuzz(seed, 400);
      });
    }
  });

  describe("duplicate keys", () => {
    it("warns in development and does not corrupt the surviving DOM", async () => {
      const warnings: string[] = [];
      const originalWarn = console.warn;
      console.warn = (...args: unknown[]) => {
        warnings.push(args.map(String).join(" "));
      };

      try {
        const { setItems, domIds } = await mount(ids(3));
        setItems([{ id: 1 }, { id: 1 }, { id: 2 }]);
        await tick();

        expect(warnings.some((w) => w.includes("duplicate key"))).toBe(true);
        // Documented behaviour: duplicates collapse to a single node, so the
        // rendered row count is the number of DISTINCT keys.
        expect(domIds()).toEqual([1, 2]);
      } finally {
        console.warn = originalWarn;
      }
    });
  });
});
