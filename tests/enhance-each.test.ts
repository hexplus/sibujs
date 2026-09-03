import { afterEach, describe, expect, it, vi } from "vitest";
import { type RuntimeErrorContext, setRuntimeErrorHandler } from "../src/core/errors";
import { external, signal } from "../src/core/signals/signal";
import { enhance } from "../src/platform/enhance";

// ---------------------------------------------------------------------------
// ctx.each() — repeated enhancement over elements the server already rendered.
//
// The fixture is a real 64-square board, because that is the shape the helper
// exists for: a dense grid of durable nodes, each needing several independent
// bindings, where a component framework would rebuild all 64 to change one.
// ---------------------------------------------------------------------------

const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"] as const;
const RANKS = ["8", "7", "6", "5", "4", "3", "2", "1"] as const;

/** Every square name in render order, e.g. "a8" … "h1". */
const SQUARES: string[] = RANKS.flatMap((rank) => FILES.map((file) => `${file}${rank}`));

function board(): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = `<section data-sibu-island="chess">${SQUARES.map(
    (sq) => `<button data-ref="square" data-square="${sq}"><span data-ref="piece"></span></button>`,
  ).join("")}</section>`;
  document.body.appendChild(host);
  return host.firstElementChild as HTMLElement;
}

const squareEls = (root: HTMLElement) => Array.from(root.querySelectorAll<HTMLButtonElement>("[data-square]"));

