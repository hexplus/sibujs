import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createCypressAdapter,
  createJestAdapter,
  createPlaywrightAdapter,
  createUniversalAdapter,
} from "../src/testing/adapters";

// ─── Jest Adapter ──────────────────────────────────────────────────────────

describe("createJestAdapter", () => {
  let adapter: ReturnType<typeof createJestAdapter>;

  beforeEach(() => {
    adapter = createJestAdapter();
  });

  afterEach(() => {
    adapter.teardown();
  });

  describe("setup", () => {
    it("creates a container element in the document body", () => {
      const container = adapter.setup();
      expect(container).toBeInstanceOf(HTMLElement);
      expect(container.tagName).toBe("DIV");
      expect(container.getAttribute("data-testenv")).toBe("jest");
      expect(document.body.contains(container)).toBe(true);
    });
  });

  describe("teardown", () => {
    it("removes the container from the document body", () => {
      const container = adapter.setup();
      expect(document.body.contains(container)).toBe(true);
      adapter.teardown();
      expect(document.body.contains(container)).toBe(false);
    });

    it("clears container innerHTML before removal", () => {
      const container = adapter.setup();
      container.innerHTML = "<span>child</span>";
      adapter.teardown();
      // After teardown the container should have been emptied and removed
      expect(container.innerHTML).toBe("");
    });

    it("does nothing if called without setup", () => {
      // Should not throw
      expect(() => adapter.teardown()).not.toThrow();
    });
  });

  describe("render", () => {
    it("renders an HTMLElement into the container", () => {
      adapter.setup();
      const el = document.createElement("p");
      el.textContent = "Hello";
      const result = adapter.render(el);
      expect(result.element).toBe(el);
      expect(result.container.contains(el)).toBe(true);
    });

    it("renders a component function into the container", () => {
      adapter.setup();
      const factory = () => {
        const el = document.createElement("span");
        el.textContent = "From factory";
        return el;
      };
      const result = adapter.render(factory);
      expect(result.element.textContent).toBe("From factory");
      expect(result.container.contains(result.element)).toBe(true);
    });

    it("creates a container automatically if setup was not called", () => {
      const el = document.createElement("div");
      const result = adapter.render(el);
      expect(result.container).toBeInstanceOf(HTMLElement);
      expect(result.container.getAttribute("data-testenv")).toBe("jest");
      expect(document.body.contains(result.container)).toBe(true);
    });
  });

  describe("matchers", () => {
    describe("toHaveTextContent", () => {
      it("passes when element contains the expected text", () => {
        const el = document.createElement("div");
        el.textContent = "Hello World";
        const result = adapter.matchers.toHaveTextContent(el, "Hello");
        expect(result.pass).toBe(true);
        expect(result.message()).toContain("not to have text content");
      });

      it("fails when element does not contain the expected text", () => {
        const el = document.createElement("div");
        el.textContent = "Hello World";
        const result = adapter.matchers.toHaveTextContent(el, "Goodbye");
        expect(result.pass).toBe(false);
        expect(result.message()).toContain('Expected element to have text content "Goodbye"');
      });

      it("handles empty text content", () => {
        const el = document.createElement("div");
        const result = adapter.matchers.toHaveTextContent(el, "anything");
        expect(result.pass).toBe(false);
      });
    });

    describe("toHaveAttribute", () => {
      it("passes when element has the attribute", () => {
        const el = document.createElement("input");
        el.setAttribute("type", "text");
        const result = adapter.matchers.toHaveAttribute(el, "type");
        expect(result.pass).toBe(true);
      });

      it("passes when element has attribute with expected value", () => {
        const el = document.createElement("input");
        el.setAttribute("type", "text");
        const result = adapter.matchers.toHaveAttribute(el, "type", "text");
        expect(result.pass).toBe(true);
        expect(result.message()).toContain("not to have attribute");
      });

      it("fails when element does not have the attribute", () => {
        const el = document.createElement("div");
        const result = adapter.matchers.toHaveAttribute(el, "data-missing");
        expect(result.pass).toBe(false);
        expect(result.message()).toContain("does not");
      });

      it("fails when attribute value does not match", () => {
        const el = document.createElement("input");
        el.setAttribute("type", "text");
        const result = adapter.matchers.toHaveAttribute(el, "type", "password");
        expect(result.pass).toBe(false);
        expect(result.message()).toContain('Expected element to have attribute "type" with value "password"');
      });
    });

    describe("toHaveClass", () => {
      it("passes when element has the class", () => {
        const el = document.createElement("div");
        el.classList.add("active");
        const result = adapter.matchers.toHaveClass(el, "active");
        expect(result.pass).toBe(true);
        expect(result.message()).toContain("not to have class");
      });

      it("fails when element does not have the class", () => {
        const el = document.createElement("div");
        el.classList.add("inactive");
        const result = adapter.matchers.toHaveClass(el, "active");
        expect(result.pass).toBe(false);
        expect(result.message()).toContain('Expected element to have class "active"');
        expect(result.message()).toContain("inactive");
      });
    });

    describe("toBeVisible", () => {
      it("passes for a normal visible element", () => {
        const el = document.createElement("div");
        const result = adapter.matchers.toBeVisible(el);
        expect(result.pass).toBe(true);
        expect(result.message()).toContain("Expected element to be hidden");
      });

      it("fails for an element with hidden attribute", () => {
        const el = document.createElement("div");
        el.setAttribute("hidden", "");
        const result = adapter.matchers.toBeVisible(el);
        expect(result.pass).toBe(false);
        expect(result.message()).toContain('"hidden" attribute');
      });

      it("fails for an element with display:none", () => {
        const el = document.createElement("div");
        el.style.display = "none";
        const result = adapter.matchers.toBeVisible(el);
        expect(result.pass).toBe(false);
        expect(result.message()).toContain("display:none");
      });

      it("fails for an element with visibility:hidden", () => {
        const el = document.createElement("div");
        el.style.visibility = "hidden";
        const result = adapter.matchers.toBeVisible(el);
        expect(result.pass).toBe(false);
        expect(result.message()).toContain("visibility:hidden");
      });

      it("fails for an element with opacity:0", () => {
        const el = document.createElement("div");
        el.style.opacity = "0";
        const result = adapter.matchers.toBeVisible(el);
        expect(result.pass).toBe(false);
        expect(result.message()).toContain("opacity:0");
      });
    });

    describe("toBeDisabled", () => {
      it("passes for a disabled button", () => {
        const btn = document.createElement("button");
        btn.disabled = true;
        const result = adapter.matchers.toBeDisabled(btn);
        expect(result.pass).toBe(true);
        expect(result.message()).toContain("not to be disabled");
      });

      it("passes for an element with disabled attribute", () => {
        const el = document.createElement("input");
        el.setAttribute("disabled", "");
        const result = adapter.matchers.toBeDisabled(el);
        expect(result.pass).toBe(true);
      });

      it("passes for an element with aria-disabled=true", () => {
        const el = document.createElement("div");
        el.setAttribute("aria-disabled", "true");
        const result = adapter.matchers.toBeDisabled(el);
        expect(result.pass).toBe(true);
      });

      it("fails for an enabled element", () => {
        const el = document.createElement("button");
        const result = adapter.matchers.toBeDisabled(el);
        expect(result.pass).toBe(false);
        expect(result.message()).toContain("Expected element to be disabled, but it is not");
      });
    });

    describe("toHaveFocus", () => {
      it("passes when element has focus", () => {
        adapter.setup();
        const input = document.createElement("input");
        document.body.appendChild(input);
        input.focus();
        const result = adapter.matchers.toHaveFocus(input);
        expect(result.pass).toBe(true);
        expect(result.message()).toContain("not to have focus");
        document.body.removeChild(input);
      });

      it("fails when element does not have focus", () => {
        const input = document.createElement("input");
        document.body.appendChild(input);
        const result = adapter.matchers.toHaveFocus(input);
        expect(result.pass).toBe(false);
        expect(result.message()).toContain("Expected element to have focus");
        document.body.removeChild(input);
      });
    });

    describe("toHaveStyle", () => {
      it("passes when element has the expected styles", () => {
        const el = document.createElement("div");
        el.style.color = "red";
        el.style.fontSize = "16px";
        const result = adapter.matchers.toHaveStyle(el, {
          color: "red",
          "font-size": "16px",
        });
        expect(result.pass).toBe(true);
        expect(result.message()).toContain("not to have the specified styles");
      });

      it("fails when element does not have the expected styles", () => {
        const el = document.createElement("div");
        el.style.color = "blue";
        const result = adapter.matchers.toHaveStyle(el, { color: "red" });
        expect(result.pass).toBe(false);
        expect(result.message()).toContain("Style mismatches");
        expect(result.message()).toContain('color: expected "red" but got "blue"');
      });

      it("handles camelCase property conversion", () => {
        const el = document.createElement("div");
        el.style.backgroundColor = "green";
        const result = adapter.matchers.toHaveStyle(el, {
          backgroundColor: "green",
        });
        expect(result.pass).toBe(true);
      });
    });
  });
});

