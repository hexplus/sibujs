import { describe, expect, it } from "vitest";
import { derived, div, each, effect, h1, mount, signal } from "../index";

// Smoke test for the @sibujs/core public surface: proves the extracted engine
// renders, reacts, and diffs lists through its own barrel with no dependency on
// the `sibujs` std package.
describe("@sibujs/core public surface", () => {
  it("renders a reactive counter and updates only on change", () => {
    const host = document.createElement("div");
    const [count, setCount] = signal(0);
    const doubled = derived(() => count() * 2);
    let effectRuns = 0;
    effect(() => {
      doubled();
      effectRuns++;
    });

    mount(() => div([h1(() => `Count: ${count()}`)]), host);
    expect(host.textContent).toContain("Count: 0");

    setCount(5);
    expect(host.textContent).toContain("Count: 5");
    expect(doubled()).toBe(10);
    expect(effectRuns).toBe(2); // initial + one update
  });

  it("renders a keyed list via each", async () => {
    const container = document.createElement("div");
    const [items] = signal([
      { id: 1, t: "a" },
      { id: 2, t: "b" },
    ]);
    const anchor = each(
      items,
      (it) => {
        const el = document.createElement("span");
        el.textContent = it().t;
        return el;
      },
      { key: (i) => i.id },
    );
    container.appendChild(anchor);
    await Promise.resolve();
    expect(container.textContent).toContain("a");
    expect(container.textContent).toContain("b");
  });
});
