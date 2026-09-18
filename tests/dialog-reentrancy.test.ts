import { afterEach, describe, expect, it } from "vitest";
import { effect } from "../src/core/signals/effect";
import { __resetDialogStack, dialog } from "../src/ui/dialog";

// ---------------------------------------------------------------------------
// dialog() keeps `isOpen`, global stack membership, and the global Escape
// listener in sync under reactive reentrancy and after disposal.
//
// THE DEFECT: `open()` published `isOpen = true` before pushing onto the stack.
// Subscribers run synchronously, so an effect that closed the dialog on open
// ran `close()` before the push; `open()` then pushed an already-closed "ghost"
// entry, left the keydown listener attached, and a later Escape targeted it.
// `dispose()` had no terminal flag, so a stale `open()`/`toggle()` re-attached
// the destroyed controller.
// ---------------------------------------------------------------------------

type DialogState = { stack: unknown[]; listenerAttached: boolean };
const state = (): DialogState => (globalThis as unknown as Record<symbol, DialogState>)[Symbol.for("sibujs.dialog.v1")];

const pressEscape = () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

const stops: Array<() => void> = [];

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  __resetDialogStack();
});

describe("dialog reentrancy", () => {
  it("an effect that closes the dialog as it opens leaves no ghost stack entry", () => {
    const d = dialog();
    stops.push(
      effect(() => {
        if (d.isOpen()) d.close();
      }),
    );

    d.open();

    expect(d.isOpen()).toBe(false);
    expect(state().stack).toHaveLength(0);
    expect(state().listenerAttached).toBe(false);
  });

  it("a ghost entry cannot swallow Escape meant for the real top dialog", () => {
    const base = dialog();
    const autoClosing = dialog();
    stops.push(
      effect(() => {
        if (autoClosing.isOpen()) autoClosing.close();
      }),
    );

    base.open();
    autoClosing.open();
    expect(state().stack).toHaveLength(1);

    pressEscape();
    expect(base.isOpen()).toBe(false);
    expect(state().stack).toHaveLength(0);
    expect(state().listenerAttached).toBe(false);
  });

  it("an effect that reopens the dialog as it closes keeps it on the stack", () => {
    const d = dialog();
    let armed = false;
    let reopened = false;
    stops.push(
      effect(() => {
        if (!d.isOpen() && armed && !reopened) {
          reopened = true;
          d.open();
        }
      }),
    );

    d.open();
    armed = true;
    d.close();

    expect(reopened).toBe(true);
    expect(d.isOpen()).toBe(true);
    expect(state().stack).toHaveLength(1);
    expect(state().listenerAttached).toBe(true);

    pressEscape();
    expect(d.isOpen()).toBe(false);
    expect(state().stack).toHaveLength(0);
    expect(state().listenerAttached).toBe(false);
  });
});

describe("dialog disposal is terminal", () => {
  it("open() after dispose() is a no-op", () => {
    const d = dialog();
    d.open();
    d.dispose();

    d.open();

    expect(d.isOpen()).toBe(false);
    expect(state().stack).toHaveLength(0);
    expect(state().listenerAttached).toBe(false);
  });

  it("toggle() after dispose() is a no-op", () => {
    const d = dialog();
    d.dispose();

    d.toggle();

    expect(d.isOpen()).toBe(false);
    expect(state().stack).toHaveLength(0);
    expect(state().listenerAttached).toBe(false);
  });

  it("an effect that reopens on close cannot revive a disposed dialog", () => {
    const d = dialog();
    let armed = false;
    stops.push(
      effect(() => {
        if (!d.isOpen() && armed) d.open();
      }),
    );
    d.open();
    armed = true;

    d.dispose();

    expect(d.isOpen()).toBe(false);
    expect(state().stack).toHaveLength(0);
    expect(state().listenerAttached).toBe(false);
  });
});
