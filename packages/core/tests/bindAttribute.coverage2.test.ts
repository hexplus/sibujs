import { describe, expect, it, vi } from "vitest";
import { signal } from "../src/core/signals/signal";
import { bindAttribute, bindDynamic } from "../src/reactivity/bindAttribute";

describe("bindAttribute coverage2 — event handler refusal", () => {
  it("refuses to bind on* attributes and returns a no-op teardown", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const el = document.createElement("div");
    const teardown = bindAttribute(el, "onclick", () => "alert(1)");
    expect(el.hasAttribute("onclick")).toBe(false);
    expect(typeof teardown).toBe("function");
    expect(() => teardown()).not.toThrow();
    warnSpy.mockRestore();
  });
});

describe("bindAttribute coverage2 — getter throws", () => {
  it("swallows a throwing getter and warns", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const el = document.createElement("div");
    bindAttribute(el, "title", () => {
      throw new Error("getter boom");
    });
    expect(el.hasAttribute("title")).toBe(false);
    warnSpy.mockRestore();
  });
});

describe("bindAttribute coverage2 — boolean attributes", () => {
  it("sets/removes a plain boolean attribute by presence", () => {
    const el = document.createElement("div");
    const [on, setOn] = signal(true);
    bindAttribute(el, "hidden", () => on());
    expect(el.hasAttribute("hidden")).toBe(true);
    setOn(false);
    expect(el.hasAttribute("hidden")).toBe(false);
  });

  it("sets IDL property for checked/disabled/selected boolean", () => {
    const input = document.createElement("input");
    const [checked, setChecked] = signal(true);
    bindAttribute(input, "checked", () => checked());
    expect(input.checked).toBe(true);
    setChecked(false);
    expect(input.checked).toBe(false);

    const btn = document.createElement("button");
    const [disabled] = signal(true);
    bindAttribute(btn, "disabled", () => disabled());
    expect(btn.disabled).toBe(true);
  });
});

describe("bindAttribute coverage2 — value/checked property binding", () => {
  it("binds input value as a property when value is non-boolean", () => {
    const input = document.createElement("input");
    const [val, setVal] = signal("hello");
    bindAttribute(input, "value", () => val());
    expect(input.value).toBe("hello");
    setVal("world");
    expect(input.value).toBe("world");
  });

  it("binds checked via property with a truthy non-boolean value", () => {
    const input = document.createElement("input");
    input.type = "checkbox";
    bindAttribute(input, "checked", () => "yes" as unknown);
    expect(input.checked).toBe(true);
  });

  it("sanitizes URL attributes", () => {
    const a = document.createElement("a");
    bindAttribute(a, "href", () => "javascript:alert(1)");
    expect(a.getAttribute("href")).not.toContain("javascript:");
  });
});

describe("bindDynamic coverage2", () => {
  it("removes old attribute when the name changes", () => {
    const el = document.createElement("div");
    const [name, setName] = signal("data-a");
    bindDynamic(el, () => name(), "x");
    expect(el.getAttribute("data-a")).toBe("x");
    setName("data-b");
    expect(el.hasAttribute("data-a")).toBe(false);
    expect(el.getAttribute("data-b")).toBe("x");
  });

  it("blocks event-handler attribute names", () => {
    const el = document.createElement("div");
    bindDynamic(el, "onclick", "alert(1)");
    expect(el.hasAttribute("onclick")).toBe(false);
  });

  it("swallows a throwing name getter and warns", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const el = document.createElement("div");
    bindDynamic(
      el,
      () => {
        throw new Error("name boom");
      },
      "v",
    );
    warnSpy.mockRestore();
    expect(el.attributes.length).toBe(0);
  });

  it("swallows a throwing value getter and warns", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const el = document.createElement("div");
    bindDynamic(el, "data-x", () => {
      throw new Error("value boom");
    });
    warnSpy.mockRestore();
    expect(el.hasAttribute("data-x")).toBe(false);
  });

  it("binds value/checked as a property for matching dynamic name", () => {
    const input = document.createElement("input");
    bindDynamic(input, "value", () => "typed");
    expect(input.value).toBe("typed");

    const cb = document.createElement("input");
    cb.type = "checkbox";
    bindDynamic(cb, "checked", () => true);
    expect(cb.checked).toBe(true);
  });

  it("teardown stops tracking and removes the current attribute", () => {
    const el = document.createElement("div");
    const [val, setVal] = signal("1");
    const teardown = bindDynamic(el, "data-k", () => val());
    expect(el.getAttribute("data-k")).toBe("1");
    teardown();
    expect(el.hasAttribute("data-k")).toBe(false);
    setVal("2"); // no longer reactive
    expect(el.hasAttribute("data-k")).toBe(false);
  });

  it("sanitizes URL attributes in dynamic binding", () => {
    const a = document.createElement("a");
    bindDynamic(a, "href", () => "javascript:evil()");
    expect(a.getAttribute("href")).not.toContain("javascript:");
  });

  it("supports static (non-function) name and value", () => {
    const el = document.createElement("div");
    bindDynamic(el, "data-static", "fixed");
    expect(el.getAttribute("data-static")).toBe("fixed");
  });
});
