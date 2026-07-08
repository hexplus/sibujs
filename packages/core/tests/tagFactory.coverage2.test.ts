import { describe, expect, it, vi } from "vitest";
import { tagFactory } from "../src/core/rendering/tagFactory";
import { signal } from "../src/core/signals/signal";

const div = tagFactory("div");
const a = tagFactory("a");
const input = tagFactory("input");
const img = tagFactory("img");

describe("tagFactory coverage2 — blocked tags", () => {
  it("throws for blocked tag names", () => {
    expect(() => tagFactory("script")()).toThrow(/blocked for security/);
    expect(() => tagFactory("IFRAME")()).toThrow(/blocked for security/);
  });
});

describe("tagFactory coverage2 — argument forms", () => {
  it("tag() with no args returns empty element", () => {
    const el = div();
    expect(el.tagName).toBe("DIV");
    expect(el.childNodes.length).toBe(0);
  });

  it('tag("class", children) sets class and appends children', () => {
    const el = div("card", "Hello");
    expect(el.getAttribute("class")).toBe("card");
    expect(el.textContent).toBe("Hello");
  });

  it("lone string text child", () => {
    const el = div("just text");
    expect(el.textContent).toBe("just text");
  });

  it("warns when a lone string looks like a class list", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    div("h-6 w-48 md:flex");
    expect(warnSpy).toHaveBeenCalled();
    expect(String(warnSpy.mock.calls[0][0])).toContain("looks like a class list");
    warnSpy.mockRestore();
  });

  it("tag(number) sets numeric text content", () => {
    const el = div(42);
    expect(el.textContent).toBe("42");
  });

  it("tag([children]) array shorthand", () => {
    const child = document.createElement("span");
    const el = div([child, "text", 7]);
    expect(el.contains(child)).toBe(true);
    expect(el.textContent).toContain("text");
    expect(el.textContent).toContain("7");
  });

  it("tag(node) single existing node", () => {
    const node = document.createElement("p");
    const el = div(node);
    expect(el.firstChild).toBe(node);
  });

  it("tag(getter) reactive child", () => {
    const [n] = signal("dyn");
    const el = div(() => n());
    expect(el.textContent).toContain("dyn");
  });
});

describe("tagFactory coverage2 — appendChildren edge cases", () => {
  it("ignores boolean and null children", () => {
    const el = div([false, null, "kept", true, undefined]);
    expect(el.textContent).toBe("kept");
  });

  it("handles nested arrays with functions, nodes, primitives, and booleans", () => {
    const [n] = signal("R");
    const inner = document.createElement("b");
    const el = div([[() => n(), inner, "txt", false, 3]]);
    expect(el.contains(inner)).toBe(true);
    expect(el.textContent).toContain("txt");
    expect(el.textContent).toContain("3");
  });

  it("single string nodes via props.nodes uses textContent fast path", () => {
    const el = div({ nodes: "fast" });
    expect(el.textContent).toBe("fast");
  });

  it("single number via props.nodes", () => {
    const el = div({ nodes: 99 });
    expect(el.textContent).toBe("99");
  });
});

describe("tagFactory coverage2 — class prop forms", () => {
  it("class as string", () => {
    const el = div({ class: "a b" });
    expect(el.getAttribute("class")).toBe("a b");
  });

  it("class as function (reactive)", () => {
    const [c, setC] = signal("one");
    const el = div({ class: () => c() });
    expect(el.getAttribute("class")).toBe("one");
    setC("two");
    expect(el.getAttribute("class")).toBe("two");
  });

  it("class as static conditional object", () => {
    const el = div({ class: { active: true, hidden: false } });
    expect(el.getAttribute("class")).toBe("active");
  });

  it("class as reactive conditional object", () => {
    const [on, setOn] = signal(false);
    const el = div({ class: { base: true, active: () => on() } });
    expect(el.getAttribute("class")).toBe("base");
    setOn(true);
    expect(el.getAttribute("class")).toBe("base active");
  });
});