// ─── Cypress Adapter ─────────────────────────────────────────────────────────

describe("createCypressAdapter", () => {
  let adapter: ReturnType<typeof createCypressAdapter>;

  beforeEach(() => {
    adapter = createCypressAdapter();
  });

  describe("mount", () => {
    it("mounts an HTMLElement and returns element and container", () => {
      const el = document.createElement("div");
      el.textContent = "Cypress test";
      const result = adapter.mount(el);
      expect(result.element).toBe(el);
      expect(result.container).toBeInstanceOf(HTMLElement);
      expect(result.container.getAttribute("data-testenv")).toBe("cypress");
      expect(result.container.contains(el)).toBe(true);
      // Cleanup
      result.container.parentNode?.removeChild(result.container);
    });

    it("mounts a component function", () => {
      const factory = () => {
        const span = document.createElement("span");
        span.textContent = "From fn";
        return span;
      };
      const result = adapter.mount(factory);
      expect(result.element.textContent).toBe("From fn");
      expect(result.container.contains(result.element)).toBe(true);
      result.container.parentNode?.removeChild(result.container);
    });

    it("uses a provided container if given", () => {
      const customContainer = document.createElement("section");
      document.body.appendChild(customContainer);
      const el = document.createElement("p");
      const result = adapter.mount(el, { container: customContainer });
      expect(result.container).toBe(customContainer);
      expect(customContainer.contains(el)).toBe(true);
      // Should not have data-testenv since we provided our own container
      expect(customContainer.hasAttribute("data-testenv")).toBe(false);
      document.body.removeChild(customContainer);
    });
  });

  describe("commands", () => {
    it("getByTestId returns a data-testid selector", () => {
      const selector = adapter.commands.getByTestId("submit-btn");
      expect(selector).toBe('[data-testid="submit-btn"]');
    });

    it("getByText returns a contains selector", () => {
      const selector = adapter.commands.getByText("Click me");
      expect(selector).toBe(':contains("Click me")');
    });

    it("getByRole returns a role selector", () => {
      const selector = adapter.commands.getByRole("button");
      expect(selector).toBe('[role="button"]');
    });
  });
});

