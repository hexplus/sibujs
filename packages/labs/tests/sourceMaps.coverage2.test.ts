import { describe, expect, it } from "vitest";
import { createErrorReporter, SibuError } from "../src/devtools/sourceMaps";

// Covers the previously-uncovered branches of src/devtools/sourceMaps.ts:
// merging context.props into an existing SibuError that lacks props, and an
// onError handler that itself throws being swallowed.

describe("createErrorReporter context merging", () => {
  it("merges context.props into an existing SibuError without props", () => {
    const reporter = createErrorReporter({ logToConsole: false });
    const err = new SibuError("render failed", { component: "Card" });
    expect(err.props).toBeUndefined();

    reporter.report(err, { props: { id: 7 } });

    const stored = reporter.getErrors();
    expect(stored).toHaveLength(1);
    expect(stored[0].props).toEqual({ id: 7 });
    // Component already set, so it is preserved.
    expect(stored[0].component).toBe("Card");
  });

  it("swallows an onError handler that throws", () => {
    const reporter = createErrorReporter({
      logToConsole: false,
      onError: () => {
        throw new Error("handler boom");
      },
    });

    expect(() => reporter.report(new Error("oops"))).not.toThrow();
    expect(reporter.getErrors()).toHaveLength(1);
  });
});
