/**
 * HTML attribute names are case-insensitive, so the IDL-synchronisation
 * decisions inside the shared attribute primitive must be too.
 *
 * `value`/`checked` are written through the IDL PROPERTY on a live update
 * because, once the user has typed or clicked, the content attribute no longer
 * reflects the control's state. That decision was made with case-sensitive
 * comparisons, so a binding declared as `"VALUE"` — which the browser treats as
 * exactly `value` — silently fell back to content-attribute semantics and left
 * the rendered control showing stale state.
 *
 * The normalisation is HTML-only: SVG attribute names ARE case-sensitive
 * (`viewBox`, `preserveAspectRatio`, `patternUnits`), so lowercasing there
 * would corrupt them.
 */

import { describe, expect, it } from "vitest";
import { svgElement } from "../src/platform/customElement";
import { bindAttribute } from "../src/reactivity/bindAttribute";
import { setSafeAttribute } from "../src/utils/setSafeAttribute";

describe("IDL synchronisation is case-insensitive for HTML", () => {
  it("writes VALUE through the IDL property after the control is dirtied", () => {
    const input = document.createElement("input");
    input.setAttribute("value", "initial");
    // User types — the live value diverges from the content attribute.
    input.value = "typed by user";

    bindAttribute(input, "VALUE", () => "new");

    expect(input.value, "VALUE did not reach the live IDL property").toBe("new");
  });

  it("writes lowercase value through the IDL property (control)", () => {
    const input = document.createElement("input");
    input.setAttribute("value", "initial");
    input.value = "typed by user";

    bindAttribute(input, "value", () => "new");

    expect(input.value).toBe("new");
  });

  it("writes CHECKED through the IDL property", () => {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = true;

    bindAttribute(input, "CHECKED", () => false);

    expect(input.checked, "CHECKED did not reach the live IDL property").toBe(false);
  });

  it("treats DISABLED as a boolean IDL attribute", () => {
    const input = document.createElement("input");
    input.disabled = true;

    setSafeAttribute(input, "DISABLED", false);

    expect(input.disabled).toBe(false);
  });

  it("treats SELECTED as a boolean IDL attribute", () => {
    const option = document.createElement("option");
    option.selected = true;

    setSafeAttribute(option, "SELECTED", false);

    expect(option.selected).toBe(false);
  });

  it("still applies the URL policy to a mixed-case HREF", () => {
    const a = document.createElement("a");
    setSafeAttribute(a, "HREF", "javascript:alert(1)");
    expect(a.getAttribute("HREF") ?? a.getAttribute("href") ?? "").not.toContain("javascript:");
  });
});

describe("SVG attribute names stay case-sensitive", () => {
  it("preserves camelCase SVG attribute names verbatim", () => {
    const svg = svgElement("svg", { viewBox: "0 0 10 10", preserveAspectRatio: "xMidYMid" });
    expect(svg.getAttribute("viewBox")).toBe("0 0 10 10");
    expect(svg.getAttribute("preserveAspectRatio")).toBe("xMidYMid");
    // Lowercasing would have produced a different, meaningless attribute.
    expect(svg.hasAttribute("viewbox")).toBe(false);
  });

  it("preserves camelCase on a pattern element", () => {
    const pattern = svgElement("pattern", { patternUnits: "userSpaceOnUse" });
    expect(pattern.getAttribute("patternUnits")).toBe("userSpaceOnUse");
  });

  it("does not apply HTML IDL semantics to an SVG element", () => {
    // `value` on an SVG element is an ordinary attribute, not an IDL property.
    const el = svgElement("text", { value: "x" });
    expect(el.getAttribute("value")).toBe("x");
  });
});
