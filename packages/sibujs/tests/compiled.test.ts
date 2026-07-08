import { describe, expect, it } from "vitest";
import { block, cloneTemplate, hoistable, precompile, staticTemplate } from "../src/performance/compiled";

describe("staticTemplate", () => {
  it("should create an element from an HTML string", () => {
    const el = staticTemplate("<div>Hello</div>");
    expect(el.tagName).toBe("DIV");
    expect(el.textContent).toBe("Hello");
  });

  it("should create an element with attributes", () => {
    const el = staticTemplate('<span class="badge" data-type="info">Info</span>');
    expect(el.tagName).toBe("SPAN");
    expect(el.className).toBe("badge");
    expect(el.getAttribute("data-type")).toBe("info");
    expect(el.textContent).toBe("Info");
  });

  it("should create an element with nested nodes", () => {
    const el = staticTemplate("<ul><li>A</li><li>B</li></ul>");
    expect(el.tagName).toBe("UL");
    expect(el.querySelectorAll("li").length).toBe(2);
    expect(el.querySelectorAll("li")[0].textContent).toBe("A");
    expect(el.querySelectorAll("li")[1].textContent).toBe("B");
  });

  it("should trim surrounding whitespace from the HTML string", () => {
    const el = staticTemplate("  <p>Trimmed</p>  ");
    expect(el.tagName).toBe("P");
    expect(el.textContent).toBe("Trimmed");
  });
});

describe("cloneTemplate", () => {
  it("should clone template content as a DocumentFragment", () => {
    const tpl = document.createElement("template");
    tpl.innerHTML = "<div>Cloned</div>";

    const fragment = cloneTemplate(tpl);
    expect(fragment).toBeInstanceOf(DocumentFragment);

    const el = fragment.firstElementChild as HTMLElement;
    expect(el.tagName).toBe("DIV");
    expect(el.textContent).toBe("Cloned");
  });

  it("should produce independent clones", () => {
    const tpl = document.createElement("template");
    tpl.innerHTML = '<span class="item">Original</span>';

    const clone1 = cloneTemplate(tpl);
    const clone2 = cloneTemplate(tpl);

    const el1 = clone1.firstElementChild as HTMLElement;
    const el2 = clone2.firstElementChild as HTMLElement;

    // Modify one clone and check the other is unaffected
    el1.textContent = "Modified";

    expect(el1.textContent).toBe("Modified");
    expect(el2.textContent).toBe("Original");
  });

  it("should clone multiple child elements", () => {
    const tpl = document.createElement("template");
    tpl.innerHTML = "<li>A</li><li>B</li><li>C</li>";

    const fragment = cloneTemplate(tpl);
    expect(fragment.querySelectorAll("li").length).toBe(3);
  });
});

describe("precompile", () => {
  it("should return a factory that creates elements from a cached template", () => {
    const factory = precompile<{ text: string }>("<div></div>", (el, props) => {
      el.textContent = props.text;
    });

    const el = factory({ text: "Hello" });
    expect(el.tagName).toBe("DIV");
    expect(el.textContent).toBe("Hello");
  });

  it("should apply hydration on each call", () => {
    const factory = precompile<{ count: number }>('<span class="counter"></span>', (el, props) => {
      el.textContent = String(props.count);
    });

    const el1 = factory({ count: 1 });
    const el2 = factory({ count: 2 });

    expect(el1.textContent).toBe("1");
    expect(el2.textContent).toBe("2");
  });

  it("should produce independent elements per call", () => {
    const factory = precompile<{ label: string }>("<button></button>", (el, props) => {
      el.textContent = props.label;
    });

    const a = factory({ label: "A" });
    const b = factory({ label: "B" });

    a.textContent = "Changed";
    expect(b.textContent).toBe("B"); // unaffected
  });

  it("should preserve template attributes through hydration", () => {
    const factory = precompile<{ active: boolean }>('<div class="card" data-role="panel"></div>', (el, props) => {
      if (props.active) {
        el.classList.add("active");
      }
    });

    const el = factory({ active: true });
    expect(el.classList.contains("card")).toBe(true);
    expect(el.classList.contains("active")).toBe(true);
    expect(el.getAttribute("data-role")).toBe("panel");
  });
});

describe("hoistable", () => {
  it("should return the value unchanged", () => {
    expect(hoistable(42)).toBe(42);
    expect(hoistable("hello")).toBe("hello");
    expect(hoistable(true)).toBe(true);
    expect(hoistable(null)).toBe(null);
  });

  it("should return the same object reference", () => {
    const obj = { a: 1 };
    expect(hoistable(obj)).toBe(obj);

    const arr = [1, 2, 3];
    expect(hoistable(arr)).toBe(arr);
  });

  it("should return the same function reference", () => {
    const fn = () => "test";
    expect(hoistable(fn)).toBe(fn);
  });
});

describe("block", () => {
  it("should execute the factory and return the element", () => {
    const el = block(() => {
      const div = document.createElement("div");
      div.textContent = "Block content";
      return div;
    });

    expect(el.tagName).toBe("DIV");
    expect(el.textContent).toBe("Block content");
  });

  it("should return the exact element created by the factory", () => {
    const inner = document.createElement("section");
    inner.id = "test-section";

    const el = block(() => inner);

    expect(el).toBe(inner);
    expect(el.id).toBe("test-section");
  });

  it("should support nested DOM creation inside the factory", () => {
    const el = block(() => {
      const container = document.createElement("div");
      const header = document.createElement("h1");
      header.textContent = "Title";
      const body = document.createElement("p");
      body.textContent = "Body";
      container.appendChild(header);
      container.appendChild(body);
      return container;
    });

    expect(el.querySelector("h1")?.textContent).toBe("Title");
    expect(el.querySelector("p")?.textContent).toBe("Body");
  });
});