afterEach(() => {
  setRuntimeErrorHandler(null);
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("ctx.each() — binding a 64-element board", () => {
  it("binds text, classes, attributes and events on every square", () => {
    const root = board();
    const before = squareEls(root);
    const [selected, setSelected] = signal<string | null>(null);
    const clicks: string[] = [];

    enhance(root, (ctx) => {
      ctx.each<HTMLButtonElement>("@square", (el) => {
        const square = el.dataset.square as string;
        return {
          class: { selected: () => selected() === square },
          attr: { "aria-selected": () => selected() === square },
          on: { click: () => clicks.push(square) },
        };
      });
      ctx.each<HTMLElement>("@piece", (_el, index) => ({
        text: () => (selected() === SQUARES[index] ? "♞" : ""),
      }));
    });

    expect(before.every((el) => el.getAttribute("aria-selected") === "false")).toBe(true);

    setSelected("e4");
    const e4 = root.querySelector('[data-square="e4"]') as HTMLButtonElement;
    expect(e4.classList.contains("selected")).toBe(true);
    expect(e4.getAttribute("aria-selected")).toBe("true");
    expect((e4.firstElementChild as HTMLElement).textContent).toBe("♞");

    // Exactly one square is selected — the other 63 were untouched.
    expect(root.querySelectorAll(".selected")).toHaveLength(1);
    expect(root.querySelectorAll('[aria-selected="true"]')).toHaveLength(1);

    e4.click();
    expect(clicks).toEqual(["e4"]);
  });

  it("preserves node identity — nothing is created, replaced or moved", () => {
    const root = board();
    const before = squareEls(root);
    const [n, setN] = signal(0);

    enhance(root, (ctx) => {
      ctx.each<HTMLButtonElement>("@square", (_el, i) => ({
        text: () => `${i + n()}`,
      }));
    });

    setN(1);
    setN(2);

    const after = squareEls(root);
    expect(after).toHaveLength(64);
    for (let i = 0; i < 64; i++) expect(after[i]).toBe(before[i]);
  });

  it("passes the element and its index, in document order", () => {
    const root = board();
    const seen: [string, number][] = [];

    enhance(root, (ctx) => {
      ctx.each<HTMLButtonElement>("@square", (el, index) => {
        seen.push([el.dataset.square as string, index]);
      });
    });

    expect(seen).toHaveLength(64);
    expect(seen[0]).toEqual(["a8", 0]);
    expect(seen[63]).toEqual(["h1", 63]);
  });

  it("supports show() per element", () => {
    const root = board();
    const [dark, setDark] = signal(true);

    enhance(root, (ctx) => {
      ctx.each<HTMLButtonElement>("@square", (_el, index) => ({
        show: () => (index % 2 === 0 ? true : dark()),
      }));
    });

    expect(squareEls(root).filter((el) => el.hidden)).toHaveLength(0);
    setDark(false);
    expect(squareEls(root).filter((el) => el.hidden)).toHaveLength(32);
  });

  it("accepts an element collection as well as a selector", () => {
    const root = board();
    const [n, setN] = signal(0);

    enhance(root, (ctx) => {
      ctx.each(root.querySelectorAll("[data-square]"), (_el) => ({ text: () => `${n()}` }));
    });

    setN(7);
    expect(squareEls(root).every((el) => el.textContent === "7")).toBe(true);
  });

  it("accepts the array returned by ctx.refs()", () => {
    const root = board();
    const [n, setN] = signal(0);

    enhance(root, (ctx) => {
      ctx.each(ctx.refs<HTMLButtonElement>("@square").slice(0, 3), () => ({ text: () => `${n()}` }));
    });

    setN(4);
    const texts = squareEls(root).map((el) => el.textContent);
    expect(texts.slice(0, 3)).toEqual(["4", "4", "4"]);
    expect(texts.slice(3).every((t) => t === "")).toBe(true);
  });

  it("mixes descriptors with imperative ctx calls in the same callback", () => {
    const root = board();
    const [value, setValue] = signal("x");
    const keydowns: string[] = [];

    enhance(root, (ctx) => {
      ctx.each<HTMLButtonElement>("@square", (el, index) => {
        if (index === 0) {
          // Listener options are deliberately not in the descriptor — reach for
          // the ordinary helper with the element in hand.
          ctx.on(el, "keydown", (event) => keydowns.push(event.key), { capture: true });
        }
        return { text: () => value() };
      });
    });

    setValue("y");
    expect(squareEls(root)[0].textContent).toBe("y");
    squareEls(root)[0].dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(keydowns).toEqual(["Enter"]);
  });
});

describe("ctx.each() — lifecycle", () => {
  it("disposes every generated binding, listener and per-element cleanup with the island", () => {
    const root = board();
    const [n, setN] = signal(0);
    const clicks: string[] = [];
    const cleaned: string[] = [];

    const stop = enhance(root, (ctx) => {
      ctx.each<HTMLButtonElement>("@square", (el) => {
        const square = el.dataset.square as string;
        return {
          text: () => `${n()}`,
          on: { click: () => clicks.push(square) },
          cleanup: () => cleaned.push(square),
        };
      });
    });

    setN(1);
    expect(squareEls(root)[0].textContent).toBe("1");

    stop();

    expect(cleaned).toHaveLength(64);
    setN(2);
    expect(squareEls(root)[0].textContent).toBe("1"); // bindings stopped
    squareEls(root)[0].click();
    expect(clicks).toEqual([]); // listeners removed
  });

  it("rolls back everything already attached when the callback throws mid-board", () => {
    const root = board();
    const [n, setN] = signal(0);
    const clicks: string[] = [];

    expect(() =>
      enhance(root, (ctx) => {
        ctx.each<HTMLButtonElement>("@square", (_el, index) => {
          if (index === 10) throw new Error("bad square");
          return { text: () => `${n()}`, on: { click: () => clicks.push("x") } };
        });
      }),
    ).toThrow("bad square");

    // Transaction: the root never claimed ownership, so it is enhanceable again.
    expect(root.getAttribute("data-sibu-enhanced")).toBe(null);

    // Every binding and listener the first ten squares received is gone. Values
    // those bindings already wrote are NOT rolled back — `enhance` reverses the
    // subscriptions it owns, not DOM writes (same contract as a bare
    // `ctx.text()` before a throw); what matters is that nothing stays live.
    const bound = squareEls(root).slice(0, 10);
    expect(bound.map((el) => el.textContent)).toEqual(Array(10).fill("0"));
    setN(5);
    expect(bound.map((el) => el.textContent)).toEqual(Array(10).fill("0"));
    expect(
      squareEls(root)
        .slice(10)
        .every((el) => el.textContent === ""),
    ).toBe(true);
    squareEls(root)[0].click();
    expect(clicks).toEqual([]);
  });

  it("calling each() twice creates independent bindings (documented, not deduplicated)", () => {
    const root = board();
    const [a, setA] = signal("a");
    const [b, setB] = signal("b");

    enhance(root, (ctx) => {
      ctx.each<HTMLButtonElement>("@square", () => ({ class: { one: () => a() === "on" } }));
      ctx.each<HTMLButtonElement>("@square", () => ({ class: { two: () => b() === "on" } }));
    });

    setA("on");
    setB("on");
    const first = squareEls(root)[0];
    expect(first.classList.contains("one")).toBe(true);
    expect(first.classList.contains("two")).toBe(true);
  });

  it("zero matches is a silent no-op", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const root = board();
    let called = 0;

    expect(() =>
      enhance(root, (ctx) => {
        ctx.each("@nothing-here", () => {
          called++;
        });
        ctx.each([], () => {
          called++;
        });
      }),
    ).not.toThrow();

    expect(called).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("ctx.each() — error metadata parity with hand-written bindings", () => {
  it("a failing generated binding reports phase 'binding' and its own element", () => {
    const reports: Array<{ error: unknown; context: RuntimeErrorContext }> = [];
    setRuntimeErrorHandler((error, context) => reports.push({ error, context }));

    const root = board();
    const [armed, setArmed] = signal(false);

    enhance(root, (ctx) => {
      ctx.each<HTMLButtonElement>("@square", (_el, index) => ({
        text: () => {
          if (armed() && index === 42) throw new Error("square 42 boom");
          return "";
        },
      }));
    });

    setArmed(true);

    expect(reports).toHaveLength(1);
    expect((reports[0].error as Error).message).toBe("square 42 boom");
    expect(reports[0].context.phase).toBe("binding");
    expect(reports[0].context.node).toBe(squareEls(root)[42]);
  });

  it("one failing square does not stop the other 63 from updating", () => {
    setRuntimeErrorHandler(() => {});
    const root = board();
    const [n, setN] = signal(0);

    enhance(root, (ctx) => {
      ctx.each<HTMLButtonElement>("@square", (_el, index) => ({
        text: () => {
          const v = n();
          if (v > 0 && index === 5) throw new Error("boom");
          return `${v}`;
        },
      }));
    });

    setN(1);
    const texts = squareEls(root).map((el) => el.textContent);
    expect(texts.filter((t) => t === "1")).toHaveLength(63);
    expect(texts[5]).toBe("0"); // the throwing square kept its last good value
  });
});

describe("ctx.each() — development diagnostics", () => {
  it("rejects an unknown binding key with the element index", () => {
    const root = board();
    expect(() =>
      enhance(root, (ctx) => {
        ctx.each<HTMLButtonElement>("@square", () => ({ txt: () => "typo" }) as never);
      }),
    ).toThrow(/ctx\.each\[0\].*unknown binding "txt"/s);
  });

  it("rejects a non-function value where a getter is required", () => {
    const root = board();
    expect(() =>
      enhance(root, (ctx) => {
        ctx.each<HTMLButtonElement>("@square", () => ({ text: "not a getter" }) as never);
      }),
    ).toThrow(/ctx\.each\[0\]: "text" must be a function/);

    expect(() =>
      enhance(root, (ctx) => {
        ctx.each<HTMLButtonElement>("@square", () => ({ class: { on: true } }) as never);
      }),
    ).toThrow(/ctx\.each\[0\]: class\["on"\] must be a function/);

    expect(() =>
      enhance(root, (ctx) => {
        ctx.each<HTMLButtonElement>("@square", () => ({ on: { click: 1 } }) as never);
      }),
    ).toThrow(/ctx\.each\[0\]: on\["click"\] must be a function/);
  });

  it("rejects a non-function describe callback", () => {
    const root = board();
    expect(() =>
      enhance(root, (ctx) => {
        (ctx.each as unknown as (t: string, d: unknown) => void)("@square", null);
      }),
    ).toThrow(/ctx\.each: second argument must be a function/);
  });
});

describe("ctx.each() — with an external engine", () => {
  it("one invalidation refreshes every square that reads the engine", () => {
    const root = board();
    // A deliberately opaque engine: SibuJS cannot see writes into it.
    const pieces = new Map<string, string>([["e2", "♙"]]);
    const moved = external();

    enhance(root, (ctx) => {
      ctx.each<HTMLElement>("@piece", (_el, index) => ({
        text: () => {
          moved.track();
          return pieces.get(SQUARES[index]) ?? "";
        },
      }));
    });

    const pieceAt = (sq: string) =>
      (root.querySelector(`[data-square="${sq}"] [data-ref="piece"]`) as HTMLElement).textContent;

    expect(pieceAt("e2")).toBe("♙");
    expect(pieceAt("e4")).toBe("");

    pieces.delete("e2");
    pieces.set("e4", "♙");
    moved.invalidate();

    expect(pieceAt("e2")).toBe("");
    expect(pieceAt("e4")).toBe("♙");
  });
});
