import { afterEach, describe, expect, it, vi } from "vitest";
import { type RuntimeErrorContext, setRuntimeErrorHandler } from "../src/core/errors";
import { dispose } from "../src/core/rendering/dispose";
import { each } from "../src/core/rendering/each";
import { li, ol } from "../src/core/rendering/html";
import { mount } from "../src/core/rendering/mount";
import { external, signal } from "../src/core/signals/signal";
import { mountIslands, registerIsland, unregisterIsland } from "../src/platform/islands";

// ---------------------------------------------------------------------------
// enhance() + mount() inside ONE island.
//
// The shape every substantial feature ends up in: a durable server-rendered
// shell whose meaningful DOM already exists (enhanced in place, node identity
// preserved), containing one subregion whose node COUNT is unknown until the
// client runs (mounted, keyed, reconciled by `each`). One lifecycle boundary
// owns both.
// ---------------------------------------------------------------------------

/** Server markup: a 4-square "board", a status line, and an EMPTY history slot. */
function serverPage(count = 1): void {
  document.body.innerHTML = Array.from(
    { length: count },
    (_, i) => `
      <section data-sibu-island="feature" data-instance="${i}">
        <p data-ref="status">idle</p>
        <button data-ref="sq" data-square="a1"></button>
        <button data-ref="sq" data-square="a2"></button>
        <button data-ref="sq" data-square="b1"></button>
        <button data-ref="sq" data-square="b2"></button>
        <div data-ref="history"><p data-ref="empty">No moves yet.</p></div>
        <footer data-ref="server-footer">rendered on the server</footer>
      </section>`,
  ).join("");
}

const islandAt = (i = 0) => document.querySelectorAll<HTMLElement>("[data-sibu-island]")[i];
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

