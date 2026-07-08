import { describe, expect, it } from "vitest";
import { lintRules } from "../src/build/linting";

// Covers the previously-uncovered branches of src/build/linting.ts:
// no-signals-in-conditionals flagging a signal called inside a deeply nested
// function, and no-direct-dom-mutation honoring a sibujs-disable-next-line
// comment on the preceding line.

describe("no-signals-in-conditionals nested function", () => {
  it("flags a signal call inside a deeply nested function (functionDepth > 1)", () => {
    const source = [
      "function Component() {",
      "  function handler() {",
      "    function inner() {",
      "      const c = signal(0);",
      "      return c;",
      "    }",
      "    return inner;",
      "  }",
      "  return handler;",
      "}",
    ].join("\n");

    const violations = lintRules["no-signals-in-conditionals"].check(source);
    expect(violations.some((v) => v.message.includes("nested function"))).toBe(true);
  });
});

describe("no-direct-dom-mutation inline disable", () => {
  it("ignores a line preceded by a sibujs-disable-next-line for the rule", () => {
    const source = ["// sibujs-disable-next-line no-direct-dom-mutation", 'el.innerHTML = "<b>hi</b>";'].join("\n");

    const violations = lintRules["no-direct-dom-mutation"].check(source);
    expect(violations).toHaveLength(0);
  });

  it("ignores a line preceded by a bare sibujs-disable-next-line", () => {
    const source = ["// sibujs-disable-next-line", 'el.innerHTML = "<b>hi</b>";'].join("\n");

    const violations = lintRules["no-direct-dom-mutation"].check(source);
    expect(violations).toHaveLength(0);
  });

  it("still flags a mutation when the disable comment lists other rules with a space", () => {
    const source = ["// sibujs-disable-next-line other-rule and-more", 'el.innerHTML = "<b>hi</b>";'].join("\n");

    const violations = lintRules["no-direct-dom-mutation"].check(source);
    expect(violations.length).toBeGreaterThan(0);
  });
});
