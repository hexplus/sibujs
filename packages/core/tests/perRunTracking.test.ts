import { beforeEach, describe, expect, it } from "vitest";
import { div } from "../src/core/rendering/html";
import { derived } from "../src/core/signals/derived";
import { effect } from "../src/core/signals/effect";
import { signal } from "../src/core/signals/signal";
import { watch } from "../src/core/signals/watch";
import { bindAttribute } from "../src/reactivity/bindAttribute";
import { bindChildNode } from "../src/reactivity/bindChildNode";
import { bindTextNode } from "../src/reactivity/bindTextNode";

// Per-run dependency tracking: a reactive getter must subscribe to EVERY
// signal read on its MOST RECENT run, even signals first read on a later run,
// and must prune signals it stops reading.

let parent: HTMLElement;
let placeholder: Comment;

beforeEach(() => {
  parent = document.createElement("div");
  placeholder = document.createComment("placeholder");
  parent.appendChild(placeholder);
});

describe("BUG 1 — per-run dependency tracking", () => {
  describe("bindChildNode", () => {
    it("subscribes to a signal first read on a LATER run (the repro)", () => {
      const [total, setTotal] = signal(0);
      const [bytes, setBytes] = signal(0);

      bindChildNode(placeholder, () => (total() ? `${bytes()} / ${total()}` : "waiting"));

      expect(parent.textContent).toBe("waiting");

      setTotal(100); // re-runs; NOW bytes() is read for the first time
      expect(parent.textContent).toBe("0 / 100");

      setBytes(42); // must re-render because bytes is now a dependency
      expect(parent.textContent).toBe("42 / 100");
    });

    it("prunes a signal that STOPS being read on a later run (no over-subscription)", () => {
      const [showA, setShowA] = signal(true);
      const [a, setA] = signal("A");
      let runs = 0;

      bindChildNode(placeholder, () => {
        runs++;
        return showA() ? a() : "static";
      });

      expect(parent.textContent).toBe("A");
      const runsAfterInit = runs;

      setShowA(false); // stops reading a()
      expect(parent.textContent).toBe("static");
      const runsAfterSwitch = runs;
      expect(runsAfterSwitch).toBeGreaterThan(runsAfterInit);

      setA("A2"); // a() is no longer a dependency — must NOT re-run
      expect(runs).toBe(runsAfterSwitch);
      expect(parent.textContent).toBe("static");
    });

    it("handles nested ternaries first read on a later run", () => {
      const [mode, setMode] = signal(0);
      const [x, setX] = signal("x");
      const [y, setY] = signal("y");

      bindChildNode(placeholder, () => (mode() === 0 ? "none" : mode() === 1 ? x() : y()));

      expect(parent.textContent).toBe("none");

      setMode(1);
      expect(parent.textContent).toBe("x");
      setX("X!");
      expect(parent.textContent).toBe("X!");

      setMode(2);
      expect(parent.textContent).toBe("y");
      setY("Y!");
      expect(parent.textContent).toBe("Y!");
    });

    it("handles short-circuit (a() && b()) first read on a later run", () => {
      const [enabled, setEnabled] = signal(false);
      const [value, setValue] = signal("v0");

      bindChildNode(placeholder, () => (enabled() && value()) || "off");

      expect(parent.textContent).toBe("off");

      setEnabled(true); // now value() is read for the first time
      expect(parent.textContent).toBe("v0");

      setValue("v1");
      expect(parent.textContent).toBe("v1");
    });
  });

  describe("bindTextNode", () => {
    it("subscribes to a signal first read on a later run", () => {
      const [total, setTotal] = signal(0);
      const [bytes, setBytes] = signal(0);
      const text = document.createTextNode("");
      parent.appendChild(text);

      bindTextNode(text, () => (total() ? `${bytes()} / ${total()}` : "waiting"));

      expect(text.textContent).toBe("waiting");
      setTotal(100);
      expect(text.textContent).toBe("0 / 100");
      setBytes(42);
      expect(text.textContent).toBe("42 / 100");
    });
  });

  describe("bindAttribute", () => {
    it("subscribes to a class/style signal first read on a later run", () => {
      const [active, setActive] = signal(false);
      const [color, setColor] = signal("red");
      const el = document.createElement("div");

      bindAttribute(el, "class", () => (active() ? `c-${color()}` : "idle"));

      expect(el.getAttribute("class")).toBe("idle");
      setActive(true);
      expect(el.getAttribute("class")).toBe("c-red");
      setColor("blue");
      expect(el.getAttribute("class")).toBe("c-blue");
    });
  });

  describe("tagFactory class getter (routes through applyClass, not bindAttribute)", () => {
    it("subscribes to a class signal first read on a later run", () => {
      const [active, setActive] = signal(false);
      const [color, setColor] = signal("red");
      const el = div({ class: () => (active() ? `c-${color()}` : "idle") });

      expect(el.getAttribute("class")).toBe("idle");
      setActive(true);
      expect(el.getAttribute("class")).toBe("c-red");
      setColor("blue");
      expect(el.getAttribute("class")).toBe("c-blue");
    });
  });

  describe("tagFactory style getter (routes through applyStyle)", () => {
    it("subscribes to a style signal first read on a later run", () => {
      const [on, setOn] = signal(false);
      const [w, setW] = signal("10px");
      const el = div({ style: () => (on() ? `width:${w()}` : "") }) as HTMLElement;

      expect(el.getAttribute("style") ?? "").toBe("");
      setOn(true);
      expect(el.getAttribute("style")).toBe("width:10px");
      setW("20px");
      expect(el.getAttribute("style")).toBe("width:20px");
    });
  });

  describe("watch", () => {
    it("fires for a signal first read on a later run", () => {
      const [total, setTotal] = signal(0);
      const [bytes, setBytes] = signal(0);
      const seen: string[] = [];
      watch(
        () => (total() ? `${bytes()} / ${total()}` : "waiting"),
        (v) => seen.push(v),
      );

      setTotal(100); // first time bytes() is read
      setBytes(42); // must fire because bytes is now a dependency
      expect(seen).toEqual(["0 / 100", "42 / 100"]);
    });
  });

  describe("derived (regression — must already work)", () => {
    it("subscribes to a signal first read on a later run", () => {
      const [total, setTotal] = signal(0);
      const [bytes, setBytes] = signal(0);
      const label = derived(() => (total() ? `${bytes()} / ${total()}` : "waiting"));

      expect(label()).toBe("waiting");
      setTotal(100);
      expect(label()).toBe("0 / 100");
      setBytes(42);
      expect(label()).toBe("42 / 100");
    });
  });

  describe("effect (regression — must already work)", () => {
    it("subscribes to a signal first read on a later run", () => {
      const [total, setTotal] = signal(0);
      const [bytes, setBytes] = signal(0);
      let seen = "";
      effect(() => {
        seen = total() ? `${bytes()} / ${total()}` : "waiting";
      });

      expect(seen).toBe("waiting");
      setTotal(100);
      expect(seen).toBe("0 / 100");
      setBytes(42);
      expect(seen).toBe("42 / 100");
    });
  });
});