// ─── Playwright Adapter ──────────────────────────────────────────────────────

describe("createPlaywrightAdapter", () => {
  let adapter: ReturnType<typeof createPlaywrightAdapter>;

  beforeEach(() => {
    adapter = createPlaywrightAdapter();
  });

  describe("selectors", () => {
    it("byTestId returns a data-testid selector", () => {
      expect(adapter.selectors.byTestId("header")).toBe('[data-testid="header"]');
    });

    it("byRole returns a role selector", () => {
      expect(adapter.selectors.byRole("navigation")).toBe('[role="navigation"]');
    });

    it("byAriaLabel returns an aria-label selector", () => {
      expect(adapter.selectors.byAriaLabel("Close")).toBe('[aria-label="Close"]');
    });

    it("byDataAttr returns a data attribute selector with value", () => {
      expect(adapter.selectors.byDataAttr("status", "active")).toBe('[data-status="active"]');
    });

    it("byDataAttr returns a data attribute selector without value", () => {
      expect(adapter.selectors.byDataAttr("loading")).toBe("[data-loading]");
    });
  });

  describe("createPageObject", () => {
    it("stores selectors and retrieves them by key", () => {
      const po = adapter.createPageObject("LoginPage", {
        username: "#username-input",
        password: "#password-input",
        submit: '[data-testid="submit"]',
      });
      expect(po.name).toBe("LoginPage");
      expect(po.getSelector("username")).toBe("#username-input");
      expect(po.getSelector("password")).toBe("#password-input");
      expect(po.getSelector("submit")).toBe('[data-testid="submit"]');
    });

    it("allSelectors returns a copy of all selectors", () => {
      const selectors = { title: ".title", body: ".body" };
      const po = adapter.createPageObject("Card", selectors);
      const all = po.allSelectors();
      expect(all).toEqual(selectors);
      // Should be a copy, not the same reference
      expect(all).not.toBe(selectors);
    });

    it("throws on missing key", () => {
      const po = adapter.createPageObject("Dashboard", {
        header: "#header",
      });
      expect(() => po.getSelector("footer")).toThrowError('Page object "Dashboard" has no selector for key "footer"');
    });

    it("includes available keys in the error message for missing key", () => {
      const po = adapter.createPageObject("Settings", {
        theme: "#theme",
        language: "#language",
      });
      try {
        po.getSelector("unknown");
      } catch (e: unknown) {
        expect((e as Error).message).toContain("theme");
        expect((e as Error).message).toContain("language");
      }
    });
  });
});

