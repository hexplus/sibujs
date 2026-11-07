import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DirectiveTransition, match, when } from "../src/core/rendering/directives";
import { dispose } from "../src/core/rendering/dispose";
import { div } from "../src/core/rendering/html";
import { signal } from "../src/core/signals/signal";

// ---------------------------------------------------------------------------
// Every enter and leave a `when()` / `match()` plays has an identity of its
// own, valid until the phase is cancelled, replaced, released or superseded.
// Its completion checks it BEFORE touching anything: an obsolete enter —
// completing synchronously from inside its own callback after that callback
// switched the directive, or settling later — clears no phase handle (the
// branch may hold a newer one, its leave) and starts no `in-out` leave (the
// newer enter sequences those). Valid completions, synchronous or not, still
// end the phase and start what waited for it, once.
// ---------------------------------------------------------------------------

type Kind = "when" | "match";
type Mode = NonNullable<DirectiveTransition["mode"]>;

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

const classOf = (nodes: Node[]) => (nodes[0] as Element | undefined)?.className;

/** A directive (`kind`) rendering A for "a" and B for "b". */
function setup(kind: Kind, transition: DirectiveTransition) {
  const [sel, setSel] = signal("a");
  const a = () => div({ class: "a" }, "A");
  const b = () => div({ class: "b" }, "B");
  const anchor =
    kind === "when" ? when(() => sel() === "a", a, b, { transition }) : match(sel, { a, b }, { transition });
  return { sel, setSel, anchor };
}

/**
 * Transition callbacks: A's enter (on appear) selects B synchronously, then
 * returns `aEnterResult()`; every other enter and every leave stays pending
 * until resolved through `enters` / `leaves`.
 */
function interrupting(mode: Mode, aEnterResult: () => Promise<void> | undefined = () => undefined) {
  const enters: Record<string, () => void> = {};
  const leaves: Record<string, () => void> = {};
  let setSel!: (v: string) => void;
  const enter = vi.fn((nodes: Node[]) => {
    const which = classOf(nodes) as string;
    if (which === "a" && enter.mock.calls.length === 1) {
      setSel("b");
      return aEnterResult();
    }
    return new Promise<void>((r) => (enters[which] = r));
  });
  const leave = vi.fn((nodes: Node[]) => new Promise<void>((r) => (leaves[classOf(nodes) as string] = r)));
  const transition: DirectiveTransition = { mode, appear: true, enter, leave };
  return { transition, enter, leave, enters, leaves, bind: (s: (v: string) => void) => (setSel = s) };
}

