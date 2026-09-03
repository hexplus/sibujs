import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setRuntimeErrorHandler } from "../src/core/errors";
import { external, signal } from "../src/core/signals/signal";
import { mountIslands, registerIsland, unregisterIsland } from "../src/platform/islands";
import { batch } from "../src/reactivity/batch";

// ---------------------------------------------------------------------------
// Resource lifecycle around an island: timers, per-element listeners created by
// `ctx.each`, activation that never happens, and an external engine that keeps
// being mutated after the island is gone.
// ---------------------------------------------------------------------------

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  for (const name of ["timer", "grid", "late", "engine"]) unregisterIsland(name);
  setRuntimeErrorHandler(null);
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("timers owned by an island", () => {
  it("a timer registered through ctx.cleanup() never fires after disposal", async () => {
    vi.useFakeTimers();
    let fired = 0;

    registerIsland("timer", (ctx) => {
      const handle = setInterval(() => fired++, 100);
      ctx.cleanup(() => clearInterval(handle));
    });

    document.body.innerHTML = `<div data-sibu-island="timer"><b data-ref="x">0</b></div>`;
    const stop = mountIslands(document);
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(250);
    expect(fired).toBe(2);

    stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fired).toBe(2); // the interval is gone, not merely ignored
  });

  it("a debounce-style timer that would write a signal after disposal is cancelled", async () => {
    vi.useFakeTimers();
    const [label, setLabel] = signal("idle");

    registerIsland("timer", (ctx) => {
      let handle: ReturnType<typeof setTimeout> | null = null;
      ctx.text("@x", () => label());
      ctx.on("@x", "click", () => {
        if (handle) clearTimeout(handle);
        handle = setTimeout(() => setLabel("late"), 50);
      });
      ctx.cleanup(() => {
        if (handle) clearTimeout(handle);
      });
    });

    document.body.innerHTML = `<div data-sibu-island="timer"><b data-ref="x">idle</b></div>`;
    const stop = mountIslands(document);
    await vi.advanceTimersByTimeAsync(0);

    const node = document.querySelector('[data-ref="x"]') as HTMLElement;
    node.click();
    stop();
    await vi.advanceTimersByTimeAsync(500);

    expect(label()).toBe("idle");
    expect(node.textContent).toBe("idle");
  });
});

describe("listeners created per repeated element", () => {
  it("every ctx.each listener is removed on disposal, across many elements", async () => {
    const clicks: number[] = [];

    registerIsland("grid", (ctx) => {
      ctx.each<HTMLButtonElement>("@cell", (_el, index) => ({
        on: { click: () => clicks.push(index) },
      }));
    });

    document.body.innerHTML = `<div data-sibu-island="grid">${Array.from(
      { length: 64 },
      () => `<button data-ref="cell"></button>`,
    ).join("")}</div>`;

    const stop = mountIslands(document);
    await flush();

    const cells = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-ref="cell"]'));
    for (const cell of cells) cell.click();
    expect(clicks).toHaveLength(64);

    stop();
    clicks.length = 0;
    for (const cell of cells) cell.click();
    expect(clicks).toEqual([]);
  });

  it("a per-element cleanup that throws does not strand the other 63", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const cleaned: number[] = [];

    registerIsland("grid", (ctx) => {
      ctx.each<HTMLButtonElement>("@cell", (_el, index) => ({
        cleanup: () => {
          if (index === 7) throw new Error("bad cleanup");
          cleaned.push(index);
        },
      }));
    });

    document.body.innerHTML = `<div data-sibu-island="grid">${Array.from(
      { length: 64 },
      () => `<button data-ref="cell"></button>`,
    ).join("")}</div>`;

    const stop = mountIslands(document);
    await flush();
    stop();

    expect(cleaned).toHaveLength(63);
    expect(cleaned).not.toContain(7);
  });
});

describe("disposal before activation", () => {
  it("an interaction island torn down before the user touches it never activates", async () => {
    let activations = 0;
    registerIsland("late", () => {
      activations++;
    });

    document.body.innerHTML = `<div data-sibu-island="late" data-sibu-load="interaction"><b data-ref="x">0</b></div>`;
    const stop = mountIslands(document);
    await flush();
    expect(activations).toBe(0);

    stop();

    const root = document.querySelector("[data-sibu-island]") as HTMLElement;
    root.dispatchEvent(new Event("pointerdown"));
    await flush();

    expect(activations).toBe(0);
    expect(root.getAttribute("data-sibu-enhanced")).toBe(null);
  });
});

describe("an external engine that outlives the island", () => {
  it("mutation and invalidation after disposal touch nothing", async () => {
    const engine = { moves: 0 };
    const changed = external();
    let bindingRuns = 0;

    registerIsland("engine", (ctx) => {
      ctx.text("@x", () => {
        changed.track();
        bindingRuns++;
        return engine.moves;
      });
    });

    document.body.innerHTML = `<div data-sibu-island="engine"><b data-ref="x">0</b></div>`;
    const stop = mountIslands(document);
    await flush();

    const node = document.querySelector('[data-ref="x"]') as HTMLElement;
    engine.moves = 1;
    changed.invalidate();
    expect(node.textContent).toBe("1");
    expect(bindingRuns).toBe(2);

    stop();

    for (let i = 0; i < 100; i++) {
      engine.moves++;
      changed.invalidate();
    }
    expect(bindingRuns).toBe(2);
    expect(node.textContent).toBe("1");
  });

  it("external mutation inside a batch reaches the island exactly once", async () => {
    const engine = { moves: 0 };
    const changed = external();
    let bindingRuns = 0;

    registerIsland("engine", (ctx) => {
      ctx.text("@x", () => {
        changed.track();
        bindingRuns++;
        return engine.moves;
      });
    });

    document.body.innerHTML = `<div data-sibu-island="engine"><b data-ref="x">0</b></div>`;
    const stop = mountIslands(document);
    await flush();
    expect(bindingRuns).toBe(1);

    batch(() => {
      for (let i = 0; i < 5; i++) {
        engine.moves++;
        changed.invalidate();
      }
    });

    expect(bindingRuns).toBe(2);
    expect(document.querySelector('[data-ref="x"]')?.textContent).toBe("5");

    stop();
  });
});
