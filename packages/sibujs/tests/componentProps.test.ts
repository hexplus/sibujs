import { describe, expect, it } from "vitest";
import { defineComponent, defineSlottedComponent, withProps } from "../src/patterns/componentProps";

describe("defineComponent", () => {
  it("should create a component that passes props to setup", () => {
    const Greeting = defineComponent<{ name: string }>({
      setup(props) {
        const el = document.createElement("span");
        el.textContent = `Hello, ${props.name}!`;
        return el;
      },
    });

    const el = Greeting({ name: "World" });
    expect(el.tagName).toBe("SPAN");
    expect(el.textContent).toBe("Hello, World!");
  });

  it("should merge defaults with provided props", () => {
    const Button = defineComponent<{
      label: string;
      variant: string;
      size: number;
    }>({
      defaults: { variant: "primary", size: 16 },
      setup(props) {
        const el = document.createElement("button");
        el.textContent = props.label;
        el.setAttribute("data-variant", props.variant);
        el.setAttribute("data-size", String(props.size));
        return el;
      },
    });

    const el = Button({ label: "Click", variant: "secondary", size: 16 });
    expect(el.textContent).toBe("Click");
    expect(el.getAttribute("data-variant")).toBe("secondary");
    expect(el.getAttribute("data-size")).toBe("16");
  });

  it("should use defaults when props are not provided", () => {
    const Badge = defineComponent<{
      text: string;
      color: string;
    }>({
      defaults: { color: "blue" },
      setup(props) {
        const el = document.createElement("span");
        el.textContent = props.text;
        el.setAttribute("data-color", props.color);
        return el;
      },
    });

    // Provide only text, color should default to "blue"
    const el = Badge({ text: "New" } as unknown as { text: string; color: string });
    expect(el.textContent).toBe("New");
    expect(el.getAttribute("data-color")).toBe("blue");
  });

  it("should allow provided props to override defaults", () => {
    const Tag = defineComponent<{ label: string; color: string }>({
      defaults: { color: "gray" },
      setup(props) {
        const el = document.createElement("span");
        el.textContent = props.label;
        el.setAttribute("data-color", props.color);
        return el;
      },
    });

    const el = Tag({ label: "Important", color: "red" });
    expect(el.getAttribute("data-color")).toBe("red");
  });

  it("should work without defaults", () => {
    const Plain = defineComponent<{ value: number }>({
      setup(props) {
        const el = document.createElement("div");
        el.textContent = String(props.value);
        return el;
      },
    });

    const el = Plain({ value: 42 });
    expect(el.textContent).toBe("42");
  });
});

describe("defineSlottedComponent", () => {
  it("should pass nodes as a single node", () => {
    const Card = defineSlottedComponent<{ title: string }>({
      setup(props) {
        const el = document.createElement("div");
        el.classList.add("card");

        const heading = document.createElement("h2");
        heading.textContent = props.title;
        el.appendChild(heading);

        if (props.nodes) {
          const nodes = Array.isArray(props.nodes) ? props.nodes : [props.nodes];
          for (const child of nodes) el.appendChild(child);
        }

        return el;
      },
    });

    const body = document.createElement("p");
    body.textContent = "Card body content";

    const el = Card({ title: "My Card", nodes: body });
    expect(el.classList.contains("card")).toBe(true);
    expect(el.querySelector("h2")?.textContent).toBe("My Card");
    expect(el.querySelector("p")?.textContent).toBe("Card body content");
  });

  it("should pass nodes as an array of nodes", () => {
    const List = defineSlottedComponent<{ label: string }>({
      setup(props) {
        const el = document.createElement("ul");
        el.setAttribute("aria-label", props.label);

        if (props.nodes) {
          const nodes = Array.isArray(props.nodes) ? props.nodes : [props.nodes];
          for (const child of nodes) el.appendChild(child);
        }

        return el;
      },
    });

    const items = [1, 2, 3].map((n) => {
      const li = document.createElement("li");
      li.textContent = `Item ${n}`;
      return li;
    });

    const el = List({ label: "Numbers", nodes: items });
    expect(el.getAttribute("aria-label")).toBe("Numbers");
    expect(el.querySelectorAll("li").length).toBe(3);
    expect(el.querySelectorAll("li")[1].textContent).toBe("Item 2");
  });

  it("should work without nodes", () => {
    const Empty = defineSlottedComponent<{ text: string }>({
      setup(props) {
        const el = document.createElement("div");
        el.textContent = props.text;
        return el;
      },
    });

    const el = Empty({ text: "No nodes" });
    expect(el.textContent).toBe("No nodes");
  });

  it("should merge defaults with slotted props", () => {
    const Panel = defineSlottedComponent<{ border: string }>({
      defaults: { border: "1px solid black" },
      setup(props) {
        const el = document.createElement("div");
        el.style.border = props.border;

        if (props.nodes) {
          const nodes = Array.isArray(props.nodes) ? props.nodes : [props.nodes];
          for (const child of nodes) el.appendChild(child);
        }

        return el;
      },
    });

    const child = document.createElement("span");
    child.textContent = "Inside panel";

    // Provide only nodes, border defaults
    const el = Panel({ nodes: child } as unknown as { nodes: HTMLElement; border: string });
    expect(el.style.border).toBe("1px solid black");
    expect(el.querySelector("span")?.textContent).toBe("Inside panel");
  });
});

describe("withProps", () => {
  it("should map outer props to inner props", () => {
    const Inner = defineComponent<{
      text: string;
      size: number;
      bold: boolean;
    }>({
      setup(props) {
        const el = document.createElement("span");
        el.textContent = props.text;
        el.setAttribute("data-size", String(props.size));
        if (props.bold) el.style.fontWeight = "bold";
        return el;
      },
    });

    const Simple = withProps(Inner, (outer: { label: string }) => ({
      text: outer.label,
      size: 14,
      bold: true,
    }));

    const el = Simple({ label: "Mapped" });
    expect(el.textContent).toBe("Mapped");
    expect(el.getAttribute("data-size")).toBe("14");
    expect(el.style.fontWeight).toBe("bold");
  });

  it("should allow outer props to compute inner props", () => {
    const Box = defineComponent<{ class: string; width: string }>({
      setup(props) {
        const el = document.createElement("div");
        el.className = props.class;
        el.style.width = props.width;
        return el;
      },
    });

    const SizedBox = withProps(Box, (outer: { size: "small" | "medium" | "large" }) => ({
      class: `box-${outer.size}`,
      width: outer.size === "small" ? "100px" : outer.size === "medium" ? "200px" : "300px",
    }));

    const small = SizedBox({ size: "small" });
    expect(small.className).toBe("box-small");
    expect(small.style.width).toBe("100px");

    const large = SizedBox({ size: "large" });
    expect(large.className).toBe("box-large");
    expect(large.style.width).toBe("300px");
  });

  it("should chain multiple withProps transformations", () => {
    const Base = defineComponent<{ value: number }>({
      setup(props) {
        const el = document.createElement("div");
        el.textContent = String(props.value);
        return el;
      },
    });

    const Doubled = withProps(Base, (outer: { input: number }) => ({ value: outer.input * 2 }));

    const Stringified = withProps(Doubled, (outer: { raw: string }) => ({ input: parseInt(outer.raw, 10) }));

    const el = Stringified({ raw: "5" });
    expect(el.textContent).toBe("10"); // "5" -> 5 -> 10
  });
});
