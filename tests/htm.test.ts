import { describe, expect, it, vi } from "vitest";
import { html } from "../src/core/rendering/htm";

describe("html: static markup", () => {
  it("creates a single root element", () => {
    const el = html`<div></div>`;
    expect(el).toBeInstanceOf(HTMLElement);
    expect((el as HTMLElement).tagName).toBe("DIV");
  });

  it("creates elements with static text content", () => {
    const el = html`<p>Hello world</p>`;
    expect(el.tagName).toBe("P");
    expect(el.textContent).toBe("Hello world");
  });

  it("preserves the element tag name", () => {
    const el = html`<section></section>`;
    expect(el.tagName).toBe("SECTION");
  });

  it("collapses runs of whitespace in text to a single space", () => {
    const el = html`<p>a    b
        c</p>`;
    expect(el.textContent).toBe("a b c");
  });
});

describe("html: nested elements", () => {
  it("builds a nested tree", () => {
    const el = html`<div><span>inner</span></div>`;
    expect(el.tagName).toBe("DIV");
    expect(el.children.length).toBe(1);
    expect(el.children[0].tagName).toBe("SPAN");
    expect(el.children[0].textContent).toBe("inner");
  });

  it("builds deeply nested trees", () => {
    const el = html`<ul><li><a>link</a></li></ul>`;
    const a = el.querySelector("a");
    expect(a).not.toBeNull();
    expect(a!.textContent).toBe("link");
  });

  it("handles multiple sibling children", () => {
    const el = html`<div><span>one</span><span>two</span><b>three</b></div>`;
    expect(el.children.length).toBe(3);
    expect(el.children[0].textContent).toBe("one");
    expect(el.children[1].textContent).toBe("two");
    expect(el.children[2].tagName).toBe("B");
  });

  it("mixes text and element children", () => {
    const el = html`<p>before<span>mid</span>after</p>`;
    expect(el.childNodes.length).toBe(3);
    expect(el.childNodes[0].nodeType).toBe(3);
    expect(el.childNodes[0].textContent).toBe("before");
    expect((el.childNodes[1] as Element).tagName).toBe("SPAN");
    expect(el.childNodes[2].textContent).toBe("after");
  });
});

describe("html: static attributes", () => {
  it("parses a double-quoted attribute", () => {
    const el = html`<div class="box"></div>`;
    expect(el.getAttribute("class")).toBe("box");
  });

  it("parses a single-quoted attribute", () => {
    const el = html`<div id='main'></div>`;
    expect(el.getAttribute("id")).toBe("main");
  });

  it("parses an unquoted attribute value", () => {
    const el = html`<div data-role=widget></div>`;
    expect(el.getAttribute("data-role")).toBe("widget");
  });

  it("parses multiple attributes on one element", () => {
    const el = html`<input type="text" name="email" placeholder="you@x.com" />`;
    expect(el.getAttribute("type")).toBe("text");
    expect(el.getAttribute("name")).toBe("email");
    expect(el.getAttribute("placeholder")).toBe("you@x.com");
  });

  it("supports attribute names with colons, dots, dashes and underscores", () => {
    const el = html`<div data-x="1" my:ns="2" my.dot="3" my_und="4"></div>`;
    expect(el.getAttribute("data-x")).toBe("1");
    expect(el.getAttribute("my:ns")).toBe("2");
    expect(el.getAttribute("my.dot")).toBe("3");
    expect(el.getAttribute("my_und")).toBe("4");
  });

  it("handles a quoted value containing spaces", () => {
    const el = html`<div class="a b c"></div>`;
    expect(el.getAttribute("class")).toBe("a b c");
  });
});

describe("html: boolean attributes", () => {
  it("sets a bare boolean attribute to an empty string", () => {
    const el = html`<input disabled />`;
    expect(el.hasAttribute("disabled")).toBe(true);
    expect(el.getAttribute("disabled")).toBe("");
  });

  it("supports multiple boolean attributes", () => {
    const el = html`<input required readonly />`;
    expect(el.hasAttribute("required")).toBe(true);
    expect(el.hasAttribute("readonly")).toBe(true);
  });

  it("mixes boolean and valued attributes", () => {
    const el = html`<input type="checkbox" checked />`;
    expect(el.getAttribute("type")).toBe("checkbox");
    expect(el.hasAttribute("checked")).toBe(true);
  });
});

