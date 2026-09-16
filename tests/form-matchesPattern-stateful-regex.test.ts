import { describe, expect, it } from "vitest";
import { form, matchesPattern } from "../src/ui/form";

// ---------------------------------------------------------------------------
// matchesPattern() is deterministic for global and sticky expressions.
//
// THE DEFECT: the validator called `regex.test(value)` directly. A `g` or `y`
// expression advances `lastIndex` on every successful match, so the same valid
// value alternated between valid and invalid — and one validator shared by two
// fields marked the second identical, valid field as invalid.
// ---------------------------------------------------------------------------

describe("matchesPattern with stateful regular expressions", () => {
  for (const flags of ["g", "y", "gy"]) {
    it(`gives the same answer on repeated calls with the "${flags}" flag`, () => {
      const digits = matchesPattern(new RegExp("^\\d+$", flags), "Digits only");

      for (let i = 0; i < 5; i++) {
        expect(digits("123")).toBeNull();
      }
      for (let i = 0; i < 5; i++) {
        expect(digits("12a")).toBe("Digits only");
      }
      expect(digits("456")).toBeNull();
    });
  }

  it("ignores a lastIndex the caller left behind", () => {
    const regex = /\d+/g;
    regex.lastIndex = 99;
    const digits = matchesPattern(regex, "Digits only");

    expect(digits("123")).toBeNull();
  });

  it("does not change the caller's lastIndex", () => {
    const regex = /\d+/y;
    regex.lastIndex = 2;
    const digits = matchesPattern(regex, "Digits only");

    digits("123");
    digits("abc");

    expect(regex.lastIndex).toBe(2);
  });

  it("two fields sharing one global-pattern validator are both valid", () => {
    const digits = matchesPattern(/^\d+$/g, "Digits only");
    const f = form({
      zip: { initial: "12345", validators: [digits] },
      code: { initial: "12345", validators: [digits] },
    });

    expect(f.fields.zip.error()).toBeNull();
    expect(f.fields.code.error()).toBeNull();
    expect(f.isValid()).toBe(true);

    let submitted = 0;
    f.handleSubmit(() => {
      submitted++;
    })();
    expect(submitted).toBe(1);

    // Re-validating after edits stays stable too.
    f.fields.zip.set("999");
    f.fields.code.set("999");
    expect(f.fields.zip.error()).toBeNull();
    expect(f.fields.code.error()).toBeNull();
    f.dispose();
  });
});
