import { afterEach, describe, expect, it, vi } from "vitest";
import { checkLeaks, dispose } from "../src/core/rendering/dispose";
import { focus } from "../src/ui/a11y";
import { createListbox } from "../src/ui/a11yPrimitives";
import { hover } from "../src/ui/hover";

// ---------------------------------------------------------------------------
// Manually disposing a DOM helper releases its node-level registration.
//
// THE DEFECT: `hover()`, `focus().bind()` and `createListbox()` registered their
// cleanup with the node AND returned it for manual disposal, but the manual path
// never called `unregisterDisposer()`. Each attach/dispose cycle on a long-lived
// element left one dead closure behind: `checkLeaks()` kept counting it, the
// captured state stayed retained, and the final `dispose(node)` re-ran every
// historical cleanup.
// ---------------------------------------------------------------------------

const CYCLES = 50;

interface Helper {
  name: string;
  /** Attach the helper to `el` and return its manual disposer. */
  attach: (el: HTMLElement) => () => void;
  /** Listener types the helper removes on cleanup. */
  events: string[];
}

const HELPERS: Helper[] = [
  { name: "hover()", attach: (el) => hover(el).dispose, events: ["pointerenter", "pointerleave"] },
  { name: "focus().bind()", attach: (el) => focus().bind(el), events: ["focus", "blur"] },
  { name: "createListbox()", attach: (el) => createListbox(el).dispose, events: ["keydown", "click"] },
];

let el: HTMLElement | null = null;

afterEach(() => {
  if (el) dispose(el);
  el?.remove();
  el = null;
  vi.restoreAllMocks();
});

for (const helper of HELPERS) {
  describe(`${helper.name} manual disposal`, () => {
    it("returns the active binding count to its original value after repeated cycles", () => {
      el = document.createElement("div");
      document.body.appendChild(el);
      const before = checkLeaks();

      for (let i = 0; i < CYCLES; i++) {
        const release = helper.attach(el);
        expect(checkLeaks()).toBe(before + 1);
        release();
        expect(checkLeaks()).toBe(before);
      }
    });

    it("final dispose(node) does not re-run historical cleanups", () => {
      el = document.createElement("div");
      document.body.appendChild(el);
      for (let i = 0; i < CYCLES; i++) helper.attach(el)();

      const removeSpy = vi.spyOn(el, "removeEventListener");
      dispose(el);

      expect(removeSpy).not.toHaveBeenCalled();
    });

    it("final dispose(node) still releases a binding that was never manually disposed", () => {
      el = document.createElement("div");
      document.body.appendChild(el);
      for (let i = 0; i < 3; i++) helper.attach(el)();
      const before = checkLeaks();
      helper.attach(el);
      expect(checkLeaks()).toBe(before + 1);

      const removeSpy = vi.spyOn(el, "removeEventListener");
      dispose(el);

      expect(checkLeaks()).toBe(before);
      expect(removeSpy.mock.calls.map((c) => c[0]).sort()).toEqual([...helper.events].sort());
    });

    it("manual disposal is idempotent and safe after dispose(node)", () => {
      el = document.createElement("div");
      document.body.appendChild(el);
      const before = checkLeaks();
      const release = helper.attach(el);

      dispose(el);
      expect(checkLeaks()).toBe(before);

      const removeSpy = vi.spyOn(el, "removeEventListener");
      release();
      release();
      expect(removeSpy).not.toHaveBeenCalled();
      expect(checkLeaks()).toBe(before);
    });
  });
}
