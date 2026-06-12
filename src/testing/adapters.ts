/**
 * Testing framework adapters for SibuJS.
 * Provides integration with Jest, Cypress, and Playwright.
 */

/**
 * Escape a value for safe interpolation inside an `[attr="..."]` selector. Only
 * `"` and `\` are significant there, so a value containing quotes/brackets can
 * no longer break the selector or throw a SyntaxError (CSS-selector injection).
 * For id selectors, query via `[id="..."]` with this escaping rather than `#`.
 */
function escSel(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

// ─── Jest Adapter ───────────────────────────────────────────────────────────

/**
 * Create a Jest-compatible test environment for SibuJS.
 * Returns beforeEach/afterEach hooks and custom matchers.
 */
export function createJestAdapter() {
  let container: HTMLElement | null = null;

  return {
    /** Call in beforeEach to set up DOM container */
    setup(): HTMLElement {
      container = document.createElement("div");
      container.setAttribute("data-testenv", "jest");
      document.body.appendChild(container);
      return container;
    },

    /** Call in afterEach to clean up */
    teardown(): void {
      if (container) {
        container.innerHTML = "";
        if (container.parentNode) {
          container.parentNode.removeChild(container);
        }
        container = null;
      }
    },

    /** Render a component into the test container */
    render(component: (() => HTMLElement) | HTMLElement): { element: HTMLElement; container: HTMLElement } {
      if (!container) {
        container = document.createElement("div");
        container.setAttribute("data-testenv", "jest");
        document.body.appendChild(container);
      }
      const element = typeof component === "function" ? component() : component;
      container.appendChild(element);
      return { element, container };
    },

    /** Custom Jest matchers */
    matchers: {
      /** Check if element has specific text content */
      toHaveTextContent(element: Element, expected: string): { pass: boolean; message: () => string } {
        const actual = element.textContent || "";
        const pass = actual.includes(expected);
        return {
          pass,
          message: () =>
            pass
              ? `Expected element not to have text content "${expected}", but found "${actual}"`
              : `Expected element to have text content "${expected}", but found "${actual}"`,
        };
      },

      /** Check if element has specific attribute */
      toHaveAttribute(element: Element, attr: string, value?: string): { pass: boolean; message: () => string } {
        const hasAttr = element.hasAttribute(attr);
        const attrValue = element.getAttribute(attr);
        const pass = value !== undefined ? hasAttr && attrValue === value : hasAttr;
        return {
          pass,
          message: () => {
            if (value !== undefined) {
              return pass
                ? `Expected element not to have attribute "${attr}" with value "${value}", but it does`
                : `Expected element to have attribute "${attr}" with value "${value}", but got "${attrValue}"`;
            }
            return pass
              ? `Expected element not to have attribute "${attr}", but it does`
              : `Expected element to have attribute "${attr}", but it does not`;
          },
        };
      },

      /** Check if element has specific class */
      toHaveClass(element: Element, className: string): { pass: boolean; message: () => string } {
        const pass = element.classList.contains(className);
        return {
          pass,
          message: () =>
            pass
              ? `Expected element not to have class "${className}", but it does`
              : `Expected element to have class "${className}", but it has "${element.className}"`,
        };
      },

      /** Check if element is visible (no display:none, visibility:hidden, hidden attr) */
      toBeVisible(element: Element): { pass: boolean; message: () => string } {
        const htmlEl = element as HTMLElement;
        const isHiddenAttr = element.hasAttribute("hidden");
        const style = htmlEl.style;
        const isDisplayNone = style?.display === "none";
        const isVisibilityHidden = style?.visibility === "hidden";
        const isOpacityZero = style?.opacity === "0";
        const pass = !isHiddenAttr && !isDisplayNone && !isVisibilityHidden && !isOpacityZero;
        return {
          pass,
          message: () => {
            if (pass) {
              return "Expected element to be hidden, but it is visible";
            }
            const reasons: string[] = [];
            if (isHiddenAttr) reasons.push('has "hidden" attribute');
            if (isDisplayNone) reasons.push("has display:none");
            if (isVisibilityHidden) reasons.push("has visibility:hidden");
            if (isOpacityZero) reasons.push("has opacity:0");
            return `Expected element to be visible, but it ${reasons.join(" and ")}`;
          },
        };
      },

      /** Check if element is disabled */
      toBeDisabled(element: Element): { pass: boolean; message: () => string } {
        const isDisabledProp = (element as HTMLButtonElement).disabled === true;
        const isDisabledAttr = element.hasAttribute("disabled");
        const isAriaDisabled = element.getAttribute("aria-disabled") === "true";
        const pass = isDisabledProp || isDisabledAttr || isAriaDisabled;
        return {
          pass,
          message: () =>
            pass ? "Expected element not to be disabled, but it is" : "Expected element to be disabled, but it is not",
        };
      },

      /** Check if element has focus */
      toHaveFocus(element: Element): { pass: boolean; message: () => string } {
        const pass = document.activeElement === element;
        return {
          pass,
          message: () =>
            pass
              ? "Expected element not to have focus, but it does"
              : `Expected element to have focus, but active element is <${document.activeElement?.tagName?.toLowerCase() || "none"}>`,
        };
      },

      /** Check if element has specific style */
      toHaveStyle(element: HTMLElement, style: Record<string, string>): { pass: boolean; message: () => string } {
        const mismatches: string[] = [];
        for (const [prop, expected] of Object.entries(style)) {
          // Convert camelCase to kebab-case for getPropertyValue
          const kebabProp = prop.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
          const actual = element.style.getPropertyValue(kebabProp);
          if (actual !== expected) {
            mismatches.push(`${prop}: expected "${expected}" but got "${actual}"`);
          }
        }
        const pass = mismatches.length === 0;
        return {
          pass,
          message: () =>
            pass
              ? "Expected element not to have the specified styles, but it does"
              : `Style mismatches: ${mismatches.join("; ")}`,
        };
      },
    },
  };
}

// ─── Cypress Adapter ────────────────────────────────────────────────────────

/**
 * Create a Cypress-compatible component mounting helper.
 * Returns utilities for mounting SibuJS components in Cypress tests.
 */
export function createCypressAdapter() {
  return {
    /** Mount a component for Cypress component testing */
    mount(
      component: (() => HTMLElement) | HTMLElement,
      options?: { container?: HTMLElement },
    ): {
      element: HTMLElement;
      container: HTMLElement;
    } {
      const container = options?.container || document.createElement("div");
      if (!options?.container) {
        container.setAttribute("data-testenv", "cypress");
        document.body.appendChild(container);
      }
      const element = typeof component === "function" ? component() : component;
      container.appendChild(element);
      return { element, container };
    },

    /** Generate Cypress custom commands for SibuJS */
    commands: {
      /** Find by data-testid */
      getByTestId: (id: string): string => `[data-testid="${id}"]`,
      /** Find by text */
      getByText: (text: string): string => `:contains("${text}")`,
      /** Find by role */
      getByRole: (role: string): string => `[role="${role}"]`,
    },
  };
}

// ─── Playwright Adapter ─────────────────────────────────────────────────────

/**
 * Create a Playwright-compatible test helper.
 * Provides page object patterns for SibuJS components.
 */
export function createPlaywrightAdapter() {
  return {
    /** Selectors for common SibuJS patterns */
    selectors: {
      byTestId: (id: string): string => `[data-testid="${id}"]`,
      byRole: (role: string): string => `[role="${role}"]`,
      byAriaLabel: (label: string): string => `[aria-label="${label}"]`,
      byDataAttr: (attr: string, value?: string): string => (value ? `[data-${attr}="${value}"]` : `[data-${attr}]`),
    },

    /** Generate a page object for a SibuJS component */
    createPageObject(
      name: string,
      selectors: Record<string, string>,
    ): {
      name: string;
      getSelector: (key: string) => string;
      allSelectors: () => Record<string, string>;
    } {
      const selectorMap = { ...selectors };
      return {
        name,
        getSelector(key: string): string {
          const selector = selectorMap[key];
          if (!selector) {
            throw new Error(
              `Page object "${name}" has no selector for key "${key}". Available keys: ${Object.keys(selectorMap).join(", ")}`,
            );
          }
          return selector;
        },
        allSelectors(): Record<string, string> {
          return { ...selectorMap };
        },
      };
    },
  };
}

// ─── Universal Adapter ──────────────────────────────────────────────────────

/**
 * Framework-agnostic test adapter that works with any testing framework.
 */
export function createUniversalAdapter() {
  let container: HTMLElement | null = null;

  return {
    /** Setup test environment */
    setup(): HTMLElement {
      container = document.createElement("div");
      container.setAttribute("data-testenv", "universal");
      document.body.appendChild(container);
      return container;
    },

    /** Teardown test environment */
    teardown(): void {
      if (container) {
        container.innerHTML = "";
        if (container.parentNode) {
          container.parentNode.removeChild(container);
        }
        container = null;
      }
    },

    /** Render component */
    render(component: (() => HTMLElement) | HTMLElement): { element: HTMLElement; container: HTMLElement } {
      if (!container) {
        container = document.createElement("div");
        container.setAttribute("data-testenv", "universal");
        document.body.appendChild(container);
      }
      const element = typeof component === "function" ? component() : component;
      container.appendChild(element);
      return { element, container };
    },

    /** Query helpers */
    queries: {
      byTestId(container: Element, id: string): Element | null {
        return container.querySelector(`[data-testid="${escSel(id)}"]`);
      },

      byRole(container: Element, role: string): Element | null {
        return container.querySelector(`[role="${escSel(role)}"]`);
      },

      byText(container: Element, text: string): Element | null {
        const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          if (walker.currentNode.textContent?.includes(text)) {
            return walker.currentNode.parentElement;
          }
        }
        return null;
      },

      byLabelText(container: Element, label: string): Element | null {
        // Try to find a label element with matching text
        const labels = container.querySelectorAll("label");
        for (const labelEl of Array.from(labels)) {
          if (labelEl.textContent?.includes(label)) {
            const forAttr = labelEl.getAttribute("for");
            if (forAttr) {
              // Use [id="..."] (not `#`) so ids with special characters match.
              return container.querySelector(`[id="${escSel(forAttr)}"]`);
            }
            // If no "for" attribute, look for a nested input
            const nested = labelEl.querySelector("input, select, textarea");
            if (nested) return nested;
          }
        }
        // Fallback: look for aria-label
        return container.querySelector(`[aria-label="${escSel(label)}"]`);
      },

      allByRole(container: Element, role: string): Element[] {
        return Array.from(container.querySelectorAll(`[role="${escSel(role)}"]`));
      },
    },

    /** Assertion helpers */
    assert: {
      textContent(el: Element, expected: string): void {
        const actual = el.textContent || "";
        if (!actual.includes(expected)) {
          throw new Error(`Expected text content to include "${expected}", but got "${actual}"`);
        }
      },

      attribute(el: Element, attr: string, value?: string): void {
        if (!el.hasAttribute(attr)) {
          throw new Error(`Expected element to have attribute "${attr}", but it does not`);
        }
        if (value !== undefined) {
          const actual = el.getAttribute(attr);
          if (actual !== value) {
            throw new Error(`Expected attribute "${attr}" to be "${value}", but got "${actual}"`);
          }
        }
      },

      visible(el: Element): void {
        const htmlEl = el as HTMLElement;
        const reasons: string[] = [];
        if (el.hasAttribute("hidden")) reasons.push('has "hidden" attribute');
        if (htmlEl.style?.display === "none") reasons.push("has display:none");
        if (htmlEl.style?.visibility === "hidden") reasons.push("has visibility:hidden");
        if (reasons.length > 0) {
          throw new Error(`Expected element to be visible, but it ${reasons.join(" and ")}`);
        }
      },

      disabled(el: Element): void {
        const isDisabled =
          (el as HTMLButtonElement).disabled === true ||
          el.hasAttribute("disabled") ||
          el.getAttribute("aria-disabled") === "true";
        if (!isDisabled) {
          throw new Error("Expected element to be disabled, but it is not");
        }
      },

      className(el: Element, name: string): void {
        if (!el.classList.contains(name)) {
          throw new Error(`Expected element to have class "${name}", but it has "${el.className}"`);
        }
      },
    },
  };
}
