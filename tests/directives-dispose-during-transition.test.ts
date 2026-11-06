import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DirectiveTransition, match, when } from "../src/core/rendering/directives";
import { dispose, registerDisposer } from "../src/core/rendering/dispose";
import { button, div } from "../src/core/rendering/html";
import { signal } from "../src/core/signals/signal";

// ---------------------------------------------------------------------------
// Disposing a `when()` / `match()` is terminal, wherever it happens. A switch
// runs application code synchronously — a `leave` or `enter` callback, a
// cleanup of the outgoing branch, a `blur` handler, the branch factory — and
// any of it may dispose the directive. The teardown releases every branch the
// directive holds, once; the switch then builds no replacement, schedules no
// deferred build, restores no focus and starts no transition, and a phase
// that comes back after the disposal is cancelled at once — no timer is left.
// A promise settling afterwards restarts nothing.
// ---------------------------------------------------------------------------

type Kind = "when" | "match";
type Mode = NonNullable<DirectiveTransition["mode"]>;
const MODES: Mode[] = ["both", "out-in", "in-out"];

let host: HTMLElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  // Timers only: microtasks (first renders, promise settlement) stay real.
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

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * A directive (`kind`) switching between an "initial" and a "replacement"
 * branch on `visible`, each built by a counting factory whose root has a
 * counted cleanup. `transition` receives the anchor, for callbacks that
 * dispose it.
 */
function setup(kind: Kind, transition: (anchor: () => Comment) => DirectiveTransition) {
  const [visible, setVisible] = signal(true);
  const cleanups = { initial: vi.fn(), replacement: vi.fn() };
  const factory = (which: "initial" | "replacement") =>
    vi.fn(() => {
      const el = div({ class: which }, which);
      registerDisposer(el, cleanups[which]);
      return el;
    });
  const initial = factory("initial");
  const replacement = factory("replacement");
  let anchor!: Comment;
  const options = { transition: transition(() => anchor) };
  anchor =
    kind === "when"
      ? when(visible, initial, replacement, options)
      : match(() => (visible() ? "a" : "b"), { a: initial, b: replacement }, options);
  host.append(anchor);
  return { setVisible, initial, replacement, cleanups, anchor: () => anchor };
}

/** Nothing of the directive is left: no branch content, no timer. */
function expectReleased(baseTimers: number) {
  expect(host.children.length).toBe(0);
  expect(vi.getTimerCount()).toBe(baseTimers);
}

