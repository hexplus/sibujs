/**
 * Scoped-style selector-list splitting must be SYNTAX-AWARE.
 *
 * The rewriter split selector preludes with a regex over commas. A comma is not
 * a list separator when it sits inside a functional pseudo-class
 * (`:is(.a, .b)`), an attribute value (`[data-v=","]`), or a string — so those
 * selectors were torn in half and each half scoped independently, producing CSS
 * the engine either rejects outright or, worse, accepts with the wrong meaning.
 *
 * Correctness is asserted by PARSING the generated sheet and by matching it
 * against real DOM, never by re-splitting the output with the same broken
 * assumption the fix removes.
 */

import { afterEach, describe, expect, it } from "vitest";
import { scopedStyle } from "../src/ui/scopedStyle";

function injectedCss(scope: string): string {
  return document.head.querySelector(`style[data-sibu-scope="${scope}"]`)?.textContent ?? "";
}

/** Parse with the engine and return the rules it actually accepted. */
function parsedRules(css: string): string[] {
  const probe = document.createElement("style");
  probe.textContent = css;
  document.head.appendChild(probe);
  const out: string[] = [];
  const sheet = probe.sheet;
  if (sheet) {
    for (let i = 0; i < sheet.cssRules.length; i++) {
      const rule = sheet.cssRules[i];
      out.push((rule as CSSStyleRule).selectorText ?? rule.cssText);
    }
  }
  probe.remove();
  return out;
}

/** Does the generated sheet actually select `node`? Uses whole selectorText. */
function matches(css: string, root: HTMLElement, node: Element): boolean {
  const probe = document.createElement("style");
  probe.textContent = css;
  document.head.appendChild(probe);
  document.body.appendChild(root);
  try {
    const sheet = probe.sheet;
    if (!sheet) return false;
    for (let i = 0; i < sheet.cssRules.length; i++) {
      const rule = sheet.cssRules[i] as CSSStyleRule;
      if (!rule.selectorText) continue;
      try {
        // Whole selectorText — CSSOM already normalised the list correctly.
        if (node.matches(rule.selectorText)) return true;
      } catch {
        /* selector unsupported by jsdom */
      }
    }
    return false;
  } finally {
    probe.remove();
    root.remove();
  }
}

afterEach(() => {
  for (const el of Array.from(document.head.querySelectorAll("style"))) el.remove();
});

describe("scopedStyle — commas inside functional pseudo-classes", () => {
  const CASES = [
    ":is(.a, .b) { color: red; }",
    ".x:not(.a, .b) { color: red; }",
    ":where(.a, .b) > .child { color: red; }",
    "button:is(.primary, .secondary):hover { color: red; }",
    ":is(.a, :is(.b, .c)) { color: red; }",
    '[data-value=","] .child { color: red; }',
    '[data-value="a,b"]:is(.p, .q) { color: red; }',
  ];

  for (const css of CASES) {
    it(`keeps ${JSON.stringify(css.split("{")[0].trim())} intact and parseable`, () => {
      const { scope, attr } = scopedStyle(css);
      const out = injectedCss(scope);

      const rules = parsedRules(out);
      expect(rules.length, `engine rejected the generated CSS: ${out}`).toBeGreaterThan(0);

      // The functional pseudo must survive whole — never split across the list.
      const fn = css.match(/:(is|not|where)\(([^)]*)\)/);
      if (fn) {
        expect(out, `functional pseudo was torn apart: ${out}`).toContain(`:${fn[1]}(${fn[2]})`);
      }
      expect(out).toContain(attr);
    });
  }

  it(":is(.a, .b) matches BOTH branches under the scope", () => {
    const { scope, attr } = scopedStyle(":is(.a, .b) { color: red; }");
    const css = injectedCss(scope);

    for (const cls of ["a", "b"]) {
      const root = document.createElement("div");
      root.setAttribute(attr, "");
      const child = document.createElement("span");
      child.className = cls;
      root.appendChild(child);
      expect(matches(css, root, child), `.${cls} did not match`).toBe(true);
    }
  });

  it(".x:not(.a, .b) excludes both branches", () => {
    const { scope, attr } = scopedStyle(".x:not(.a, .b) { color: red; }");
    const css = injectedCss(scope);

    const mk = (extra: string) => {
      const root = document.createElement("div");
      root.setAttribute(attr, "");
      const child = document.createElement("span");
      child.className = `x ${extra}`.trim();
      root.appendChild(child);
      return { root, child };
    };

    const plain = mk("");
    expect(matches(css, plain.root, plain.child)).toBe(true);
    for (const cls of ["a", "b"]) {
      const excluded = mk(cls);
      expect(matches(css, excluded.root, excluded.child), `.x.${cls} should be excluded`).toBe(false);
    }
  });

  it("still splits a genuine top-level selector list", () => {
    const { scope, attr } = scopedStyle(".a, .b { color: red; }");
    const css = injectedCss(scope);
    const rules = parsedRules(css);
    expect(rules.length).toBeGreaterThan(0);

    for (const cls of ["a", "b"]) {
      const root = document.createElement("div");
      root.setAttribute(attr, "");
      const child = document.createElement("span");
      child.className = cls;
      root.appendChild(child);
      expect(matches(css, root, child), `.${cls} did not match`).toBe(true);
    }
  });

  it("does not treat a comma inside an attribute value as a separator", () => {
    const { scope, attr } = scopedStyle('[data-value=","] { color: red; }');
    const css = injectedCss(scope);
    expect(parsedRules(css).length).toBeGreaterThan(0);

    const root = document.createElement("div");
    root.setAttribute(attr, "");
    root.setAttribute("data-value", ",");
    expect(matches(css, root, root)).toBe(true);
  });
});

describe("scopedStyle — at-rules and keyframes still preserved", () => {
  it("preserves @media and scopes the inner rule", () => {
    const { scope, attr } = scopedStyle("@media (min-width: 600px) { :is(.a, .b) { color: red; } }");
    const css = injectedCss(scope);
    expect(css).toContain("@media (min-width: 600px)");
    expect(css).toContain(":is(.a, .b)");
    expect(css).toContain(attr);
  });

  it("preserves @supports", () => {
    const { scope, attr } = scopedStyle("@supports (display: grid) { .a { color: red; } }");
    const css = injectedCss(scope);
    expect(css).toContain("@supports (display: grid)");
    expect(css).toContain(attr);
  });

  it("does not scope keyframe stops", () => {
    const { scope } = scopedStyle("@keyframes spin { from { opacity: 0; } to { opacity: 1; } 50% { opacity: .5; } }");
    const css = injectedCss(scope);
    expect(css).toContain("@keyframes spin");
    expect(css).not.toMatch(/from\s*\[data-/);
    expect(css).not.toMatch(/to\s*\[data-/);
    expect(css).not.toMatch(/50%\s*\[data-/);
  });
});