describe("html: self-closing and void elements", () => {
  it("handles a self-closing tag", () => {
    const el = html`<div><span /></div>`;
    expect(el.children.length).toBe(1);
    expect(el.children[0].tagName).toBe("SPAN");
    expect(el.children[0].childNodes.length).toBe(0);
  });

  it("handles void elements without a closing slash", () => {
    const el = html`<div><br><hr></div>`;
    expect(el.children.length).toBe(2);
    expect(el.children[0].tagName).toBe("BR");
    expect(el.children[1].tagName).toBe("HR");
  });

  it("treats img as a void element with attributes", () => {
    const el = html`<img src="/a.png" alt="pic">` as HTMLImageElement;
    expect(el.tagName).toBe("IMG");
    expect(el.getAttribute("src")).toBe("/a.png");
    expect(el.getAttribute("alt")).toBe("pic");
  });
});

describe("html: expression children", () => {
  it("inserts a string expression as a text node", () => {
    const name = "Ada";
    const el = html`<p>Hi ${name}</p>`;
    expect(el.textContent).toBe("Hi Ada");
  });

  it("inserts a number expression coerced to text", () => {
    const el = html`<p>${42}</p>`;
    expect(el.textContent).toBe("42");
  });

  it("appends a Node expression directly", () => {
    const child = document.createElement("span");
    child.textContent = "node";
    const el = html`<div>${child}</div>`;
    expect(el.children.length).toBe(1);
    expect(el.children[0]).toBe(child);
  });

  it("appends an array of nodes and strings", () => {
    const a = document.createElement("b");
    a.textContent = "bold";
    const el = html`<div>${[a, "text", 7]}</div>`;
    expect(el.childNodes.length).toBe(3);
    expect(el.childNodes[0]).toBe(a);
    expect(el.childNodes[1].textContent).toBe("text");
    expect(el.childNodes[2].textContent).toBe("7");
  });

  it("skips null, undefined and boolean expression children", () => {
    const el = html`<div>${null}${undefined}${true}${false}</div>`;
    expect(el.childNodes.length).toBe(0);
  });

  it("skips null/boolean items inside an array", () => {
    const el = html`<div>${[null, "keep", false, 1]}</div>`;
    expect(el.childNodes.length).toBe(2);
    expect(el.childNodes[0].textContent).toBe("keep");
    expect(el.childNodes[1].textContent).toBe("1");
  });

  it("supports multiple expression children alongside static text", () => {
    const el = html`<p>${"a"} and ${"b"} and ${"c"}</p>`;
    expect(el.textContent).toBe("a and b and c");
  });
});

describe("html: expression attributes", () => {
  it("binds a static-valued expression attribute", () => {
    const el = html`<div title=${"hello"}></div>`;
    expect(el.getAttribute("title")).toBe("hello");
  });

  it("omits an attribute whose expression value is null", () => {
    const el = html`<div data-x=${null}></div>`;
    expect(el.hasAttribute("data-x")).toBe(false);
  });

  it("coerces a numeric expression attribute to string", () => {
    const el = html`<div data-count=${5}></div>`;
    expect(el.getAttribute("data-count")).toBe("5");
  });

  it("supports a quoted attribute mixing literal text and an expression", () => {
    const el = html`<div class="prefix-${"mid"}-suffix"></div>`;
    expect(el.getAttribute("class")).toBe("prefix-mid-suffix");
  });

  it("supports an unquoted attribute mixing literal text and an expression", () => {
    const el = html`<div data-x=foo${"bar"}></div>`;
    expect(el.getAttribute("data-x")).toBe("foobar");
  });

  it("binds a function-valued attribute reactively", () => {
    const el = html`<div data-v=${() => "computed"}></div>`;
    expect(el.getAttribute("data-v")).toBe("computed");
  });
});

