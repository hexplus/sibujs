import { afterEach, describe, expect, it } from "vitest";
import { checkAriaAttributes, checkFormLabels, checkLinksAndButtons } from "../src/testing/a11y";

// Covers the previously-uncovered branches of src/testing/a11y.ts:
// hasAccessibleName resolving an aria-labelledby reference, checkInputHasLabel
// walking a non-resolving aria-labelledby id, and checkAriaAttributes flagging
// an invalid aria-* attribute on the root element itself.
//
// aria-labelledby resolution uses document.getElementById, so the roots that
// rely on it must be attached to the document.

const mounted: Element[] = [];
function mount(el: Element): Element {
  document.body.appendChild(el);
  mounted.push(el);
  return el;
}

afterEach(() => {
  for (const el of mounted.splice(0)) el.remove();
});

describe("hasAccessibleName via aria-labelledby", () => {
  it("treats a button as named when aria-labelledby points to text content", () => {
    const root = document.createElement("div");
    const label = document.createElement("span");
    label.id = "lbl-1";
    label.textContent = "Save changes";
    const button = document.createElement("button");
    button.setAttribute("aria-labelledby", "lbl-1");
    root.appendChild(label);
    root.appendChild(button);
    mount(root);

    const violations = checkLinksAndButtons(root);
    // The button has an accessible name, so no missing-name violation for it.
    expect(violations.some((v) => v.element === button)).toBe(false);
  });

  it("still flags a button whose aria-labelledby points at empty/absent ids", () => {
    const root = document.createElement("div");
    const button = document.createElement("button");
    button.setAttribute("aria-labelledby", "missing-a missing-b");
    root.appendChild(button);

    const violations = checkLinksAndButtons(root);
    expect(violations.some((v) => v.element === button)).toBe(true);
  });
});

describe("checkFormLabels via aria-labelledby", () => {
  it("accepts an input labelled by an existing element", () => {
    const root = document.createElement("form");
    const lbl = document.createElement("span");
    lbl.id = "field-label";
    lbl.textContent = "Email";
    const input = document.createElement("input");
    input.type = "text";
    input.setAttribute("aria-labelledby", "field-label");
    root.appendChild(lbl);
    root.appendChild(input);
    mount(root);

    const violations = checkFormLabels(root);
    expect(violations.some((v) => v.element === input)).toBe(false);
  });

  it("flags an input whose aria-labelledby resolves to nothing", () => {
    const root = document.createElement("form");
    const input = document.createElement("input");
    input.type = "text";
    input.setAttribute("aria-labelledby", "does-not-exist");
    root.appendChild(input);

    const violations = checkFormLabels(root);
    expect(violations.some((v) => v.element === input)).toBe(true);
  });
});

describe("checkAriaAttributes on the root element", () => {
  it("flags an invalid aria-* attribute placed on the root element", () => {
    const root = document.createElement("div");
    root.setAttribute("aria-notarealattribute", "x");

    const violations = checkAriaAttributes(root);
    expect(violations.some((v) => v.element === root && v.message.includes("Invalid ARIA attribute"))).toBe(true);
  });

  it("does not flag a valid aria-* attribute on the root element", () => {
    const root = document.createElement("div");
    root.setAttribute("aria-label", "Region");

    const violations = checkAriaAttributes(root);
    expect(violations.some((v) => v.element === root)).toBe(false);
  });
});
