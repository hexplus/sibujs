/**
 * The no-DOM style path (SSR in a runtime without a CSS parser) must reach the
 * same per-declaration verdicts as the DOM path.
 *
 * It used to judge the whole attribute as ONE value, so a single blocked
 * declaration dropped every sibling with it — `color: red; background:
 * url(…); margin: 1rem` lost its color and margin on the server while the
 * client kept them. It now parses the declaration list structurally (quotes,
 * parentheses, escapes, comments) and runs each declaration through the same
 * `blockedDeclarationReason` the DOM path uses. Genuinely ambiguous input — an
 * unterminated string, unbalanced parentheses, braces — still fails closed.
 */

import { describe, expect, it } from "vitest";
import { sanitizeStyleAttribute, sanitizeStyleDeclarationList } from "../src/utils/sanitize";

/** The property names a sanitized declaration list kept, in order. */
function kept(out: string): string[] {
  return out
    .split(";")
    .map((d) => d.split(":")[0].trim())
    .filter(Boolean);
}

const PARITY: string[] = [
  "color: red; margin: 1rem",
  "color:red;background-image:url(javascript:alert(1));margin:1rem",
  "color: red; background: url('a;b.png'); margin: 1rem",
  'content: "a;b"; color: blue',
  "color: red !important; background: url(https://x.example/a) ; padding: 2px",
  "width: calc(100% - 2rem); height: expression(alert(1))",
  "--brand: #f06; color: var(--brand)",
  "--leak: url(https://x.example/a); color: green",
  "scroll-behavior: smooth; behavior: url(x.htc)",
  "background-image: image-set('https://x.example/a.png' 1x); opacity: 0.5",
  "COLOR: Red; Margin: 0",
  "/* note */ color: red; /* url(https://x.example) */ margin: 0",
  "background: u\\rl(https://x.example/a); color: red",
  "filter: progid:DXImageTransform.Microsoft.Alpha(opacity=50); color: red",
];

describe("no-DOM style sanitization matches the DOM path, declaration by declaration", () => {
  for (const css of PARITY) {
    it(JSON.stringify(css), () => {
      expect(kept(sanitizeStyleDeclarationList(css))).toEqual(kept(sanitizeStyleAttribute(css)));
    });
  }

  it("PoC: one blocked declaration no longer drops its safe siblings", () => {
    const out = sanitizeStyleDeclarationList("color:red;background-image:url(javascript:alert(1));margin:1rem");
    expect(out).toBe("color: red; margin: 1rem");
  });

  it("keeps !important and custom-property case", () => {
    expect(sanitizeStyleDeclarationList("color: red ! IMPORTANT; --MyVar: 1")).toBe(
      "color: red !important; --MyVar: 1",
    );
  });

  it("fails closed on input it cannot read unambiguously", () => {
    for (const css of [
      'content: "unterminated; color: red',
      "background: url(https://x.example/a; color: red",
      "color: red; } body { background: url(https://x.example/a)",
      "color: red /* unterminated comment",
      "width: calc(1px))",
    ]) {
      expect(sanitizeStyleDeclarationList(css), css).toBe("");
    }
  });

  it("skips empty declarations, as CSS Syntax does", () => {
    // Not in the parity table: jsdom's CSS parser drops everything after `;;`,
    // which browsers do not — empty declarations are simply skipped.
    expect(sanitizeStyleDeclarationList("color: red;;; margin: 0;")).toBe("color: red; margin: 0");
  });

  it("skips a declaration that is not one, keeping the rest", () => {
    expect(sanitizeStyleDeclarationList("color red; margin: 0; : x; 1bad: y")).toBe("margin: 0");
  });
});
