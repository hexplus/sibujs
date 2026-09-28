// @vitest-environment node
//
// The REAL no-DOM branch: no `document`, so `sanitizeStyleAttribute` cannot
// delegate to CSSOM and must use the structural declaration-list path. Exercised
// through the server APIs that reach it without a DOM.

import { describe, expect, it } from "vitest";
import { serializeHeadEntry } from "../src/utils/headEntry";
import { sanitizeStyleAttribute } from "../src/utils/sanitize";

describe("style sanitization without a DOM", () => {
  it("runs with no document", () => {
    expect(typeof document).toBe("undefined");
  });

  it("PoC: drops only the unsafe declaration", () => {
    expect(sanitizeStyleAttribute("color:red;background-image:url(javascript:alert(1));margin:1rem")).toBe(
      "color: red; margin: 1rem",
    );
  });

  it("keeps quoted semicolons inside one declaration", () => {
    expect(sanitizeStyleAttribute('content: "a;b"; color: blue')).toBe('content: "a;b"; color: blue');
  });

  it("server-emitted head attributes use the same declaration-level policy", () => {
    const html = serializeHeadEntry("link", {
      rel: "preload",
      href: "/a.css",
      style: "display: none; background: url(https://x.example/a)",
    });
    expect(html).toContain('style="display: none"');
    expect(html).not.toContain("x.example");
  });
});