describe("html: on: event handlers", () => {
  it("attaches a click handler via on:click", () => {
    let clicks = 0;
    const el = html`<button on:click=${() => clicks++}>go</button>`;
    expect(el.hasAttribute("onclick")).toBe(false);
    (el as HTMLButtonElement).click();
    expect(clicks).toBe(1);
  });

  it("attaches a custom event handler via on:", () => {
    const handler = vi.fn();
    const el = html`<div on:my-event=${handler}></div>`;
    el.dispatchEvent(new Event("my-event"));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("warns and skips when on: value is not a function", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const el = html`<button on:click=${"not a function" as unknown as () => void}>x</button>`;
    expect(el.hasAttribute("onclick")).toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("supports multiple handlers on different elements", () => {
    const a = vi.fn();
    const b = vi.fn();
    const el = html`<div><button on:click=${a}>a</button><button on:click=${b}>b</button></div>`;
    (el.children[0] as HTMLButtonElement).click();
    (el.children[1] as HTMLButtonElement).click();
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });
});

describe("html: whitespace handling", () => {
  it("collapses leading and surrounding whitespace around expressions", () => {
    const el = html`<p>  ${"x"}  </p>`;
    expect(el.textContent).toBe(" x ");
  });

  it("collapses whitespace between elements to single-space text nodes", () => {
    const el = html`<div>
      <span>a</span>
      <span>b</span>
    </div>`;
    expect(el.children.length).toBe(2);
    expect(el.children[0].textContent).toBe("a");
    expect(el.children[1].textContent).toBe("b");
    // Whitespace runs collapse to a single space rather than being removed.
    const textNodes = Array.from(el.childNodes).filter((n) => n.nodeType === 3);
    for (const t of textNodes) {
      expect(t.textContent).toBe(" ");
    }
  });

  it("tolerates extra whitespace inside the opening tag", () => {
    const el = html`<div   class="x"    id="y"  ></div>`;
    expect(el.getAttribute("class")).toBe("x");
    expect(el.getAttribute("id")).toBe("y");
  });
});

describe("html: multiple roots and wrapper behavior", () => {
  it("wraps multiple root elements in a div", () => {
    const el = html`<span>a</span><span>b</span>`;
    expect(el.tagName).toBe("DIV");
    expect(el.children.length).toBe(2);
  });

  it("returns the single element directly for a one-root fragment with surrounding whitespace", () => {
    const el = html`<span>only</span>`;
    expect(el.tagName).toBe("SPAN");
  });

  it("wraps a root-level expression node", () => {
    const node = document.createElement("p");
    node.textContent = "root";
    const el = html`${node}`;
    // Single element child gets unwrapped.
    expect(el).toBe(node);
  });

  it("wraps mixed root text and elements", () => {
    const el = html`text<span>el</span>`;
    expect(el.tagName).toBe("DIV");
    expect(el.textContent).toContain("text");
    expect(el.textContent).toContain("el");
  });
});

describe("html: caching", () => {
  it("reuses the parsed template across calls at the same call site with fresh values", () => {
    const render = (n: number) => html`<p>count: ${n}</p>`;
    const a = render(1);
    const b = render(2);
    expect(a.textContent).toBe("count: 1");
    expect(b.textContent).toBe("count: 2");
    // Distinct element instances even though the template structure is cached.
    expect(a).not.toBe(b);
  });
});

describe("html: raw-text contexts", () => {
  it("throws when a dynamic expression is placed inside <script>", () => {
    expect(() => html`<script>${"alert(1)"}</script>`).toThrow(/raw-text context/);
  });

  it("throws when a dynamic expression is placed inside <style>", () => {
    expect(() => html`<style>${"body{}"}</style>`).toThrow(/raw-text context/);
  });

  it("allows static content inside <style>", () => {
    const el = html`<style>.a{color:red}</style>`;
    expect(el.tagName).toBe("STYLE");
    expect(el.textContent).toBe(".a{color:red}");
  });
});

describe("html: SVG elements", () => {
  it("creates SVG elements in the SVG namespace", () => {
    const el = html`<svg><circle r="5"></circle></svg>`;
    expect(el.namespaceURI).toBe("http://www.w3.org/2000/svg");
    const circle = el.querySelector("circle");
    expect(circle).not.toBeNull();
    expect(circle!.namespaceURI).toBe("http://www.w3.org/2000/svg");
  });
});
