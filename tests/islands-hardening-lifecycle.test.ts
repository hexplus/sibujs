// ---------------------------------------------------------------------------
// Island lifecycle hardening.
//
// enhance() is transactional, so island error isolation must be *lifecycle*
// isolation, not merely control-flow isolation: a failed island reports its
// error and leaves zero live framework-owned resources behind, while its
// siblings mount normally.
//
// These tests also pin the remount contract (mountIslands cleanup releases the
// DOM for a later mount) and the two teardown races: teardown before a lazy
// chunk resolves, and teardown *during* setup.
// ---------------------------------------------------------------------------

import { afterEach, describe, expect, it, vi } from "vitest";
import { signal } from "../src/core/signals/signal";
import { lazyIsland, mountIslands, registerIsland, unregisterIsland } from "../src/platform/islands";

const flush = () => new Promise((r) => setTimeout(r, 0));

const NAMES = ["h-bad", "h-good", "h-remount", "h-lazy", "h-self", "h-strat"];

afterEach(() => {
  document.body.innerHTML = "";
  for (const n of NAMES) unregisterIsland(n);
  vi.restoreAllMocks();
});

describe("ISL-001 — a failed island leaves no live framework lifecycle", () => {
  it("reports the error, strands nothing, and still mounts the sibling", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    document.body.innerHTML = `
      <div data-sibu-island="h-bad"><b data-ref="v">x</b><button data-ref="go">go</button></div>
      <div data-sibu-island="h-good"><b data-ref="v">x</b></div>`;

    const bad = document.querySelector('[data-sibu-island="h-bad"]') as HTMLElement;
    const good = document.querySelector('[data-sibu-island="h-good"]') as HTMLElement;
    const badText = bad.querySelector('[data-ref="v"]') as HTMLElement;
    const badButton = bad.querySelector('[data-ref="go"]') as HTMLButtonElement;

    const [n, setN] = signal("first");
    let badClicks = 0;
    let badCleanups = 0;
    let badSetups = 0;

    registerIsland("h-bad", (ctx) => {
      badSetups++;
      ctx.text("@v", () => n());
      ctx.on("@go", "click", () => badClicks++);
      ctx.cleanup(() => badCleanups++);
      throw new Error("island boom");
    });
    registerIsland("h-good", (ctx) => ctx.text("@v", () => n()));

    const stop = mountIslands();
    await flush();

    // Vacuity guards: the failing island's setup really ran and really bound.
    expect(badSetups).toBe(1);
    expect(badText.textContent).toBe("first");
    expect(badCleanups).toBe(1);
    expect(err).toHaveBeenCalled();

    // Zero live bindings and zero live listeners on the failed island.
    setN("second");
    expect(badText.textContent).toBe("first");
    badButton.click();
    expect(badClicks).toBe(0);

    // Not marked as owning an enhancement, nor as hydrated.
    expect(bad.hasAttribute("data-sibu-enhanced")).toBe(false);
    expect(bad.hasAttribute("data-sibu-hydrated")).toBe(false);

    // The sibling activated normally and is genuinely reactive.
    expect(good.getAttribute("data-sibu-hydrated")).toBe("true");
    expect(good.querySelector('[data-ref="v"]')?.textContent).toBe("second");

    stop();
  });

  it("lets a failed island be mounted again once its setup is fixed", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    document.body.innerHTML = `<div data-sibu-island="h-bad"><b data-ref="v">x</b></div>`;
    const el = document.querySelector('[data-sibu-island="h-bad"]') as HTMLElement;
    const [n, setN] = signal("a");

    registerIsland("h-bad", (ctx) => {
      ctx.text("@v", () => n());
      throw new Error("boom");
    });
    const stop1 = mountIslands();
    await flush();
    expect(err).toHaveBeenCalled();
    expect(el.hasAttribute("data-sibu-enhanced")).toBe(false);
    stop1();

    // A failed island never claimed the root, so a repaired registration mounts.
    registerIsland("h-bad", (ctx) => ctx.text("@v", () => n()));
    const stop2 = mountIslands();
    await flush();

    setN("b");
    expect(el.querySelector('[data-ref="v"]')?.textContent).toBe("b");
    stop2();
  });
});

