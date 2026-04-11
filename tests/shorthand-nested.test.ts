// ============================================================================
// (props, children) SHORTHAND — deeply nested
// ============================================================================
//
// The dispatch in `tagFactory` accepts `tag(props, children)` so callers
// can skip the `nodes:` key at every level of the tree. These tests lock
// in the behaviour end-to-end, including:
//
//   - string second-arg becomes text content
//   - array second-arg becomes multiple children
//   - Node second-arg becomes a single wrapped child
//   - second-arg overrides props.nodes when both are present
//   - deep nesting works without ever writing `nodes:`
//   - the legacy `{ class, nodes }` form still works (no regression)

import { describe, expect, it } from "vitest";
import { a, button, div, h1, input, label, li, p, span, ul } from "../src/core/rendering/html";

describe("tag(props, children) shorthand", () => {
  it("accepts a string second-arg as text content", () => {
    const el = p({ class: "body" }, "Hello world") as HTMLElement;
    expect(el.tagName).toBe("P");
    expect(el.className).toBe("body");
    expect(el.textContent).toBe("Hello world");
  });

  it("accepts an array second-arg as multiple children", () => {
    const el = ul({ class: "list" }, [
      li({ class: "item" }, "One"),
      li({ class: "item" }, "Two"),
      li({ class: "item" }, "Three"),
    ]) as HTMLElement;
    expect(el.children.length).toBe(3);
    expect(el.children[0].textContent).toBe("One");
    expect(el.children[2].textContent).toBe("Three");
  });

  it("accepts a Node second-arg as a single child", () => {
    const inner = span({ id: "x" }, "child") as HTMLElement;
    const el = div({ class: "wrapper" }, inner) as HTMLElement;
    expect(el.children.length).toBe(1);
    expect(el.children[0]).toBe(inner);
  });

  it("applies `on:` event handlers alongside the positional children", () => {
    let clicks = 0;
    const el = button(
      {
        class: "primary",
        type: "button",
        on: { click: () => clicks++ },
      },
      "Click me",
    ) as HTMLButtonElement;
    expect(el.textContent).toBe("Click me");
    expect(el.className).toBe("primary");
    el.click();
    expect(clicks).toBe(1);
  });

  it("applies URL-sanitized attributes with the shorthand", () => {
    const el = a({ href: "https://example.com/x", target: "_blank" }, "link") as HTMLAnchorElement;
    expect(el.getAttribute("href")).toBe("https://example.com/x");
    expect(el.getAttribute("target")).toBe("_blank");
    expect(el.textContent).toBe("link");
  });

  it("second-arg children override props.nodes when both are present", () => {
    // This is the tie-breaker: positional wins, so authors can override
    // a previously-set `nodes:` without having to remove it first.
    const props: Record<string, unknown> = { class: "container", nodes: "ignored" };
    const el = div(props, "positional wins") as HTMLElement;
    expect(el.textContent).toBe("positional wins");
  });

  it("legacy { class, nodes } form still works", () => {
    const el = div({
      class: "legacy",
      nodes: [span({ nodes: "still" }), span({ nodes: " works" })],
    }) as HTMLElement;
    expect(el.className).toBe("legacy");
    expect(el.textContent).toBe("still works");
  });

  it("renders a deeply nested tree without `nodes:`", () => {
    const tree = div({ class: "page" }, [
      h1({ class: "title" }, "Welcome"),
      div({ class: "row" }, [
        div({ class: "col" }, [
          label({ for: "email" }, "Email"),
          input({ id: "email", type: "email", placeholder: "you@site.com" }),
        ]),
        div({ class: "col" }, [button({ class: "primary", type: "submit" }, "Submit")]),
      ]),
      p({ class: "footnote" }, "Tree built without a single `nodes:` key."),
    ]) as HTMLElement;

    expect(tree.className).toBe("page");
    expect(tree.querySelector("h1")?.textContent).toBe("Welcome");
    const input1 = tree.querySelector<HTMLInputElement>("#email");
    expect(input1?.type).toBe("email");
    expect(input1?.placeholder).toBe("you@site.com");
    expect(tree.querySelector("button")?.textContent).toBe("Submit");
    expect(tree.querySelector(".footnote")?.textContent).toContain("without a single");
    // No `nodes:` anywhere in the source above — snapshot the string
    // representation to confirm the children made it in.
    expect(tree.querySelectorAll(".col").length).toBe(2);
  });

  it("accepts a reactive getter as second-arg", () => {
    const flip = 0;
    const el = div({ class: "live" }, () => `count: ${flip}`) as HTMLElement;
    // Text content is seeded on the first evaluation
    expect(el.textContent).toBe("count: 0");
    // The reactive binding is a comment placeholder + sibling text — not going to flip
    // it here since there's no signal, but we at least check the element was built.
    expect(el.className).toBe("live");
  });

  it("positional-string shorthand `tag(className, children)` still works", () => {
    const el = div("card", [p({}, "body")]) as HTMLElement;
    expect(el.className).toBe("card");
    expect(el.querySelector("p")?.textContent).toBe("body");
  });
});