describe.each<Kind>(["when", "match"])("%s(): an enter that switches the directive from its own callback", (kind) => {
  it("in-out: the outgoing leave waits for B's enter, and starts once when it resolves", async () => {
    const p = interrupting("in-out");
    const t = setup(kind, p.transition);
    p.bind(t.setSel);
    const base = vi.getTimerCount();
    host.append(t.anchor);
    await flush();
    expect(p.enter).toHaveBeenCalledTimes(2);
    expect(classOf(p.enter.mock.calls[1][0])).toBe("b");
    // A's obsolete completion started nothing: B's enter is still pending.
    expect(p.leave).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    await flush();
    expect(p.leave).not.toHaveBeenCalled();
    p.enters.b();
    await flush();
    expect(p.leave).toHaveBeenCalledTimes(1);
    expect(classOf(p.leave.mock.calls[0][0])).toBe("a");
    p.leaves.a();
    await flush();
    expect(host.textContent).toBe("B");
    expect(p.leave).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(base);
  });

  it("both: A's new leave keeps its handle — disposal cancels the installed enter and leave at once", async () => {
    const p = interrupting("both");
    const t = setup(kind, p.transition);
    p.bind(t.setSel);
    const base = vi.getTimerCount();
    host.append(t.anchor);
    await flush();
    expect(p.enter).toHaveBeenCalledTimes(2);
    expect(p.leave).toHaveBeenCalledTimes(1);
    // B's enter and A's leave are both running, each with its timer cap.
    expect(vi.getTimerCount()).toBe(base + 2);
    dispose(t.anchor);
    expect(vi.getTimerCount()).toBe(base);
    expect(host.children.length).toBe(0);
    // Settling afterwards revives nothing.
    p.enters.b();
    p.leaves.a();
    await flush();
    vi.runAllTimers();
    await flush();
    expect(p.enter).toHaveBeenCalledTimes(2);
    expect(p.leave).toHaveBeenCalledTimes(1);
    expect(host.children.length).toBe(0);
    expect(vi.getTimerCount()).toBe(base);
  });

  it("both: A's leave still ends normally when it resolves; B's enter completes on its own", async () => {
    const p = interrupting("both");
    const t = setup(kind, p.transition);
    p.bind(t.setSel);
    const base = vi.getTimerCount();
    host.append(t.anchor);
    await flush();
    p.leaves.a();
    await flush();
    expect(host.querySelector(".a")).toBeNull();
    expect(vi.getTimerCount()).toBe(base + 1);
    p.enters.b();
    await flush();
    expect(host.textContent).toBe("B");
    expect(vi.getTimerCount()).toBe(base);
  });

  it("out-in: A leaves first, then B builds and enters", async () => {
    const p = interrupting("out-in");
    const t = setup(kind, p.transition);
    p.bind(t.setSel);
    const base = vi.getTimerCount();
    host.append(t.anchor);
    await flush();
    expect(p.leave).toHaveBeenCalledTimes(1);
    expect(p.enter).toHaveBeenCalledTimes(1);
    expect(host.querySelector(".b")).toBeNull();
    p.leaves.a();
    await flush();
    expect(p.enter).toHaveBeenCalledTimes(2);
    expect(host.textContent).toBe("B");
    p.enters.b();
    await flush();
    expect(vi.getTimerCount()).toBe(base);
  });

  it.each<Mode>([
    "both",
    "in-out",
    "out-in",
  ])("%s: an enter that switched and returned a promise is cancelled — its settlement changes nothing", async (mode) => {
    let settleA!: () => void;
    const p = interrupting(mode, () => new Promise<void>((r) => (settleA = r)));
    const t = setup(kind, p.transition);
    p.bind(t.setSel);
    const base = vi.getTimerCount();
    host.append(t.anchor);
    await flush();
    const leaves = p.leave.mock.calls.length;
    const enters = p.enter.mock.calls.length;
    settleA();
    await flush();
    expect(p.leave).toHaveBeenCalledTimes(leaves);
    expect(p.enter).toHaveBeenCalledTimes(enters);
    // Whatever runs is still cancellable: disposal clears every timer.
    dispose(t.anchor);
    expect(vi.getTimerCount()).toBe(base);
  });
});

describe.each<Kind>(["when", "match"])("%s(): valid completions are unchanged", (kind) => {
  it("in-out: a synchronous enter starts the outgoing leave at once, once", async () => {
    const enter = vi.fn(() => undefined);
    const leave = vi.fn(() => new Promise<void>(() => {}));
    const t = setup(kind, { mode: "in-out", enter, leave });
    host.append(t.anchor);
    await flush();
    t.setSel("b");
    expect(enter).toHaveBeenCalledTimes(1);
    expect(leave).toHaveBeenCalledTimes(1);
    await flush();
    expect(leave).toHaveBeenCalledTimes(1);
  });

  it("in-out: an asynchronous enter starts the outgoing leave when it resolves, once", async () => {
    let done!: () => void;
    const enter = vi.fn(() => new Promise<void>((r) => (done = r)));
    const leave = vi.fn(() => undefined);
    const t = setup(kind, { mode: "in-out", enter, leave });
    host.append(t.anchor);
    await flush();
    t.setSel("b");
    await flush();
    expect(leave).not.toHaveBeenCalled();
    done();
    await flush();
    expect(leave).toHaveBeenCalledTimes(1);
    expect(host.textContent).toBe("B");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("both: an appear enter that completes synchronously leaves no phase behind", async () => {
    const enter = vi.fn(() => undefined);
    const t = setup(kind, { mode: "both", appear: true, enter });
    host.append(t.anchor);
    await flush();
    expect(enter).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    t.setSel("b");
    await flush();
    expect(enter).toHaveBeenCalledTimes(2);
    expect(host.textContent).toBe("B");
  });
});
