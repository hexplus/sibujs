import { afterEach, describe, expect, it, vi } from "vitest";
import { signal } from "../src/core/signals/signal";
import { lazyIsland, mountIslands, registerIsland, unregisterIsland } from "../src/platform/islands";

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  document.body.innerHTML = "";
  for (const n of ["counter", "lazyc", "modc", "later", "boom", "ok", "bad"]) unregisterIsland(n);
  vi.restoreAllMocks();
});

describe("island runtime — registerIsland + mountIslands", () => {
  it("activates a 'load' island in place and keeps server markup reactive", async () => {
    document.body.innerHTML = `
      <div data-sibu-island="counter">
        <output data-ref="n">0</output>
        <button data-ref="inc">+</button>
      </div>`;
    const marker = document.querySelector('[data-sibu-island="counter"]') as HTMLElement;
    const staticOut = marker.querySelector('[data-ref="n"]') as HTMLElement;

    registerIsland("counter", (ctx) => {
      const [n, setN] = signal(0);
      ctx.text("@n", () => n());
      ctx.on("@inc", "click", () => setN((v) => v + 1));
    });

    const stop = mountIslands();
    await flush();

    expect(marker.getAttribute("data-sibu-hydrated")).toBe("true");
    // attached, not replaced
    expect(marker.querySelector('[data-ref="n"]')).toBe(staticOut);

    (marker.querySelector('[data-ref="inc"]') as HTMLButtonElement).click();
    expect(staticOut.textContent).toBe("1");

    stop();
  });

  it("lazy-loads island code only when it activates", async () => {
    document.body.innerHTML = `<div data-sibu-island="lazyc"><b data-ref="v">x</b></div>`;
    let imported = 0;

    registerIsland(
      "lazyc",
      lazyIsland(async () => {
        imported++;
        // Simulate `() => import("./island.js")` resolving to a module.
        return { default: (ctx) => ctx.text("@v", () => "loaded") };
      }),
    );

    expect(imported).toBe(0); // not fetched at registration
    mountIslands();
    await flush();

    expect(imported).toBe(1); // fetched on activation
    expect(document.querySelector('[data-ref="v"]')?.textContent).toBe("loaded");
  });

  it("defers an 'interaction' island until the first interaction", async () => {
    document.body.innerHTML = `<div data-sibu-island="later" data-sibu-load="interaction"><b data-ref="v">idle</b></div>`;
    const marker = document.querySelector('[data-sibu-island="later"]') as HTMLElement;
    registerIsland("later", (ctx) => ctx.text("@v", () => "active"));

    mountIslands();
    await flush();
    expect(marker.getAttribute("data-sibu-hydrated")).toBeNull(); // not yet
    expect(marker.querySelector('[data-ref="v"]')?.textContent).toBe("idle");

    marker.dispatchEvent(new Event("pointerdown"));
    await flush();
    expect(marker.getAttribute("data-sibu-hydrated")).toBe("true");
    expect(marker.querySelector('[data-ref="v"]')?.textContent).toBe("active");
  });

  it("warns and skips an island with no registration", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    document.body.innerHTML = `<div data-sibu-island="ghost"></div>`;
    mountIslands();
    await flush();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ghost"));
  });

  it("isolates a failing island so the rest of the page still mounts", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    document.body.innerHTML = `
      <div data-sibu-island="boom"><b data-ref="v">x</b></div>
      <div data-sibu-island="ok"><b data-ref="v">x</b></div>`;
    registerIsland("boom", () => {
      throw new Error("kaboom");
    });
    registerIsland("ok", (ctx) => ctx.text("@v", () => "ok"));

    mountIslands();
    await flush();

    const ok = document.querySelector('[data-sibu-island="ok"]');
    expect(ok?.getAttribute("data-sibu-hydrated")).toBe("true"); // good island mounted
    expect(ok?.querySelector('[data-ref="v"]')?.textContent).toBe("ok");
    expect(err).toHaveBeenCalled(); // the bad one was reported, not fatal
  });

  it("reports a failed lazy import instead of throwing an unhandled rejection", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    document.body.innerHTML = `<div data-sibu-island="bad"><b data-ref="v">x</b></div>`;
    registerIsland(
      "bad",
      lazyIsland(() => Promise.reject(new Error("404 fetching island"))),
    );

    expect(() => mountIslands()).not.toThrow();
    await flush();
    expect(err).toHaveBeenCalledWith(expect.stringContaining("failed to load"), expect.any(Error));
  });

  it("cleanup disposes mounted islands; re-mount is idempotent", async () => {
    document.body.innerHTML = `<div data-sibu-island="modc"><b data-ref="n">0</b></div>`;
    const node = document.querySelector('[data-ref="n"]') as HTMLElement;
    const [n, setN] = signal(0);
    registerIsland("modc", (ctx) => ctx.text("@n", () => n()));

    const stop = mountIslands();
    await flush();
    setN(3);
    expect(node.textContent).toBe("3");

    stop();
    setN(9);
    expect(node.textContent).toBe("3"); // disposed → effect stopped

    // Already-enhanced markers are skipped on a second mount (no double-wire).
    const marker = document.querySelector('[data-sibu-island="modc"]') as HTMLElement;
    expect(marker.getAttribute("data-sibu-enhanced")).toBe("true");
    const stop2 = mountIslands();
    await flush();
    setN(4);
    expect(node.textContent).toBe("3"); // still not re-bound
    stop2();
  });
});