describe.each<Kind>(["when", "match"])("%s()", (kind) => {
  describe.each(MODES)("mode %s", (mode) => {
    it("a pending leave that disposes the directive: no replacement, nothing left", async () => {
      const gate = deferred();
      const t = setup(kind, (anchor) => ({
        mode,
        leave: () => {
          dispose(anchor());
          return gate.promise;
        },
      }));
      await flush();
      const base = vi.getTimerCount();
      t.setVisible(false);
      // At once: the phase that came back after the disposal was cancelled.
      expectReleased(base);
      expect(t.cleanups.initial).toHaveBeenCalledTimes(1);
      // `in-out` builds the replacement first, and leaves after its enter:
      // the teardown released it then, once.
      if (mode === "in-out") {
        expect(t.replacement).toHaveBeenCalledTimes(1);
        expect(t.cleanups.replacement).toHaveBeenCalledTimes(1);
      } else expect(t.replacement).not.toHaveBeenCalled();
      gate.resolve();
      await flush();
      vi.runAllTimers();
      await flush();
      expectReleased(base);
      expect(t.replacement).toHaveBeenCalledTimes(mode === "in-out" ? 1 : 0);
      expect(t.cleanups.initial).toHaveBeenCalledTimes(1);
      expect(t.cleanups.replacement).toHaveBeenCalledTimes(mode === "in-out" ? 1 : 0);
    });

    it("a synchronous leave that disposes the directive and returns nothing: no replacement", async () => {
      const t = setup(kind, (anchor) => ({
        mode,
        leave: () => {
          dispose(anchor());
        },
      }));
      await flush();
      const base = vi.getTimerCount();
      t.setVisible(false);
      await flush();
      expectReleased(base);
      expect(t.cleanups.initial).toHaveBeenCalledTimes(1);
      expect(t.replacement).toHaveBeenCalledTimes(mode === "in-out" ? 1 : 0);
      expect(t.cleanups.replacement).toHaveBeenCalledTimes(mode === "in-out" ? 1 : 0);
    });

    it("a leave rejected after the disposal restarts nothing", async () => {
      const gate = deferred();
      const t = setup(kind, (anchor) => ({
        mode,
        leave: () => {
          dispose(anchor());
          return gate.promise;
        },
      }));
      await flush();
      const base = vi.getTimerCount();
      t.setVisible(false);
      gate.reject(new Error("leave failed"));
      await flush();
      vi.runAllTimers();
      await flush();
      expectReleased(base);
      expect(t.cleanups.initial).toHaveBeenCalledTimes(1);
      expect(t.replacement).toHaveBeenCalledTimes(mode === "in-out" ? 1 : 0);
    });

    it("an appear enter that disposes the directive leaves no timer; its settlement does nothing", async () => {
      const gate = deferred();
      const enter = vi.fn();
      const t = setup(kind, (anchor) => ({
        mode,
        appear: true,
        enter: () => {
          enter();
          dispose(anchor());
          return gate.promise;
        },
      }));
      const base = vi.getTimerCount();
      await flush();
      expect(enter).toHaveBeenCalledTimes(1);
      expectReleased(base);
      expect(t.cleanups.initial).toHaveBeenCalledTimes(1);
      gate.resolve();
      await flush();
      t.setVisible(false);
      await flush();
      expectReleased(base);
      expect(enter).toHaveBeenCalledTimes(1);
      expect(t.replacement).not.toHaveBeenCalled();
    });

    it("an enter on a switch that disposes the directive releases both branches once", async () => {
      const gate = deferred();
      const t = setup(kind, (anchor) => ({
        mode,
        leave: () => gate.promise,
        enter: () => {
          dispose(anchor());
          return new Promise<void>(() => {});
        },
      }));
      await flush();
      const base = vi.getTimerCount();
      t.setVisible(false);
      if (mode === "out-in") {
        // Built only once the leave ends.
        expect(t.replacement).not.toHaveBeenCalled();
        gate.resolve();
        await flush();
      }
      expect(t.replacement).toHaveBeenCalledTimes(1);
      expectReleased(base);
      expect(t.cleanups.initial).toHaveBeenCalledTimes(1);
      expect(t.cleanups.replacement).toHaveBeenCalledTimes(1);
      gate.resolve();
      await flush();
      vi.runAllTimers();
      await flush();
      expectReleased(base);
      expect(t.replacement).toHaveBeenCalledTimes(1);
    });

    it("a cleanup of the outgoing branch that disposes the directive: no replacement", async () => {
      const t = setup(kind, () => ({ mode }));
      t.cleanups.initial.mockImplementation(() => dispose(t.anchor()));
      await flush();
      const base = vi.getTimerCount();
      t.setVisible(false);
      await flush();
      expectReleased(base);
      expect(t.cleanups.initial).toHaveBeenCalledTimes(1);
      expect(t.replacement).toHaveBeenCalledTimes(mode === "in-out" ? 1 : 0);
      expect(t.cleanups.replacement).toHaveBeenCalledTimes(mode === "in-out" ? 1 : 0);
    });

    it("every leaving branch is released once when a later leave disposes the directive", async () => {
      let disposeOnLeave = false;
      const t = setup(kind, (anchor) => ({
        mode: mode === "out-in" ? "both" : mode,
        leave: () => {
          if (disposeOnLeave) dispose(anchor());
          return new Promise<void>(() => {});
        },
      }));
      await flush();
      const base = vi.getTimerCount();
      t.setVisible(false);
      t.setVisible(true);
      await flush();
      // Two branches: the first initial still leaving, the replacement leaving.
      disposeOnLeave = true;
      t.setVisible(false);
      await flush();
      expectReleased(base);
      expect(t.cleanups.initial).toHaveBeenCalledTimes(2);
      expect(t.cleanups.replacement).toHaveBeenCalledTimes(t.replacement.mock.calls.length);
    });
  });

  it("a replacement factory that disposes the directive: its branch is released once, never inserted", async () => {
    const t = setup(kind, () => ({}));
    t.replacement.mockImplementation(() => {
      dispose(t.anchor());
      const el = div({ class: "replacement" }, "replacement");
      registerDisposer(el, t.cleanups.replacement);
      return el;
    });
    await flush();
    const base = vi.getTimerCount();
    t.setVisible(false);
    await flush();
    expectReleased(base);
    expect(t.cleanups.initial).toHaveBeenCalledTimes(1);
    expect(t.cleanups.replacement).toHaveBeenCalledTimes(1);
  });

  it("disposing while an out-in build waits for the leave: the build never runs", async () => {
    const gate = deferred();
    const t = setup(kind, () => ({ mode: "out-in", leave: () => gate.promise }));
    await flush();
    const base = vi.getTimerCount();
    t.setVisible(false);
    dispose(t.anchor());
    expectReleased(base);
    gate.resolve();
    await flush();
    vi.runAllTimers();
    await flush();
    expectReleased(base);
    expect(t.replacement).not.toHaveBeenCalled();
    expect(t.cleanups.initial).toHaveBeenCalledTimes(1);
  });

  it("a blur handler that disposes the directive while the branch turns inert leaves no attribute behind", async () => {
    const [visible, setVisible] = signal(true);
    const replacement = vi.fn(() => div("replacement"));
    const cleanup = vi.fn();
    let anchor!: Comment;
    let field!: HTMLButtonElement;
    anchor =
      kind === "when"
        ? when(
            visible,
            () => {
              field = button("focus me") as HTMLButtonElement;
              registerDisposer(field, cleanup);
              return field;
            },
            replacement,
            { transition: { leave: () => new Promise<void>(() => {}) } },
          )
        : match(
            () => (visible() ? "a" : "b"),
            {
              a: () => {
                field = button("focus me") as HTMLButtonElement;
                registerDisposer(field, cleanup);
                return field;
              },
              b: replacement,
            },
            { transition: { leave: () => new Promise<void>(() => {}) } },
          );
    host.append(anchor);
    await flush();
    field.addEventListener("blur", () => dispose(anchor));
    field.focus();
    expect(document.activeElement).toBe(field);
    vi.advanceTimersByTime(0);
    const base = vi.getTimerCount();
    setVisible(false);
    await flush();
    // jsdom's own `selectionchange` (0 ms), armed by the blur; a leave's
    // timer runs for seconds and would still be counted.
    vi.advanceTimersByTime(0);
    expectReleased(base);
    expect(replacement).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(field.hasAttribute("inert")).toBe(false);
    expect(field.hasAttribute("aria-hidden")).toBe(false);
  });
});

describe("the control: application code that switches instead of disposing", () => {
  it.each(MODES)("an appear enter that changes its own condition reaches the final branch (mode %s)", async (mode) => {
    const [visible, setVisible] = signal(true);
    const anchor = when(
      visible,
      () => div({ class: "a" }, "a"),
      () => div({ class: "b" }, "b"),
      {
        transition: {
          mode,
          appear: true,
          enter: (nodes) => {
            if ((nodes[0] as Element).className === "a") setVisible(false);
          },
        },
      },
    );
    host.append(anchor);
    await flush();
    vi.runAllTimers();
    await flush();
    expect(host.querySelector(".b")).not.toBeNull();
    expect(host.querySelector(".a")).toBeNull();
    dispose(anchor);
    expect(host.children.length).toBe(0);
  });
});
