/**
 * DOM ownership across documents and realms.
 *
 * Where the owning document of an input is known, the framework uses THAT
 * document (and its window), and where a node from another realm is a
 * legitimate input, it is recognized by `nodeType` rather than by this realm's
 * constructors. The fixture is an iframe: its document and window, and the
 * constructors behind every node it creates, are a second realm.
 *
 * Invariants under test:
 *  - `KeepAlive` wraps a foreign-realm fragment like a local one, so its
 *    children stay one cached branch whose bindings survive detach/re-attach
 *    and are disposed exactly once with the KeepAlive.
 *  - `svgElement` appends a foreign-realm child (adopting it) instead of
 *    silently dropping it; native `appendChild` still rejects a look-alike.
 *  - `clickOutside` listens on the element's own document, and removes the
 *    listener from that same document.
 *  - `trapFocus` reads the focused element of the element's own document.
 *  - `keyboard({ target })` clears stuck keys on the blur of the target's own
 *    window, and removes that listener on dispose.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { keyboard } from "../src/browser/keyboard";
import { clickOutside, trapFocus } from "../src/core/rendering/action";
import { dispose, registerDisposer } from "../src/core/rendering/dispose";
import { KeepAlive } from "../src/core/rendering/keepAlive";
import { effect } from "../src/core/signals/effect";
import { signal } from "../src/core/signals/signal";
import { svgElement } from "../src/platform/customElement";

const SVG_NS = "http://www.w3.org/2000/svg";

type ForeignWindow = Window & typeof globalThis;

describe("cross-realm DOM ownership", () => {
  let frame: HTMLIFrameElement;
  let fw: ForeignWindow;
  let fd: Document;

  beforeEach(() => {
    frame = document.createElement("iframe");
    document.body.appendChild(frame);
    fw = frame.contentWindow as ForeignWindow;
    fd = frame.contentDocument as Document;
  });

  afterEach(() => {
    frame.remove();
  });

  it("the fixture is a second realm", () => {
    const frag = fd.createDocumentFragment();
    expect(fw.DocumentFragment).not.toBe(DocumentFragment);
    expect(frag instanceof DocumentFragment).toBe(false);
    expect(frag instanceof Node).toBe(false);
  });

  describe("KeepAlive", () => {
    it("caches a foreign-realm fragment as one branch and disposes it exactly once", async () => {
      const container = document.createElement("div");
      document.body.appendChild(container);
      const [tab, setTab] = signal("a");
      const [label, setLabel] = signal("one");
      let disposals = 0;
      let builds = 0;

      const anchor = KeepAlive(tab, {
        a: () => {
          builds++;
          const frag = fd.createDocumentFragment();
          const first = fd.createElement("span");
          const second = fd.createElement("span");
          second.textContent = "second";
          frag.append(first, second);
          const stop = effect(() => {
            first.textContent = label();
          });
          registerDisposer(first, () => {
            stop();
            disposals++;
          });
          return frag;
        },
        b: () => document.createElement("p"),
      });
      container.appendChild(anchor);
      await Promise.resolve();

      const spans = () => Array.from(container.querySelectorAll("span")).map((s) => s.textContent);
      expect(spans()).toEqual(["one", "second"]);

      setTab("b");
      expect(spans()).toEqual([]);
      // Detached, not disposed: the binding is still live while cached.
      setLabel("two");
      expect(disposals).toBe(0);

      setTab("a");
      expect(builds).toBe(1);
      expect(spans()).toEqual(["two", "second"]);

      dispose(anchor);
      expect(disposals).toBe(1);
      dispose(anchor);
      expect(disposals).toBe(1);
      container.remove();
    });
  });

  describe("svgElement", () => {
    it("appends a foreign-realm child, adopting it", () => {
      const circle = fd.createElementNS(SVG_NS, "circle");
      const svg = svgElement("svg", {}, circle as unknown as SVGElement);
      expect(svg.firstChild).toBe(circle);
      expect(circle.ownerDocument).toBe(document);
    });

    it("appends a child from another document of the same realm", () => {
      const other = document.implementation.createHTMLDocument("other");
      const g = other.createElementNS(SVG_NS, "g");
      const svg = svgElement("svg", {}, g as unknown as SVGElement);
      expect(svg.firstChild).toBe(g);
    });

    it("leaves native appendChild as the final validator for a look-alike", () => {
      const fake = { nodeType: 1 } as unknown as SVGElement;
      // The DOM's TypeError, which may belong to the DOM implementation's realm.
      let thrown: unknown;
      try {
        svgElement("svg", {}, fake);
      } catch (err) {
        thrown = err;
      }
      expect((thrown as Error | undefined)?.name).toBe("TypeError");
    });
  });

  describe("clickOutside", () => {
    it("listens on the element's own document and removes the listener from it", () => {
      const el = fd.createElement("div");
      const outside = fd.createElement("div");
      fd.body.append(el, outside);
      const callback = vi.fn();
      const add = vi.spyOn(fd, "addEventListener");
      const remove = vi.spyOn(fd, "removeEventListener");

      const cleanup = clickOutside(el as HTMLElement, callback);
      expect(add).toHaveBeenCalledWith("pointerdown", expect.any(Function), true);

      el.dispatchEvent(new fw.Event("pointerdown", { bubbles: true }));
      expect(callback).not.toHaveBeenCalled();

      outside.dispatchEvent(new fw.Event("pointerdown", { bubbles: true }));
      expect(callback).toHaveBeenCalledTimes(1);

      // A pointerdown in the global document is not an interaction with the
      // element's document at all.
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      expect(callback).toHaveBeenCalledTimes(1);

      cleanup?.();
      expect(remove).toHaveBeenCalledWith("pointerdown", add.mock.calls[0][1], true);
      outside.dispatchEvent(new fw.Event("pointerdown", { bubbles: true }));
      expect(callback).toHaveBeenCalledTimes(1);
    });
  });

  describe("trapFocus", () => {
    it("wraps focus using the element's own document's activeElement", () => {
      const dialog = fd.createElement("div");
      const first = fd.createElement("button");
      const last = fd.createElement("button");
      dialog.append(first, last);
      fd.body.appendChild(dialog);
      const cleanup = trapFocus(dialog as HTMLElement);

      last.focus();
      expect(fd.activeElement).toBe(last);
      const forward = new fw.KeyboardEvent("keydown", { key: "Tab", cancelable: true });
      dialog.dispatchEvent(forward);
      expect(forward.defaultPrevented).toBe(true);
      expect(fd.activeElement).toBe(first);

      const back = new fw.KeyboardEvent("keydown", { key: "Tab", shiftKey: true, cancelable: true });
      dialog.dispatchEvent(back);
      expect(back.defaultPrevented).toBe(true);
      expect(fd.activeElement).toBe(last);
      cleanup?.();
    });
  });

  describe("keyboard({ target })", () => {
    it("clears stuck keys on the target window's blur, not the global window's", () => {
      const input = fd.createElement("input");
      fd.body.appendChild(input);
      const add = vi.spyOn(fw, "addEventListener");
      const remove = vi.spyOn(fw, "removeEventListener");

      const kb = keyboard({ target: input as HTMLElement });
      expect(add).toHaveBeenCalledWith("blur", expect.any(Function));

      input.dispatchEvent(new fw.KeyboardEvent("keydown", { key: "Shift" }));
      expect(kb.isPressed("Shift")).toBe(true);

      window.dispatchEvent(new Event("blur"));
      expect(kb.isPressed("Shift")).toBe(true);

      fw.dispatchEvent(new fw.Event("blur"));
      expect(kb.isPressed("Shift")).toBe(false);

      kb.dispose();
      const blurListener = add.mock.calls.find(([type]) => type === "blur")?.[1];
      expect(remove).toHaveBeenCalledWith("blur", blurListener);
    });

    it("keeps the global window for the default target", () => {
      const add = vi.spyOn(window, "addEventListener");
      const remove = vi.spyOn(window, "removeEventListener");
      const kb = keyboard();
      const blurListener = add.mock.calls.find(([type]) => type === "blur")?.[1];
      expect(blurListener).toBeTypeOf("function");
      kb.dispose();
      expect(remove).toHaveBeenCalledWith("blur", blurListener);
      add.mockRestore();
      remove.mockRestore();
    });
  });
});
