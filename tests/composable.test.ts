import { describe, expect, it } from "vitest";
import { createSlots, RenderProp, withBoundary } from "../src/patterns/composable";

// composable() was removed in 1.4.0 — it was an identity wrapper that added
// nothing over calling the setup function directly. Plain functions are
// already composables in SibuJS.

describe("RenderProp", () => {
  it("should render using function-as-nodes pattern", () => {
    const el = RenderProp({
      data: () => "Hello",
      render: (data) => {
        const div = document.createElement("div");
        div.textContent = data;
        return div;
      },
    });

    expect(el.textContent).toBe("Hello");
  });
});

describe("withBoundary", () => {
  it("should wrap component in a boundary", () => {
    const Inner = () => {
      const el = document.createElement("span");
      el.textContent = "content";
      return el;
    };

    const Bounded = withBoundary("MyComponent", Inner);
    const el = Bounded();

    expect(el.getAttribute("data-sibu-boundary")).toBe("MyComponent");
    expect(el.textContent).toBe("content");
  });

  it("should catch errors in boundary", () => {
    const Broken = () => {
      throw new Error("Boom");
    };

    const Bounded = withBoundary("Broken", Broken);
    const el = Bounded();

    expect(el.getAttribute("data-sibu-boundary")).toBe("Broken");
    expect(el.textContent).toContain("Boom");
  });
});

describe("createSlots", () => {
  it("should render named slots", () => {
    const { renderSlot, hasSlot } = createSlots({
      header: () => {
        const el = document.createElement("h1");
        el.textContent = "Title";
        return el;
      },
    });

    expect(hasSlot("header")).toBe(true);
    expect(hasSlot("footer")).toBe(false);

    const headerEl = renderSlot("header");
    expect(headerEl?.textContent).toBe("Title");
  });

  it("should use fallback for missing slots", () => {
    const { renderSlot } = createSlots({});

    const result = renderSlot("missing", () => {
      const el = document.createElement("div");
      el.textContent = "fallback";
      return el;
    });

    expect(result?.textContent).toBe("fallback");
  });
});
