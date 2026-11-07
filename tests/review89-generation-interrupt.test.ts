import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DirectiveTransition, match, when } from "../src/core/rendering/directives";
import { dispose, registerDisposer } from "../src/core/rendering/dispose";
import { div } from "../src/core/rendering/html";
import { signal } from "../src/core/signals/signal";

type Kind = "when" | "match";
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

describe.each<Kind>(["when", "match"])("1. %s: generation", (kind) => {
  it.each(["none", "c"])("out-in: B's factory selects %s", async (target) => {
    let releaseLeave!: () => void;
    const staleCleanup = vi.fn();
    let setSel!: (v: string) => void;
    const [sel, set] = signal("a");
    setSel = set;
    const b = () => {
      setSel(target);
      const el = div({ class: "stale" }, "stale");
      registerDisposer(el, staleCleanup);
      return el;
    };
    const transition: DirectiveTransition = {
      mode: "out-in",
      leave: () => new Promise<void>((r) => (releaseLeave = r)),
    };
    const a = () => div({ class: "a" }, "A");
    const c = () => div({ class: "c" }, "C");
    const anchor =
      kind === "when"
        ? when(
            () => (sel() === "none" ? "" : sel()),
            () => {
              const v = sel();
              return v === "a" ? a() : v === "b" ? b() : c();
            },
            { transition },
          )
        : match(sel, { a, b, c }, { transition });
    host.append(anchor);
    await flush();
    expect(host.textContent).toBe("A");
    setSel("b");
    await flush();
    releaseLeave();
    await flush();
    vi.runAllTimers();
    await flush();
    expect(host.textContent).toBe(target === "c" ? "C" : "");
    expect(staleCleanup).toHaveBeenCalledTimes(1);
  });
});

describe.each<Kind>(["when", "match"])("2. %s: phase identity", (kind) => {
  it.each(["in-out", "both"] as const)("appear enter of A selects B synchronously (%s)", async (mode) => {
    const [sel, setSel] = signal("a");
    let resolveB!: () => void;
    const enter = vi.fn((nodes: Node[]) => {
      if ((nodes[0] as Element).className === "a") {
        setSel("b");
        return undefined;
      }
      return new Promise<void>((r) => (resolveB = r));
    });
    const leave = vi.fn(() => new Promise<void>(() => {}));
    const transition: DirectiveTransition = { mode, appear: true, enter, leave };
    const a = () => div({ class: "a" }, "A");
    const b = () => div({ class: "b" }, "B");
    const anchor =
      kind === "when" ? when(() => sel() === "a", a, b, { transition }) : match(sel, { a, b }, { transition });
    const base = vi.getTimerCount();
    host.append(anchor);
    await flush();
    expect(enter).toHaveBeenCalledTimes(2);
    if (mode === "in-out") {
      expect(leave).not.toHaveBeenCalled();
      resolveB();
      await flush();
      expect(leave).toHaveBeenCalledTimes(1);
    } else {
      expect(leave).toHaveBeenCalledTimes(1);
    }
    dispose(anchor);
    expect(vi.getTimerCount()).toBe(base);
  });
});