afterEach(() => {
  unregisterIsland("feature");
  unregisterIsland("broken");
  setRuntimeErrorHandler(null);
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

/**
 * Feature-local state: created INSIDE the island setup, so two islands on one
 * page share nothing. Nothing here is module-level, which is the difference
 * between "shared within a feature" and "hidden global".
 */
function createFeature() {
  const engine = { moves: [] as string[] }; // stands in for a domain engine
  const changed = external();
  const [selected, setSelected] = signal<string | null>(null);

  return {
    engine,
    changed,
    selected,
    select: (sq: string) => setSelected(sq),
    play(square: string) {
      engine.moves.push(square);
      setSelected(null);
      changed.invalidate();
    },
  };
}

describe("one island: enhanced shell + mounted dynamic subregion", () => {
  it("enhances existing DOM and mounts a list whose length the server never knew", async () => {
    registerIsland("feature", (ctx) => {
      const feature = createFeature();

      // --- enhanced: the DOM already exists -------------------------------
      ctx.text("@status", () => {
        feature.changed.track();
        return feature.engine.moves.length === 0 ? "idle" : `${feature.engine.moves.length} moves`;
      });
      ctx.each<HTMLButtonElement>("@sq", (el) => {
        const square = el.dataset.square as string;
        return {
          class: { selected: () => feature.selected() === square },
          on: { click: () => feature.play(square) },
        };
      });

      // --- mounted: the client decides how many nodes exist ---------------
      const historySlot = ctx.ref("@history") as HTMLElement;
      const emptyState = ctx.ref("@empty") as HTMLElement;
      ctx.show(emptyState, () => {
        feature.changed.track();
        return feature.engine.moves.length === 0;
      });

      const history = mount(
        () =>
          ol(
            { "data-ref": "moves" },
            each(
              () => {
                feature.changed.track();
                return feature.engine.moves.map((move, i) => ({ id: i, move }));
              },
              (item) => li(() => item().move),
              { key: (item) => item.id },
            ),
          ),
        historySlot,
      );
      ctx.cleanup(history.unmount);
    });

    serverPage();
    const stop = mountIslands(document);
    await flush();

    const root = islandAt(0);
    expect(root.getAttribute("data-sibu-enhanced")).toBe("true");
    expect(root.querySelector('[data-ref="status"]')?.textContent).toBe("idle");
    expect(root.querySelectorAll('[data-ref="moves"] li')).toHaveLength(0);
    expect((root.querySelector('[data-ref="empty"]') as HTMLElement).hidden).toBe(false);

    (root.querySelector('[data-square="b2"]') as HTMLButtonElement).click();
    expect(root.querySelector('[data-ref="status"]')?.textContent).toBe("1 moves");
    expect(Array.from(root.querySelectorAll('[data-ref="moves"] li'), (n) => n.textContent)).toEqual(["b2"]);
    expect((root.querySelector('[data-ref="empty"]') as HTMLElement).hidden).toBe(true);

    (root.querySelector('[data-square="a1"]') as HTMLButtonElement).click();
    expect(Array.from(root.querySelectorAll('[data-ref="moves"] li'), (n) => n.textContent)).toEqual(["b2", "a1"]);

    stop();
  });

  it("the mounted subregion is disposed with the island and leaves the server DOM intact", async () => {
    registerIsland("feature", (ctx) => {
      const feature = createFeature();
      ctx.on("@sq", "click", () => feature.play("x"));
      const history = mount(
        () =>
          ol(
            { "data-ref": "moves" },
            each(
              () => {
                feature.changed.track();
                return feature.engine.moves.map((move, i) => ({ id: i, move }));
              },
              (item) => li(() => item().move),
              { key: (item) => item.id },
            ),
          ),
        ctx.ref("@history") as HTMLElement,
      );
      ctx.cleanup(history.unmount);
    });

    serverPage();
    const stop = mountIslands(document);
    await flush();

    const root = islandAt(0);
    const footer = root.querySelector('[data-ref="server-footer"]');
    const squares = Array.from(root.querySelectorAll("[data-square]"));
    expect(root.querySelector('[data-ref="moves"]')).not.toBe(null);

    stop();

    // The mounted region is gone…
    expect(root.querySelector('[data-ref="moves"]')).toBe(null);
    // …and every server-rendered node around it is the SAME node, untouched.
    expect(root.querySelector('[data-ref="server-footer"]')).toBe(footer);
    expect(root.querySelector('[data-ref="empty"]')?.textContent).toBe("No moves yet.");
    expect(Array.from(root.querySelectorAll("[data-square]"))).toEqual(squares);
    expect(root.getAttribute("data-sibu-enhanced")).toBe(null);
  });

  it("removing the island root disposes the mounted subregion too", async () => {
    let listRuns = 0;
    registerIsland("feature", (ctx) => {
      const feature = createFeature();
      ctx.on("@sq", "click", () => feature.play("x"));
      const history = mount(
        () =>
          ol(
            each(
              () => {
                feature.changed.track();
                listRuns++;
                return feature.engine.moves.map((move, i) => ({ id: i, move }));
              },
              (item) => li(() => item().move),
              { key: (item) => item.id },
            ),
          ),
        ctx.ref("@history") as HTMLElement,
      );
      ctx.cleanup(history.unmount);
      // Expose the feature so the test can invalidate after removal.
      (ctx.root as unknown as { feature: ReturnType<typeof createFeature> }).feature = feature;
    });

    serverPage();
    mountIslands(document);
    await flush();

    const root = islandAt(0);
    const feature = (root as unknown as { feature: ReturnType<typeof createFeature> }).feature;
    const before = listRuns;

    dispose(root);
    root.remove();

    feature.engine.moves.push("y");
    feature.changed.invalidate();
    expect(listRuns).toBe(before); // the list binding is dead, not detached-and-live
  });

  it("disposal is idempotent across the island, the enhancement and the mount", async () => {
    let unmounts = 0;
    registerIsland("feature", (ctx) => {
      const history = mount(() => ol({ "data-ref": "moves" }), ctx.ref("@history") as HTMLElement);
      ctx.cleanup(() => {
        unmounts++;
        history.unmount();
      });
    });

    serverPage();
    const stop = mountIslands(document);
    await flush();
    const root = islandAt(0);

    stop();
    stop();
    dispose(root);
    expect(unmounts).toBe(1);
    expect(root.querySelector('[data-ref="moves"]')).toBe(null);
  });
});

describe("multiple instances stay isolated", () => {
  it("two islands on one page keep separate feature state", async () => {
    registerIsland("feature", (ctx) => {
      const feature = createFeature();
      ctx.text("@status", () => {
        feature.changed.track();
        return `${feature.engine.moves.length}`;
      });
      ctx.each<HTMLButtonElement>("@sq", (el) => ({
        on: { click: () => feature.play(el.dataset.square as string) },
      }));
      const history = mount(
        () =>
          ol(
            { "data-ref": "moves" },
            each(
              () => {
                feature.changed.track();
                return feature.engine.moves.map((move, i) => ({ id: i, move }));
              },
              (item) => li(() => item().move),
              { key: (item) => item.id },
            ),
          ),
        ctx.ref("@history") as HTMLElement,
      );
      ctx.cleanup(history.unmount);
    });

    serverPage(2);
    const stop = mountIslands(document);
    await flush();

    const a = islandAt(0);
    const b = islandAt(1);
    (a.querySelector('[data-square="a1"]') as HTMLButtonElement).click();
    (a.querySelector('[data-square="a2"]') as HTMLButtonElement).click();
    (b.querySelector('[data-square="b1"]') as HTMLButtonElement).click();

    expect(a.querySelector('[data-ref="status"]')?.textContent).toBe("2");
    expect(b.querySelector('[data-ref="status"]')?.textContent).toBe("1");
    expect(Array.from(a.querySelectorAll('[data-ref="moves"] li'), (n) => n.textContent)).toEqual(["a1", "a2"]);
    expect(Array.from(b.querySelectorAll('[data-ref="moves"] li'), (n) => n.textContent)).toEqual(["b1"]);

    stop();
  });

  it("a broken island beside a working one does not disturb it", async () => {
    const errors: unknown[] = [];
    vi.spyOn(console, "error").mockImplementation((...args) => errors.push(args));

    registerIsland("broken", () => {
      throw new Error("island exploded");
    });
    registerIsland("feature", (ctx) => {
      const feature = createFeature();
      ctx.text("@status", () => {
        feature.changed.track();
        return `${feature.engine.moves.length}`;
      });
      ctx.each<HTMLButtonElement>("@sq", (el) => ({
        on: { click: () => feature.play(el.dataset.square as string) },
      }));
      const history = mount(() => ol({ "data-ref": "moves" }), ctx.ref("@history") as HTMLElement);
      ctx.cleanup(history.unmount);
    });

    serverPage();
    document.body.insertAdjacentHTML(
      "afterbegin",
      `<section data-sibu-island="broken"><b data-ref="x">?</b></section>`,
    );

    const stop = mountIslands(document);
    await flush();

    const broken = document.querySelector('[data-sibu-island="broken"]') as HTMLElement;
    const working = document.querySelector('[data-sibu-island="feature"]') as HTMLElement;

    expect(broken.getAttribute("data-sibu-enhanced")).toBe(null);
    expect(working.getAttribute("data-sibu-enhanced")).toBe("true");
    (working.querySelector('[data-square="a1"]') as HTMLButtonElement).click();
    expect(working.querySelector('[data-ref="status"]')?.textContent).toBe("1");
    expect(errors.length).toBeGreaterThan(0);

    stop();
  });
});

describe("failure partway through composition", () => {
  it("a setup that throws AFTER mounting leaves nothing live", async () => {
    const errors: unknown[] = [];
    vi.spyOn(console, "error").mockImplementation((...args) => errors.push(args));
    let unmounted = false;

    registerIsland("feature", (ctx) => {
      ctx.text("@status", () => "wired");
      const history = mount(() => ol({ "data-ref": "moves" }), ctx.ref("@history") as HTMLElement);
      // Registering the undo BEFORE the risky work is what makes the mount part
      // of the transaction — `enhance` can only roll back what it was told about.
      ctx.cleanup(() => {
        unmounted = true;
        history.unmount();
      });
      throw new Error("later failure");
    });

    serverPage();
    const stop = mountIslands(document);
    await flush();

    const root = islandAt(0);
    expect(unmounted).toBe(true);
    expect(root.querySelector('[data-ref="moves"]')).toBe(null);
    expect(root.getAttribute("data-sibu-enhanced")).toBe(null);
    expect(errors.length).toBeGreaterThan(0);

    // Nothing claimed the root, so a fixed setup can mount it again.
    unregisterIsland("feature");
    registerIsland("feature", (ctx) => ctx.text("@status", () => "second attempt"));
    const stop2 = mountIslands(document);
    await flush();
    expect(root.querySelector('[data-ref="status"]')?.textContent).toBe("second attempt");

    stop();
    stop2();
  });

  it("a mount() failure is reported through the island error pipeline, not thrown at the caller", async () => {
    const errors: unknown[] = [];
    vi.spyOn(console, "error").mockImplementation((...args) => errors.push(args));

    registerIsland("feature", (ctx) => {
      // A missing container is the classic composition mistake.
      mount(() => ol(), ctx.ref("@does-not-exist"));
    });

    serverPage();
    const stop = mountIslands(document);
    await expect(flush()).resolves.toBeUndefined();

    expect(islandAt(0).getAttribute("data-sibu-enhanced")).toBe(null);
    expect(errors.length).toBeGreaterThan(0);
    stop();
  });

  it("a binding inside the mounted region reports with its own node, not the island root", async () => {
    const reports: Array<{ error: unknown; context: RuntimeErrorContext }> = [];
    setRuntimeErrorHandler((error, context) => reports.push({ error, context }));
    const [armed, setArmed] = signal(false);

    registerIsland("feature", (ctx) => {
      const history = mount(
        () =>
          ol(
            { "data-ref": "moves" },
            li(() => {
              if (armed()) throw new Error("row boom");
              return "row";
            }),
          ),
        ctx.ref("@history") as HTMLElement,
      );
      ctx.cleanup(history.unmount);
    });

    serverPage();
    const stop = mountIslands(document);
    await flush();

    setArmed(true);
    expect(reports).toHaveLength(1);
    expect((reports[0].error as Error).message).toBe("row boom");
    expect(reports[0].context.node).not.toBe(islandAt(0));

    stop();
  });
});

describe("remounting after host-rendered content changes", () => {
  it("the same markup can be mounted again after cleanup, with a fresh mounted region", async () => {
    let mounts = 0;
    registerIsland("feature", (ctx) => {
      mounts++;
      const history = mount(() => ol({ "data-ref": "moves" }), ctx.ref("@history") as HTMLElement);
      ctx.cleanup(history.unmount);
    });

    serverPage();
    const first = mountIslands(document);
    await flush();
    expect(mounts).toBe(1);
    expect(document.querySelectorAll('[data-ref="moves"]')).toHaveLength(1);

    first();
    expect(document.querySelectorAll('[data-ref="moves"]')).toHaveLength(0);

    const second = mountIslands(document);
    await flush();
    expect(mounts).toBe(2);
    // Exactly one mounted region — not two stacked in the same slot.
    expect(document.querySelectorAll('[data-ref="moves"]')).toHaveLength(1);

    second();
  });

  it("calling mountIslands() twice without cleanup does not double-mount the subregion", async () => {
    let mounts = 0;
    registerIsland("feature", (ctx) => {
      mounts++;
      const history = mount(() => ol({ "data-ref": "moves" }), ctx.ref("@history") as HTMLElement);
      ctx.cleanup(history.unmount);
    });

    serverPage();
    const a = mountIslands(document);
    await flush();
    const b = mountIslands(document);
    await flush();

    expect(mounts).toBe(1);
    expect(document.querySelectorAll('[data-ref="moves"]')).toHaveLength(1);

    a();
    b();
  });
});