// ─── Universal Adapter ───────────────────────────────────────────────────────

describe("createUniversalAdapter", () => {
  let adapter: ReturnType<typeof createUniversalAdapter>;

  beforeEach(() => {
    adapter = createUniversalAdapter();
  });

  afterEach(() => {
    adapter.teardown();
  });

  describe("setup/teardown lifecycle", () => {
    it("setup creates a container attached to the document body", () => {
      const container = adapter.setup();
      expect(container).toBeInstanceOf(HTMLElement);
      expect(container.getAttribute("data-testenv")).toBe("universal");
      expect(document.body.contains(container)).toBe(true);
    });

    it("teardown removes the container from the DOM", () => {
      const container = adapter.setup();
      adapter.teardown();
      expect(document.body.contains(container)).toBe(false);
    });

    it("teardown is safe to call multiple times", () => {
      adapter.setup();
      adapter.teardown();
      expect(() => adapter.teardown()).not.toThrow();
    });
  });

  describe("render", () => {
    it("appends an HTMLElement to the container", () => {
      adapter.setup();
      const el = document.createElement("div");
      el.textContent = "Rendered";
      const result = adapter.render(el);
      expect(result.element).toBe(el);
      expect(result.container.contains(el)).toBe(true);
    });

    it("calls a component function and appends the result", () => {
      adapter.setup();
      const result = adapter.render(() => {
        const el = document.createElement("span");
        el.textContent = "Dynamic";
        return el;
      });
      expect(result.element.textContent).toBe("Dynamic");
    });

    it("creates a container automatically if setup was not called", () => {
      const el = document.createElement("div");
      const result = adapter.render(el);
      expect(result.container.getAttribute("data-testenv")).toBe("universal");
      expect(document.body.contains(result.container)).toBe(true);
    });
  });

  describe("queries", () => {
    it("byTestId finds element by data-testid", () => {
      const container = adapter.setup();
      const el = document.createElement("button");
      el.setAttribute("data-testid", "my-btn");
      container.appendChild(el);
      const found = adapter.queries.byTestId(container, "my-btn");
      expect(found).toBe(el);
    });

    it("byTestId returns null when not found", () => {
      const container = adapter.setup();
      const found = adapter.queries.byTestId(container, "nonexistent");
      expect(found).toBeNull();
    });

    it("byRole finds element by role attribute", () => {
      const container = adapter.setup();
      const nav = document.createElement("nav");
      nav.setAttribute("role", "navigation");
      container.appendChild(nav);
      const found = adapter.queries.byRole(container, "navigation");
      expect(found).toBe(nav);
    });

    it("byText finds element containing text", () => {
      const container = adapter.setup();
      const span = document.createElement("span");
      span.textContent = "Find this text";
      container.appendChild(span);
      const found = adapter.queries.byText(container, "Find this");
      expect(found).toBe(span);
    });

    it("byText returns null when text not found", () => {
      const container = adapter.setup();
      const found = adapter.queries.byText(container, "Missing");
      expect(found).toBeNull();
    });

    it("byLabelText finds input by label for attribute", () => {
      const container = adapter.setup();
      const label = document.createElement("label");
      label.textContent = "Email";
      label.setAttribute("for", "email-input");
      const input = document.createElement("input");
      input.id = "email-input";
      container.appendChild(label);
      container.appendChild(input);
      const found = adapter.queries.byLabelText(container, "Email");
      expect(found).toBe(input);
    });

    it("byLabelText finds nested input when label has no for attribute", () => {
      const container = adapter.setup();
      const label = document.createElement("label");
      label.textContent = "Password";
      const input = document.createElement("input");
      label.appendChild(input);
      container.appendChild(label);
      const found = adapter.queries.byLabelText(container, "Password");
      expect(found).toBe(input);
    });

    it("byLabelText falls back to aria-label", () => {
      const container = adapter.setup();
      const el = document.createElement("input");
      el.setAttribute("aria-label", "Search");
      container.appendChild(el);
      const found = adapter.queries.byLabelText(container, "Search");
      expect(found).toBe(el);
    });

    it("allByRole finds all elements with given role", () => {
      const container = adapter.setup();
      for (let i = 0; i < 3; i++) {
        const item = document.createElement("li");
        item.setAttribute("role", "listitem");
        container.appendChild(item);
      }
      const found = adapter.queries.allByRole(container, "listitem");
      expect(found).toHaveLength(3);
      found.forEach((el) => {
        expect(el.getAttribute("role")).toBe("listitem");
      });
    });

    it("allByRole returns empty array when none found", () => {
      const container = adapter.setup();
      const found = adapter.queries.allByRole(container, "menuitem");
      expect(found).toEqual([]);
    });
  });

  describe("assert", () => {
    describe("textContent", () => {
      it("passes when element contains expected text", () => {
        const el = document.createElement("div");
        el.textContent = "Hello World";
        expect(() => adapter.assert.textContent(el, "Hello")).not.toThrow();
      });

      it("throws when element does not contain expected text", () => {
        const el = document.createElement("div");
        el.textContent = "Hello";
        expect(() => adapter.assert.textContent(el, "Goodbye")).toThrowError(
          'Expected text content to include "Goodbye"',
        );
      });
    });

    describe("attribute", () => {
      it("passes when element has the attribute", () => {
        const el = document.createElement("input");
        el.setAttribute("type", "text");
        expect(() => adapter.assert.attribute(el, "type")).not.toThrow();
      });

      it("passes when element has attribute with expected value", () => {
        const el = document.createElement("input");
        el.setAttribute("type", "email");
        expect(() => adapter.assert.attribute(el, "type", "email")).not.toThrow();
      });

      it("throws when element lacks the attribute", () => {
        const el = document.createElement("div");
        expect(() => adapter.assert.attribute(el, "data-foo")).toThrowError(
          'Expected element to have attribute "data-foo"',
        );
      });

      it("throws when attribute value does not match", () => {
        const el = document.createElement("input");
        el.setAttribute("type", "text");
        expect(() => adapter.assert.attribute(el, "type", "number")).toThrowError(
          'Expected attribute "type" to be "number", but got "text"',
        );
      });
    });

    describe("visible", () => {
      it("passes for a visible element", () => {
        const el = document.createElement("div");
        expect(() => adapter.assert.visible(el)).not.toThrow();
      });

      it("throws for a hidden element", () => {
        const el = document.createElement("div");
        el.setAttribute("hidden", "");
        expect(() => adapter.assert.visible(el)).toThrowError('has "hidden" attribute');
      });

      it("throws for display:none", () => {
        const el = document.createElement("div");
        el.style.display = "none";
        expect(() => adapter.assert.visible(el)).toThrowError("display:none");
      });

      it("throws for visibility:hidden", () => {
        const el = document.createElement("div");
        el.style.visibility = "hidden";
        expect(() => adapter.assert.visible(el)).toThrowError("visibility:hidden");
      });
    });

    describe("disabled", () => {
      it("passes for a disabled element", () => {
        const btn = document.createElement("button");
        btn.disabled = true;
        expect(() => adapter.assert.disabled(btn)).not.toThrow();
      });

      it("passes for aria-disabled element", () => {
        const el = document.createElement("div");
        el.setAttribute("aria-disabled", "true");
        expect(() => adapter.assert.disabled(el)).not.toThrow();
      });

      it("throws for an enabled element", () => {
        const btn = document.createElement("button");
        expect(() => adapter.assert.disabled(btn)).toThrowError("Expected element to be disabled, but it is not");
      });
    });

    describe("className", () => {
      it("passes when element has the class", () => {
        const el = document.createElement("div");
        el.classList.add("highlighted");
        expect(() => adapter.assert.className(el, "highlighted")).not.toThrow();
      });

      it("throws when element does not have the class", () => {
        const el = document.createElement("div");
        el.classList.add("other");
        expect(() => adapter.assert.className(el, "highlighted")).toThrowError(
          'Expected element to have class "highlighted"',
        );
      });
    });
  });
});