describe("island remount semantics", () => {
  it.each([
    ["load", ""],
    ["idle", ""],
    ["visible", ""],
    ["media", `data-sibu-media="(min-width: 0px)"`],
  ])("remounts the same DOM after cleanup (%s strategy)", async (strategy, extra) => {
    document.body.innerHTML = `<div data-sibu-island="h-strat" data-sibu-load="${strategy}" ${extra}><b data-ref="v">0</b></div>`;
    const el = document.querySelector('[data-sibu-island="h-strat"]') as HTMLElement;
    const node = el.querySelector('[data-ref="v"]') as HTMLElement;
    const [n, setN] = signal(0);
    let setups = 0;
    registerIsland("h-strat", (ctx) => {
      setups++;
      ctx.text("@v", () => n());
    });

    const stop1 = mountIslands();
    await flush();
    setN(1);
    expect(setups).toBe(1); // vacuity guard: it actually activated
    expect(node.textContent).toBe("1");

    stop1();
    setN(2);
    expect(node.textContent).toBe("1"); // disposed

    const stop2 = mountIslands();
    await flush();
    setN(3);
    expect(setups).toBe(2);
    expect(node.textContent).toBe("3"); // second generation live, single binding
    stop2();
  });

  it("survives 200 mount/cleanup cycles without accumulating listeners", async () => {
    document.body.innerHTML = `<div data-sibu-island="h-remount" data-sibu-load="interaction"><b data-ref="v">0</b></div>`;
    const el = document.querySelector('[data-sibu-island="h-remount"]') as HTMLElement;
    registerIsland("h-remount", (ctx) => ctx.text("@v", () => "on"));

    const added = new Map<string, number>();
    const removed = new Map<string, number>();
    const origAdd = el.addEventListener.bind(el);
    const origRemove = el.removeEventListener.bind(el);
    vi.spyOn(el, "addEventListener").mockImplementation(((type: string, ...rest: unknown[]) => {
      added.set(type, (added.get(type) ?? 0) + 1);
      return (origAdd as unknown as (...a: unknown[]) => unknown)(type, ...rest);
    }) as typeof el.addEventListener);
    vi.spyOn(el, "removeEventListener").mockImplementation(((type: string, ...rest: unknown[]) => {
      removed.set(type, (removed.get(type) ?? 0) + 1);
      return (origRemove as unknown as (...a: unknown[]) => unknown)(type, ...rest);
    }) as typeof el.removeEventListener);

    // No manual marker scrubbing: remountability is the contract now.
    for (let i = 0; i < 200; i++) {
      const cleanup = mountIslands();
      cleanup();
    }

    expect(added.size).toBeGreaterThan(0); // vacuity guard: schedulers really wired
    for (const [type, addCount] of added) {
      expect(removed.get(type) ?? 0, `listener "${type}"`).toBeGreaterThanOrEqual(addCount);
    }
    expect(el.hasAttribute("data-sibu-enhanced")).toBe(false);
  });
});

describe("island teardown races", () => {
  it("cleanup before a lazy chunk resolves prevents activation entirely", async () => {
    document.body.innerHTML = `<div data-sibu-island="h-lazy"><b data-ref="v">idle</b></div>`;
    const el = document.querySelector('[data-sibu-island="h-lazy"]') as HTMLElement;
    let setups = 0;
    let resolveChunk: (v: { default: (ctx: { text: unknown }) => void }) => void = () => {};
    const chunk = new Promise<{ default: (ctx: never) => void }>((r) => {
      resolveChunk = r as never;
    });

    registerIsland(
      "h-lazy",
      lazyIsland(() => chunk as never),
    );

    const stop = mountIslands();
    await flush(); // loader started, chunk still pending
    stop(); // teardown lands first

    resolveChunk({
      default: ((ctx: { text: (t: string, v: () => unknown) => void }) => {
        setups++;
        ctx.text("@v", () => "active");
      }) as never,
    });
    await flush();

    expect(setups).toBe(0); // setup must never run after teardown
    expect(el.querySelector('[data-ref="v"]')?.textContent).toBe("idle");
    expect(el.hasAttribute("data-sibu-enhanced")).toBe(false);
    expect(el.hasAttribute("data-sibu-hydrated")).toBe(false);
  });

  it("teardown during setup disposes the island instead of stranding it", async () => {
    document.body.innerHTML = `<div data-sibu-island="h-self"><b data-ref="v">0</b></div>`;
    const el = document.querySelector('[data-sibu-island="h-self"]') as HTMLElement;
    const node = el.querySelector('[data-ref="v"]') as HTMLElement;
    const [n, setN] = signal(0);
    let stop: (() => void) | undefined;
    let setups = 0;

    registerIsland("h-self", (ctx) => {
      setups++;
      ctx.text("@v", () => n());
      stop?.(); // the island's own mount is torn down mid-setup
    });

    stop = mountIslands();
    await flush();

    expect(setups).toBe(1); // vacuity guard: setup really ran
    // The enhancement completed but its owner was already gone — it must be
    // disposed, not left live with an unreachable disposer.
    setN(5);
    expect(node.textContent).toBe("0");
    expect(el.hasAttribute("data-sibu-enhanced")).toBe(false);
    expect(el.hasAttribute("data-sibu-hydrated")).toBe(false);
  });
});
