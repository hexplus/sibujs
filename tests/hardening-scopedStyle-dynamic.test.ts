/**
 * Scoped-style coverage of dynamically-created descendants.
 *
 * The scope contract is "this component's CSS applies to this component's
 * subtree". Stamping every descendant once at render time only satisfies that
 * for the nodes that existed at render time: any node a signal, `each()`, or a
 * conditional inserts later is outside the contract and renders unstyled.
 */

import { afterEach, describe, expect, it } from "vitest";
import { div, span } from "../src/core/rendering/html";
import { scopedStyle, withScopedStyle } from "../src/ui/scopedStyle";

function injectedCss(scope: string): string {
  const el = document.head.querySelector(`style[data-sibu-scope="${scope}"]`);
  return el?.textContent ?? "";
}

function allScopedCss(): string {
  return Array.from(document.head.querySelectorAll("style[data-sibu-scope]"))
    .map((el) => el.textContent ?? "")
    .join("\n");
}

afterEach(() => {
  for (const el of Array.from(document.head.querySelectorAll("style[data-sibu-scope]"))) el.remove();
});

/**
 * Does `css` actually select `node` in `root`? Evaluated by matching the
 * generated selectors against the live DOM, which is what the contract means —
 * not by inspecting which attributes happen to be stamped where.
 */
