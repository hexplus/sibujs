import { afterEach, describe, expect, it, vi } from "vitest";
import { checkLeaks, dispose } from "../src/core/rendering/dispose";
import { FocusTrap } from "../src/ui/a11y";

// ---------------------------------------------------------------------------
// FocusTrap disposed before its queued microtasks run.
//
// THE DEFECT: FocusTrap queues observer attachment and autofocus as microtasks.
// `dispose(trap)` does not detach the element, so `container.isConnected` stays
// true, but the disposer had already set `trapObserver = null` — the queued
// `trapObserver!.observe(...)` then threw an uncaught TypeError. The autofocus
// microtask had no lifetime check at all and could move focus into a trap that
// was already torn down.
// ---------------------------------------------------------------------------

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

/** A button jsdom treats as visible, so FocusTrap's autofocus can select it. */
function visibleButton(label: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  Object.defineProperty(b, "offsetParent", { get: () => document.body, configurable: true });
  b.getClientRects = () => [{}] as unknown as DOMRectList;
  return b;
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("FocusTrap disposed before its microtasks run", () => {
  it("throws nothing, attaches no observer, and keeps focus where it was", async () => {
    const before = visibleButton("outside");
    document.body.appendChild(before);
    before.focus();
    expect(document.activeElement).toBe(before);

    const observeSpy = vi.spyOn(MutationObserver.prototype, "observe");
    const inner = document.createElement("div");
    const insideButton = visibleButton("inside");
    inner.appendChild(insideButton);

    const trap = FocusTrap(inner);
    document.body.appendChild(trap);
    dispose(trap);

    // An uncaught error in a microtask fails the test run on its own; flushing
    // here makes the queued callbacks run inside this test.
    await flush();

    expect(trap.isConnected).toBe(true);
    expect(observeSpy).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(before);
  });

  it("does not autofocus when restoreFocus is off either", async () => {
    const before = visibleButton("outside");
    document.body.appendChild(before);
    before.focus();

    const inner = document.createElement("div");
    inner.appendChild(visibleButton("inside"));
    const trap = FocusTrap(inner, { restoreFocus: false });
    document.body.appendChild(trap);
    dispose(trap);
    await flush();

    expect(document.activeElement).toBe(before);
  });

  it("still autofocuses and observes a live, connected trap", async () => {
    const before = visibleButton("outside");
    document.body.appendChild(before);
    before.focus();
    const observeSpy = vi.spyOn(MutationObserver.prototype, "observe");

    const inner = document.createElement("div");
    const insideButton = visibleButton("inside");
    inner.appendChild(insideButton);
    const trap = FocusTrap(inner);
    document.body.appendChild(trap);
    await flush();

    expect(observeSpy).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(insideButton);

    dispose(trap);
    expect(document.activeElement).toBe(before);
  });

  it("cleanup is idempotent: focus is restored once and the registration is released", async () => {
    const before = visibleButton("outside");
    document.body.appendChild(before);
    before.focus();
    const baseline = checkLeaks();

    const inner = document.createElement("div");
    inner.appendChild(visibleButton("inside"));
    const trap = FocusTrap(inner);
    document.body.appendChild(trap);
    await flush();

    const focusSpy = vi.spyOn(before, "focus");
    // Removal is observed through a subtree mutation after disconnect.
    trap.remove();
    inner.appendChild(document.createElement("span"));
    await flush();
    dispose(trap);
    dispose(trap);

    expect(focusSpy.mock.calls.length).toBeLessThanOrEqual(1);
    expect(checkLeaks()).toBe(baseline);
  });
});
