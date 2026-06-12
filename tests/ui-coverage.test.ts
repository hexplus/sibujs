import { afterEach, describe, expect, it, vi } from "vitest";
import { signal } from "../src/core/signals/signal";
import { __resetDialogStack, dialog } from "../src/ui/dialog";
import { hover } from "../src/ui/hover";
import { bindBoolAttr } from "../src/ui/reactiveAttr";
import { reducedMotion } from "../src/ui/reducedMotion";
import { scopedStyle, withScopedStyle } from "../src/ui/scopedStyle";
import { toast } from "../src/ui/toast";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

function mockMatchMedia(matches: boolean) {
  let handler: ((e: { matches: boolean }) => void) | null = null;
  const mql = {
    matches,
    media: "",
    addEventListener: (_e: string, h: (e: { matches: boolean }) => void) => {
      handler = h;
    },
    removeEventListener: vi.fn(),
  };
  return { mql, fire: (m: boolean) => handler?.({ matches: m }) };
}

describe("hover", () => {
  it("tracks pointerenter/leave and disposes", () => {
    const el = document.createElement("div");
    const { hovered, dispose } = hover(el);
    el.dispatchEvent(new Event("pointerenter"));
    expect(hovered()).toBe(true);
    el.dispatchEvent(new Event("pointerleave"));
    expect(hovered()).toBe(false);
    dispose();
  });

  it("no-ops without window", () => {
    vi.stubGlobal("window", undefined);
    const { hovered, dispose } = hover(document.createElement("div"));
    expect(hovered()).toBe(false);
    dispose();
  });
});

describe("reducedMotion", () => {
  it("reacts to the media query and disposes", () => {
    const { mql, fire } = mockMatchMedia(false);
    vi.stubGlobal("window", { matchMedia: () => mql });
    const { reduced, dispose } = reducedMotion();
    expect(reduced()).toBe(false);
    fire(true);
    expect(reduced()).toBe(true);
    dispose();
    expect(mql.removeEventListener).toHaveBeenCalled();
  });
});

describe("reactiveAttr bindBoolAttr", () => {
  it("applies a static boolean and swallows a throwing reactive getter", () => {
    const el = document.createElement("div");
    bindBoolAttr(el, "hidden", true);
    expect(el.hasAttribute("hidden")).toBe(true);
    bindBoolAttr(el, "hidden", false);
    expect(el.hasAttribute("hidden")).toBe(false);

    // Throwing reactive getter → caught, attribute left as-is (no crash).
    expect(() =>
      bindBoolAttr(el, "data-x", () => {
        throw new Error("boom");
      }),
    ).not.toThrow();
  });

  it("updates reactively from a getter", () => {
    const el = document.createElement("div");
    const [on, setOn] = signal(false);
    bindBoolAttr(el, "aria-busy", () => on());
    expect(el.hasAttribute("aria-busy")).toBe(false);
    setOn(true);
    expect(el.hasAttribute("aria-busy")).toBe(true);
  });
});

describe("dialog open/close/dispose stack management", () => {
  it("handles close-when-already-closed and dispose", () => {
    __resetDialogStack();
    const d = dialog();
    expect(d.isOpen()).toBe(false);
    d.close(); // already closed → still removes from stack, returns early
    expect(d.isOpen()).toBe(false);
    d.toggle(); // → open
    expect(d.isOpen()).toBe(true);
    d.toggle(); // → close
    expect(d.isOpen()).toBe(false);
    d.open();
    d.dispose(); // removes from stack + closes
    expect(d.isOpen()).toBe(false);
  });
});

describe("scopedStyle selector rewriting", () => {
  it("scopes selectors, skips at-rules/keyframe stops, and handles pseudo-elements", () => {
    const { attr, scope } = scopedStyle(
      ".card::before { content: ''; }\n" +
        "@media (max-width: 100px) { .bar { color: red; } }\n" +
        "@keyframes spin { from { opacity: 0; } to { opacity: 1; } 50% { opacity: .5; } }",
    );
    expect(scope).toBeTruthy();
    const styleEl = document.querySelector(`style[data-sibu-scope="${scope}"]`) ?? document.querySelector("style");
    const css = styleEl?.textContent ?? "";
    // The pseudo-element selector gets the scope attr inserted before `::`.
    expect(css).toContain(`[${attr}]::before`);
  });

  it("withScopedStyle applies the scope attribute recursively to nested elements", () => {
    const Comp = withScopedStyle<{ label: string }>(".x { color: blue; }", (props) => {
      const root = document.createElement("div");
      const child = document.createElement("span");
      child.textContent = props.label;
      root.appendChild(child);
      return root;
    });
    const el = Comp({ label: "hi" });
    const attr = el.getAttributeNames().find((a) => a.startsWith("data-sibu"));
    expect(attr).toBeTruthy();
    // Recursive application: the nested span carries the same scope attribute.
    expect((el.querySelector("span") as HTMLElement).hasAttribute(attr as string)).toBe(true);
  });
});

describe("toast dismissAll", () => {
  it("clears every active toast and its timer", () => {
    vi.useFakeTimers();
    const t = toast({ duration: 5000 });
    t.show("first");
    t.show("second", "error");
    expect(t.toasts().length).toBe(2);
    t.dismissAll();
    expect(t.toasts().length).toBe(0);
    // No dangling timers fire after dismissAll.
    vi.advanceTimersByTime(6000);
    expect(t.toasts().length).toBe(0);
    vi.useRealTimers();
  });
});