function selectorsMatching(css: string, root: HTMLElement, node: Element): boolean {
  const selectors = Array.from(css.matchAll(/([^{}]+)\{/g)).map((m) => m[1].trim());
  root.ownerDocument.body.appendChild(root);
  try {
    for (const selector of selectors) {
      if (!selector || selector.startsWith("@")) continue;
      for (const part of selector.split(",")) {
        const s = part.trim();
        if (!s) continue;
        try {
          if (node.matches(s)) return true;
        } catch {
          // Unsupported selector in jsdom — ignore.
        }
      }
    }
    return false;
  } finally {
    root.remove();
  }
}

describe("withScopedStyle — dynamic descendants", () => {
  it("styles a descendant that existed at render time", () => {
    const Component = withScopedStyle<Record<string, never>>(".child { color: red; }", () => {
      return div({ class: "root" }, span({ class: "child" }, "hi")) as HTMLElement;
    });

    const el = Component({});
    const child = el.querySelector(".child") as HTMLElement;
    expect(selectorsMatching(allScopedCss(), el, child)).toBe(true);
  });

  it("styles a descendant inserted AFTER the initial render", () => {
    const Component = withScopedStyle<Record<string, never>>(".child { color: red; }", () => {
      return div({ class: "root" }) as HTMLElement;
    });

    const el = Component({});
    // Simulate a reactive insertion (each(), a conditional, a signal update).
    const late = document.createElement("span");
    late.className = "child";
    el.appendChild(late);

    expect(selectorsMatching(allScopedCss(), el, late)).toBe(true);
  });

  it("styles a deeply nested late descendant", () => {
    const Component = withScopedStyle<Record<string, never>>(".leaf { color: red; }", () => {
      return div({ class: "root" }, div({ class: "mid" })) as HTMLElement;
    });

    const el = Component({});
    const mid = el.querySelector(".mid") as HTMLElement;
    const leaf = document.createElement("i");
    leaf.className = "leaf";
    mid.appendChild(leaf);

    expect(selectorsMatching(allScopedCss(), el, leaf)).toBe(true);
  });

  it("styles rows appended and re-appended like a keyed list", () => {
    const Component = withScopedStyle<Record<string, never>>(".row { color: red; }", () => {
      return div({ class: "list" }) as HTMLElement;
    });

    const el = Component({});
    const rows: HTMLElement[] = [];
    for (let i = 0; i < 3; i++) {
      const row = document.createElement("div");
      row.className = "row";
      el.appendChild(row);
      rows.push(row);
    }
    rows[1].remove();
    const replacement = document.createElement("div");
    replacement.className = "row";
    el.appendChild(replacement);

    const css = allScopedCss();
    expect(selectorsMatching(css, el, rows[0])).toBe(true);
    expect(selectorsMatching(css, el, rows[2])).toBe(true);
    expect(selectorsMatching(css, el, replacement)).toBe(true);
  });

  it("still styles the component root itself", () => {
    const Component = withScopedStyle<Record<string, never>>(".root { color: red; }", () => {
      return div({ class: "root" }) as HTMLElement;
    });

    const el = Component({});
    expect(selectorsMatching(allScopedCss(), el, el)).toBe(true);
  });

  it("does not leak one component's scope into another", () => {
    const A = withScopedStyle<Record<string, never>>(
      ".child { color: red; }",
      () => div({ class: "a" }, span({ class: "child" })) as HTMLElement,
    );
    const B = withScopedStyle<Record<string, never>>(
      ".child { color: blue; }",
      () => div({ class: "b" }, span({ class: "child" })) as HTMLElement,
    );

    const a = A({});
    const b = B({});
    const aScope = document.head.querySelectorAll("style[data-sibu-scope]")[0];
    const bScope = document.head.querySelectorAll("style[data-sibu-scope]")[1];

    const bChild = b.querySelector(".child") as HTMLElement;
    const aChild = a.querySelector(".child") as HTMLElement;

    expect(selectorsMatching(aScope.textContent ?? "", a, aChild)).toBe(true);
    expect(selectorsMatching(aScope.textContent ?? "", b, bChild)).toBe(false);
    expect(selectorsMatching(bScope.textContent ?? "", b, bChild)).toBe(true);
    expect(selectorsMatching(bScope.textContent ?? "", a, aChild)).toBe(false);
  });

  it("keeps a nested scoped component's own scope working", () => {
    const Inner = withScopedStyle<Record<string, never>>(
      ".leaf { color: blue; }",
      () => div({ class: "inner" }, span({ class: "leaf" })) as HTMLElement,
    );
    const Outer = withScopedStyle<Record<string, never>>(
      ".leaf { color: red; }",
      () => div({ class: "outer" }, Inner({})) as HTMLElement,
    );

    const outer = Outer({});
    const leaf = outer.querySelector(".leaf") as HTMLElement;
    const styles = Array.from(document.head.querySelectorAll("style[data-sibu-scope]"));
    const innerCss = styles.find((s) => (s.textContent ?? "").includes("blue"))?.textContent ?? "";

    expect(selectorsMatching(innerCss, outer, leaf)).toBe(true);
  });
});

describe("scopedStyle — selector generation", () => {
  it("keeps pseudo-classes on the generated selector", () => {
    const { scope } = scopedStyle(".btn:hover { color: red; }");
    const css = injectedCss(scope);
    // The pseudo-class must survive scoping; where the scope token is spliced
    // in is an implementation detail as long as the selector stays valid.
    expect(css).toContain(":hover");
    expect(css).toContain(scope);
  });

  it("keeps pseudo-elements last", () => {
    const { scope } = scopedStyle(".btn::before { content: 'x'; }");
    const css = injectedCss(scope);
    expect(css).toMatch(/::before\s*\{/);
  });

  it("preserves media queries", () => {
    const { scope } = scopedStyle("@media (min-width: 600px) { .btn { color: red; } }");
    const css = injectedCss(scope);
    expect(css).toContain("@media (min-width: 600px)");
    expect(css).toContain(".btn");
  });

  it("preserves keyframes without scoping the percentage selectors", () => {
    const { scope } = scopedStyle("@keyframes spin { from { opacity: 0; } to { opacity: 1; } }");
    const css = injectedCss(scope);
    expect(css).toContain("@keyframes spin");
    expect(css).not.toMatch(/from\s*\[data-/);
  });

  it("still strips dangerous constructs", () => {
    const { scope } = scopedStyle(".x { background: url(https://attacker.example/leak); }");
    const css = injectedCss(scope);
    expect(css).not.toContain("attacker.example");
  });

  // Anchoring the scope inside the FIRST compound is what makes descendant
  // matching work, and it is the part that is easy to get subtly wrong: a
  // combinator or a quoted value in the wrong place produces CSS the engine
  // silently discards, which looks exactly like "the stylesheet didn't load".
  // Each case is checked by PARSING the output, not by string comparison.
  const SELECTOR_CASES: Array<{ input: string; anchoredOn: string }> = [
    { input: ".a, .b { color: red; }", anchoredOn: ".a" },
    { input: ".a > .b { color: red; }", anchoredOn: ".a" },
    { input: "div.card:hover { color: red; }", anchoredOn: "div.card:hover" },
    { input: ".x:not(.y > .z) { color: red; }", anchoredOn: ".x:not(.y > .z)" },
    { input: 'input[data-a="p q"] { color: red; }', anchoredOn: 'input[data-a="p q"]' },
    { input: ".btn::before { content: 'x'; }", anchoredOn: ".btn" },
    { input: "ul li + li { color: red; }", anchoredOn: "ul" },
    { input: "* { box-sizing: border-box; }", anchoredOn: "*" },
  ];

  for (const { input, anchoredOn } of SELECTOR_CASES) {
    it(`produces valid, root-anchored CSS for ${JSON.stringify(input.split("{")[0].trim())}`, () => {
      const { scope, attr } = scopedStyle(input);
      const css = injectedCss(scope);

      // The engine must accept every generated rule. A selector it rejects is
      // dropped silently, so "it parsed" is the assertion that matters.
      const probe = document.createElement("style");
      probe.textContent = css;
      document.head.appendChild(probe);
      const ruleCount = probe.sheet ? probe.sheet.cssRules.length : 0;
      probe.remove();
      expect(ruleCount, `generated CSS was rejected by the parser: ${css}`).toBeGreaterThan(0);

      // The scope marker lands inside the first compound, not appended to the
      // end of the whole selector.
      expect(css).toContain(`${anchoredOn}[${attr}]`);
      // …and the descendant form is present too.
      expect(css).toContain(`[${attr}] `);
    });
  }
});