describe("tagFactory coverage2 — style prop forms", () => {
  it("style as string", () => {
    const el = div({ style: "color: red" });
    expect(el.getAttribute("style")).toContain("color: red");
  });

  it("style as function (reactive)", () => {
    const [s, setS] = signal("color: blue");
    const el = div({ style: () => s() });
    expect(el.getAttribute("style")).toContain("blue");
    setS("color: green");
    expect(el.getAttribute("style")).toContain("green");
  });

  it("style as object with static and reactive values", () => {
    const [w, setW] = signal(10);
    const el = div({ style: { backgroundColor: "red", width: () => `${w()}px` } }) as HTMLElement;
    expect(el.style.backgroundColor).toBe("red");
    expect(el.style.width).toBe("10px");
    setW(20);
    expect(el.style.width).toBe("20px");
  });
});

describe("tagFactory coverage2 — id, ref, on, onElement", () => {
  it("sets id and warns for clobber-risky id in dev", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const el = div({ id: "location" });
    expect(el.id).toBe("location");
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("sets a safe id without warning", () => {
    const el = div({ id: "my-safe-id" });
    expect(el.id).toBe("my-safe-id");
  });

  it("ref.current is assigned", () => {
    const ref = { current: null as Element | null };
    const el = div({ ref });
    expect(ref.current).toBe(el);
  });

  it("on handlers attach event listeners", () => {
    const handler = vi.fn();
    const el = div({ on: { click: handler } });
    el.dispatchEvent(new Event("click"));
    expect(handler).toHaveBeenCalled();
  });

  it("warns when an on handler is not a function", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    div({ on: { click: 123 as unknown as (e: Event) => void } });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("onElement callback receives the element", () => {
    const cb = vi.fn();
    const el = div({ onElement: cb });
    expect(cb).toHaveBeenCalledWith(el);
  });
});

describe("tagFactory coverage2 — custom attributes", () => {
  it("function attribute binds reactively", () => {
    const [t, setT] = signal("hi");
    const el = div({ title: () => t() });
    expect(el.getAttribute("title")).toBe("hi");
    setT("bye");
    expect(el.getAttribute("title")).toBe("bye");
  });

  it("boolean IDL attribute (disabled) set as property", () => {
    const btn = tagFactory("button")({ disabled: true }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("boolean true non-IDL attribute set as empty string", () => {
    const el = div({ "data-flag": true });
    expect(el.getAttribute("data-flag")).toBe("");
  });

  it("boolean false attribute is removed/absent", () => {
    const el = div({ "data-flag": false });
    expect(el.hasAttribute("data-flag")).toBe(false);
  });

  it("null attribute value is skipped", () => {
    const el = div({ "data-x": null });
    expect(el.hasAttribute("data-x")).toBe(false);
  });

  it("on* string attribute is blocked", () => {
    const el = div({ onclick: "alert(1)" });
    expect(el.hasAttribute("onclick")).toBe(false);
  });

  it("srcset attribute is sanitized", () => {
    const el = img({ srcset: "javascript:alert(1) 1x" }) as HTMLImageElement;
    expect(el.getAttribute("srcset") ?? "").not.toContain("javascript:");
  });

  it("url attribute is sanitized", () => {
    const link = a({ href: "javascript:evil()" }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).not.toContain("javascript:");
  });

  it("plain string attribute set directly", () => {
    const el = div({ "data-role": "button" });
    expect(el.getAttribute("data-role")).toBe("button");
  });

  it("positional children override props.nodes", () => {
    const el = div({ nodes: "ignored" }, "positional");
    expect(el.textContent).toBe("positional");
  });

  it("input value/checked boolean property branch via custom attr", () => {
    const el = input({ type: "checkbox", checked: true }) as HTMLInputElement;
    expect(el.checked).toBe(true);
  });
});
