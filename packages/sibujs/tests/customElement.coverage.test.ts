import { describe, expect, it } from "vitest";
import { defineElement, svgElement } from "../src/platform/customElement";

// Each test uses a unique element name; customElements.define cannot be undone
// within a single jsdom registry, so names must never collide across tests.
let counter = 0;
const uniqueName = () => `sibu-test-${counter++}`;

describe("defineElement", () => {
  it("defines a custom element and renders the component on connect", () => {
    const name = uniqueName();
    defineElement(name, () => {
      const el = document.createElement("p");
      el.textContent = "hello";
      return el;
    });
    expect(customElements.get(name)).toBeDefined();

    const el = document.createElement(name);
    document.body.appendChild(el);
    expect(el.shadowRoot).not.toBeNull();
    expect(el.shadowRoot!.querySelector("p")?.textContent).toBe("hello");
    el.remove();
  });

  it("is a no-op when the name is already registered", () => {
    const name = uniqueName();
    let calls = 0;
    defineElement(name, () => {
      calls++;
      return document.createElement("div");
    });
    // Second definition with a different component must be ignored.
    defineElement(name, () => {
      calls += 100;
      return document.createElement("span");
    });
    const el = document.createElement(name);
    document.body.appendChild(el);
    expect(calls).toBe(1);
    el.remove();
  });

  it("passes attributes as props to the component", () => {
    const name = uniqueName();
    let received: Record<string, unknown> = {};
    defineElement(name, (props) => {
      received = props;
      return document.createElement("div");
    });
    const el = document.createElement(name);
    el.setAttribute("title", "abc");
    el.setAttribute("data-x", "1");
    document.body.appendChild(el);
    expect(received.title).toBe("abc");
    expect(received["data-x"]).toBe("1");
    el.remove();
  });

  it("renders into light DOM when shadow is disabled", () => {
    const name = uniqueName();
    defineElement(
      name,
      () => {
        const el = document.createElement("b");
        el.textContent = "light";
        return el;
      },
      { shadow: false },
    );
    const el = document.createElement(name);
    document.body.appendChild(el);
    expect(el.shadowRoot).toBeNull();
    expect(el.querySelector("b")?.textContent).toBe("light");
    el.remove();
  });

  it("uses a closed shadow root when mode is closed", () => {
    const name = uniqueName();
    defineElement(name, () => document.createElement("div"), { mode: "closed" });
    const el = document.createElement(name);
    document.body.appendChild(el);
    // A closed shadow root is not exposed via element.shadowRoot.
    expect(el.shadowRoot).toBeNull();
    el.remove();
  });

  it("injects a style element into the shadow root when styles are provided", () => {
    const name = uniqueName();
    defineElement(name, () => document.createElement("div"), {
      styles: "div { color: red; }",
    });
    const el = document.createElement(name);
    document.body.appendChild(el);
    const style = el.shadowRoot!.querySelector("style");
    expect(style?.textContent).toBe("div { color: red; }");
    el.remove();
  });

  it("re-renders on observed attribute changes after first render", () => {
    const name = uniqueName();
    let renderCount = 0;
    defineElement(
      name,
      (props) => {
        renderCount++;
        const el = document.createElement("span");
        el.textContent = String(props.label ?? "");
        return el;
      },
      { observedAttributes: ["label"] },
    );
    const el = document.createElement(name);
    el.setAttribute("label", "one");
    document.body.appendChild(el);
    expect(renderCount).toBe(1);
    expect(el.shadowRoot!.querySelector("span")?.textContent).toBe("one");

    el.setAttribute("label", "two");
    expect(renderCount).toBe(2);
    expect(el.shadowRoot!.querySelector("span")?.textContent).toBe("two");
    el.remove();
  });

  it("does not re-render on attribute change before the element is rendered", () => {
    const name = uniqueName();
    let renderCount = 0;
    defineElement(
      name,
      () => {
        renderCount++;
        return document.createElement("div");
      },
      { observedAttributes: ["label"] },
    );
    const el = document.createElement(name);
    // attributeChangedCallback fires for an upgraded element with the attribute
    // set, but _rendered is still null so no render should happen yet.
    el.setAttribute("label", "x");
    expect(renderCount).toBe(0);
    document.body.appendChild(el);
    expect(renderCount).toBe(1);
    el.remove();
  });

  it("tears down rendered content on disconnect", () => {
    const name = uniqueName();
    defineElement(name, () => {
      const el = document.createElement("i");
      el.textContent = "x";
      return el;
    });
    const el = document.createElement(name);
    document.body.appendChild(el);
    expect(el.shadowRoot!.querySelector("i")).not.toBeNull();
    el.remove();
    // After disconnect the shadow root content is cleared.
    expect(el.shadowRoot!.querySelector("i")).toBeNull();
  });

  it("re-renders cleanly when reconnected", () => {
    const name = uniqueName();
    let renderCount = 0;
    defineElement(name, () => {
      renderCount++;
      return document.createElement("div");
    });
    const el = document.createElement(name);
    document.body.appendChild(el);
    el.remove();
    document.body.appendChild(el);
    expect(renderCount).toBe(2);
    el.remove();
  });
});

describe("svgElement extras", () => {
  it("attaches event listeners for on* function props", () => {
    let clicked = false;
    const el = svgElement("rect", {
      onClick: () => {
        clicked = true;
      },
    });
    el.dispatchEvent(new Event("click"));
    expect(clicked).toBe(true);
  });

  it("skips the reserved nodes prop and null/undefined values", () => {
    const el = svgElement("rect", { nodes: "ignored", width: "10", height: null, fill: undefined });
    expect(el.getAttribute("nodes")).toBeNull();
    expect(el.getAttribute("width")).toBe("10");
    expect(el.getAttribute("height")).toBeNull();
    expect(el.getAttribute("fill")).toBeNull();
  });
});
