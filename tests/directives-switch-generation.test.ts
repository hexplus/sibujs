import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DirectiveTransition, match, when } from "../src/core/rendering/directives";
import { dispose, registerDisposer } from "../src/core/rendering/dispose";
import { div } from "../src/core/rendering/html";
import { signal } from "../src/core/signals/signal";

// ---------------------------------------------------------------------------
// A `when()` / `match()` switch publishes what its branch factory built only
// while that switch is still the latest one. The factory is application
// code: it may select another value itself, and the switch that write starts
// supersedes the one running the factory — whatever it renders, NOTHING
// included. The obsolete result is then disposed once (its lifecycle ends)
// and never inserted; the newer selection is what the page shows. An `out-in`
// build that waited for the leaves is held to the switch that deferred it.
//
// Where the switch itself runs the factory, the directive's binding is still
// running, so the write reaches it when that run ends: the switch is still
// the latest one when it publishes, and the re-run retires the result at
// once. The page ends the same either way, as these cases check per mode.
// ---------------------------------------------------------------------------

type Kind = "when" | "match";
type Mode = "none" | NonNullable<DirectiveTransition["mode"]>;
const MODES: Mode[] = ["none", "both", "in-out", "out-in"];

let host: HTMLElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
});

afterEach(() => {
  dispose(host);
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const flush = async (turns = 8) => {
  for (let i = 0; i < turns; i++) await Promise.resolve();
};

/** Settle every pending leave and enter, and every timer. */
async function settle(release: (() => void)[]) {
  for (let round = 0; round < 3; round++) {
    for (const r of release.splice(0)) r();
    await flush();
    vi.runAllTimers();
    await flush();
  }
}

/**
 * A directive (`kind`) over `sel`: "a" renders A, "b" runs `b`, "c" renders
 * `c` (a factory, or a bare element the caller holds), anything else renders
 * nothing. Leaves and enters (with a transition) stay pending until `release`.
 */
function setup(kind: Kind, mode: Mode, b: (setSel: (v: string) => void) => Node, c?: Node) {
  const [sel, setSel] = signal("a");
  const release: (() => void)[] = [];
  const pending = () => new Promise<void>((r) => release.push(r));
  const transition: DirectiveTransition | undefined =
    mode === "none" ? undefined : { mode, enter: pending, leave: pending };
  const options = { transition };
  const a = () => div({ class: "a" }, "A");
  const cBranch = c ?? (() => div({ class: "c" }, "C"));
  // `when`: "c" is the then-branch (as given: a factory or the bare element);
  // the others are distinct falsy values (a different value rebuilds) whose
  // else-factory renders A, runs B, or renders nothing.
  const falsy: Record<string, unknown> = { a: 0, b: "" };
  const anchor =
    kind === "when"
      ? when(
          () => (sel() === "c" ? "c" : sel() in falsy ? falsy[sel()] : null),
          cBranch,
          () => {
            const v = sel();
            return v === "a" ? a() : v === "b" ? b(setSel) : null;
          },
          options,
        )
      : match(sel, { a, b: () => b(setSel), c: cBranch }, options);
  host.append(anchor);
  return { setSel, release, anchor };
}

/** B's factory: selects `target`, then returns a node with a counted cleanup and binding. */
function stale(target: string) {
  const [n, setN] = signal(0);
  const rec = { built: 0, runs: 0, cleanup: vi.fn() };
  const factory = (setSel: (v: string) => void) => {
    rec.built++;
    setSel(target);
    const el = div({ class: "stale" }, () => {
      rec.runs++;
      return `stale-${n()}`;
    });
    registerDisposer(el, rec.cleanup);
    return el;
  };
  return { factory, setN, rec };
}

describe.each<Kind>([
  "when",
  "match",
])("%s(): a factory that selects another value supersedes its own switch", (kind) => {
  describe.each(MODES)("transition mode: %s", (mode) => {
    it("selecting an empty outcome: nothing is inserted, the obsolete node is disposed once", async () => {
      const b = stale("none");
      const t = setup(kind, mode, b.factory);
      await flush();
      expect(host.textContent).toBe("A");
      t.setSel("b");
      await settle(t.release);
      expect(b.rec.built).toBe(1);
      expect(host.querySelector(".stale")).toBeNull();
      expect(host.textContent).toBe("");
      expect(b.rec.cleanup).toHaveBeenCalledTimes(1);
      // Its lifecycle ended: its binding never runs again.
      const runs = b.rec.runs;
      b.setN(1);
      await flush();
      expect(b.rec.runs).toBe(runs);
      // The directive itself keeps switching.
      t.setSel("c");
      await settle(t.release);
      expect(host.textContent).toBe("C");
      expect(b.rec.cleanup).toHaveBeenCalledTimes(1);
    });

    it("control — selecting a nonempty outcome: that branch is shown, the obsolete node disposed once", async () => {
      const b = stale("c");
      const t = setup(kind, mode, b.factory);
      await flush();
      t.setSel("b");
      await settle(t.release);
      expect(host.querySelector(".stale")).toBeNull();
      expect(host.textContent).toBe("C");
      expect(b.rec.cleanup).toHaveBeenCalledTimes(1);
      const runs = b.rec.runs;
      b.setN(1);
      await flush();
      expect(b.rec.runs).toBe(runs);
    });

    it("a bare element the newer switch shows is the caller's: attached, never disposed", async () => {
      const [label, setLabel] = signal("bare");
      const bare = div({ class: "c" }, () => label());
      const bareCleanup = vi.fn();
      registerDisposer(bare, bareCleanup);
      const b = stale("c");
      const t = setup(kind, mode, b.factory, bare);
      await flush();
      t.setSel("b");
      await settle(t.release);
      expect(bare.parentNode).toBe(host);
      expect(host.textContent).toBe("bare");
      expect(b.rec.cleanup).toHaveBeenCalledTimes(1);
      // Detached again by the next switch, its bindings still running.
      t.setSel("none");
      await settle(t.release);
      expect(bare.parentNode).not.toBe(host);
      expect(bareCleanup).not.toHaveBeenCalled();
      setLabel("still live");
      await flush();
      expect(bare.textContent).toBe("still live");
      dispose(bare);
    });
  });

  it("out-in: a build deferred behind a leave is held to the switch that deferred it", async () => {
    // A's leave is pending when B is selected; B's build waits for it. When
    // the leave ends, B's factory selects nothing — that newer switch has
    // nothing left to wait for and renders nothing; B's result is obsolete.
    const b = stale("none");
    const t = setup(kind, "out-in", b.factory);
    await flush();
    t.setSel("b");
    await flush();
    expect(b.rec.built).toBe(0);
    expect(t.release.length).toBe(1);
    t.release.shift()?.();
    await flush();
    expect(b.rec.built).toBe(1);
    expect(host.textContent).toBe("");
    expect(b.rec.cleanup).toHaveBeenCalledTimes(1);
    // No enter was started for the obsolete branch.
    expect(t.release.length).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("out-in: the obsolete result is never inserted — a custom element in it is never connected", async () => {
    const tag = `x-generation-probe-${kind}`;
    let connected = 0;
    customElements.define(
      tag,
      class extends HTMLElement {
        connectedCallback() {
          connected++;
        }
      },
    );
    const cleanup = vi.fn();
    const t = setup(kind, "out-in", (setSel) => {
      setSel("none");
      const el = document.createElement(tag);
      registerDisposer(el, cleanup);
      return el;
    });
    await flush();
    t.setSel("b");
    await settle(t.release);
    expect(connected).toBe(0);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(host.textContent).toBe("");
  });

  it("out-in: a newer switch while the build waits replaces it — only the latest selection builds", async () => {
    const b = stale("none");
    const t = setup(kind, "out-in", b.factory);
    await flush();
    t.setSel("b");
    await flush();
    t.setSel("c");
    await settle(t.release);
    expect(b.rec.built).toBe(0);
    expect(host.textContent).toBe("C");
  });
});
