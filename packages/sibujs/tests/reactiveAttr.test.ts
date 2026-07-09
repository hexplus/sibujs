import { signal } from "@sibujs/core";
import { bindDynamic } from "@sibujs/core/internal";
import { describe, expect, it } from "vitest";
import { bindAttrs, bindBoolAttr, bindData } from "../src/ui/reactiveAttr";

describe("bindAttrs", () => {
  it("should set static string attributes", () => {
    const el = document.createElement("div");
    bindAttrs(el, { id: "box", role: "button" });

    expect(el.getAttribute("id")).toBe("box");
    expect(el.getAttribute("role")).toBe("button");
  });

  it("should set static numeric attributes as strings", () => {
    const el = document.createElement("div");
    bindAttrs(el, { tabindex: 0, "aria-level": 3 });

    expect(el.getAttribute("tabindex")).toBe("0");
    expect(el.getAttribute("aria-level")).toBe("3");
  });

  it("should set static boolean attributes", () => {
    const el = document.createElement("button");
    bindAttrs(el, { disabled: true, hidden: false });

    expect(el.hasAttribute("disabled")).toBe(true);
    expect(el.getAttribute("disabled")).toBe("");
    expect(el.hasAttribute("hidden")).toBe(false);
  });

  it("should bind reactive getter attributes", () => {
    const [cls, setCls] = signal("primary");
    const el = document.createElement("div");

    bindAttrs(el, { class: () => cls() });

    expect(el.getAttribute("class")).toBe("primary");

    setCls("secondary");
    expect(el.getAttribute("class")).toBe("secondary");
  });

  it("should handle a mix of static and reactive attributes", () => {
    const [title, setTitle] = signal("Hello");
    const el = document.createElement("div");

    bindAttrs(el, {
      id: "card",
      "aria-label": () => title(),
    });

    expect(el.getAttribute("id")).toBe("card");
    expect(el.getAttribute("aria-label")).toBe("Hello");

    setTitle("Updated");
    expect(el.getAttribute("aria-label")).toBe("Updated");
  });

  it("should return a teardown that stops reactive updates", () => {
    const [value, setValue] = signal("a");
    const el = document.createElement("div");

    const teardown = bindAttrs(el, { "data-val": () => value() });

    expect(el.getAttribute("data-val")).toBe("a");

    setValue("b");
    expect(el.getAttribute("data-val")).toBe("b");

    teardown();

    setValue("c");
    expect(el.getAttribute("data-val")).toBe("b"); // should not update
  });
});

describe("bindBoolAttr", () => {
  it("should set a static true boolean attribute", () => {
    const el = document.createElement("button");
    bindBoolAttr(el, "disabled", true);

    expect(el.hasAttribute("disabled")).toBe(true);
    expect(el.getAttribute("disabled")).toBe("");
  });

  it("should not set a static false boolean attribute", () => {
    const el = document.createElement("div");
    bindBoolAttr(el, "hidden", false);

    expect(el.hasAttribute("hidden")).toBe(false);
  });

  it("should reactively toggle a boolean attribute", () => {
    const [disabled, setDisabled] = signal(false);
    const el = document.createElement("button");

    bindBoolAttr(el, "disabled", () => disabled());

    expect(el.hasAttribute("disabled")).toBe(false);

    setDisabled(true);
    expect(el.hasAttribute("disabled")).toBe(true);
    expect(el.getAttribute("disabled")).toBe("");

    setDisabled(false);
    expect(el.hasAttribute("disabled")).toBe(false);
  });

  it("should reactively toggle the hidden attribute", () => {
    const [hidden, setHidden] = signal(true);
    const el = document.createElement("div");

    bindBoolAttr(el, "hidden", () => hidden());

    expect(el.hasAttribute("hidden")).toBe(true);

    setHidden(false);
    expect(el.hasAttribute("hidden")).toBe(false);

    setHidden(true);
    expect(el.hasAttribute("hidden")).toBe(true);
  });

  it("should return a teardown that stops reactive updates", () => {
    const [show, setShow] = signal(true);
    const el = document.createElement("div");

    const teardown = bindBoolAttr(el, "hidden", () => show());

    expect(el.hasAttribute("hidden")).toBe(true);

    teardown();

    setShow(false);
    expect(el.hasAttribute("hidden")).toBe(true); // should not update
  });
});

describe("bindData", () => {
  it("should set a static data attribute", () => {
    const el = document.createElement("div");
    bindData(el, "testid", "my-component");

    expect(el.getAttribute("data-testid")).toBe("my-component");
  });

  it("should reactively update a data attribute", () => {
    const [status, setStatus] = signal("idle");
    const el = document.createElement("div");

    bindData(el, "status", () => status());

    expect(el.getAttribute("data-status")).toBe("idle");

    setStatus("loading");
    expect(el.getAttribute("data-status")).toBe("loading");

    setStatus("done");
    expect(el.getAttribute("data-status")).toBe("done");
  });

  it("should return a teardown that stops reactive updates", () => {
    const [theme, setTheme] = signal("light");
    const el = document.createElement("div");

    const teardown = bindData(el, "theme", () => theme());

    expect(el.getAttribute("data-theme")).toBe("light");

    teardown();

    setTheme("dark");
    expect(el.getAttribute("data-theme")).toBe("light"); // should not update
  });
});

describe("bindDynamic", () => {
  it("should bind a static name with a static value", () => {
    const el = document.createElement("div");

    const teardown = bindDynamic(el, "role", "button");

    expect(el.getAttribute("role")).toBe("button");

    teardown();
    expect(el.hasAttribute("role")).toBe(false);
  });

  it("should bind a static name with a reactive value", () => {
    const [val, setVal] = signal("primary");
    const el = document.createElement("div");

    bindDynamic(el, "class", () => val());

    expect(el.getAttribute("class")).toBe("primary");

    setVal("secondary");
    expect(el.getAttribute("class")).toBe("secondary");
  });

  it("should bind a reactive name with a static value", () => {
    const [name, setName] = signal("title");
    const el = document.createElement("div");

    bindDynamic(el, () => name(), "hello");

    expect(el.getAttribute("title")).toBe("hello");
    expect(el.hasAttribute("role")).toBe(false);

    setName("role");
    expect(el.hasAttribute("title")).toBe(false); // old attribute removed
    expect(el.getAttribute("role")).toBe("hello");
  });

  it("should bind reactive name and reactive value", () => {
    const [name, setName] = signal("data-x");
    const [val, setVal] = signal("100");
    const el = document.createElement("div");

    bindDynamic(
      el,
      () => name(),
      () => val(),
    );

    expect(el.getAttribute("data-x")).toBe("100");

    setVal("200");
    expect(el.getAttribute("data-x")).toBe("200");

    setName("data-y");
    expect(el.hasAttribute("data-x")).toBe(false); // old attribute removed
    expect(el.getAttribute("data-y")).toBe("200");
  });

  it("should clean up on teardown", () => {
    const [val, setVal] = signal("active");
    const el = document.createElement("div");

    const teardown = bindDynamic(el, "data-state", () => val());

    expect(el.getAttribute("data-state")).toBe("active");

    teardown();
    expect(el.hasAttribute("data-state")).toBe(false); // removed on teardown

    setVal("inactive");
    expect(el.hasAttribute("data-state")).toBe(false); // no further updates
  });
});
