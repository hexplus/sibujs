/**
 * `<meta http-equiv="refresh">` content is a GRAMMAR, not a substring.
 *
 * The old detection asked whether the lower-cased content contained
 * `url=javascript:` (and three siblings). That recognises exactly one spelling
 * of a directive the browser's refresh parser accepts in many: whitespace
 * around the separator and the `=`, quoted destinations, mixed-case `URL`, and
 * mixed-case schemes all produce a live redirect that the substring never sees.
 *
 * So the destination is now EXTRACTED by a parser and then handed to the same
 * `sanitizeUrl()` authority every other URL sink uses — rather than pattern-
 * matched. Where the parse is ambiguous the directive is dropped, because
 * "no forbidden substring was found" is not evidence of safety.
 *
 * The table below is the contract. Each row pins a decision, including the
 * malformed rows, so a future change to the parser cannot quietly reclassify
 * anything.
 */

import { describe, expect, it } from "vitest";
import { parseMetaRefreshContent, resolveMetaRefreshPolicy } from "../src/utils/metaRefresh";

/** Build the attribute map the policy consumes. */
const attrs = (httpEquiv: string, content: string) =>
  new Map([
    ["http-equiv", httpEquiv],
    ["content", content],
  ]);

const FORBIDDEN: string[] = [
  // The one spelling the old substring check caught.
  "0;url=javascript:alert(1)",
  // …and every spelling it did not.
  "0; url = javascript:alert(1)",
  "0;URL=JAVASCRIPT:alert(1)",
  "0;url='javascript:alert(1)'",
  '0;url="javascript:alert(1)"',
  '0 ; URL = "data:text/html,<script>1</script>"',
  "0; url = blob:https://example.com/id",
  "0; url = vbscript:msgbox(1)",
  "0;url=data:text/html,<script>alert(1)</script>",
  // Whitespace forms the browser tolerates.
  "0;\turl\t=\tjavascript:alert(1)",
  "0;\nurl\n=\njavascript:alert(1)",
  "  0 ; url = javascript:alert(1)  ",
  "0;url =   'JaVaScRiPt:alert(1)'",
  // Obfuscation `sanitizeUrl()` already understands.
  "0;url=java\tscript:alert(1)",
  "0;url=javascript:alert(1)",
];

const ALLOWED: Array<{ content: string; destination: string }> = [
  { content: "5;url=/home", destination: "/home" },
  { content: "5; url = /home", destination: "/home" },
  { content: '5; URL="https://example.com/path"', destination: "https://example.com/path" },
  { content: "0;url=#section", destination: "#section" },
  { content: "0; URL = '/local'", destination: "/local" },
  { content: "10;url=https://example.com/a?b=1&c=2", destination: "https://example.com/a?b=1&c=2" },
];

const DELAY_ONLY: Array<{ content: string; delay: number }> = [
  { content: "5", delay: 5 },
  { content: "  0  ", delay: 0 },
  { content: "30", delay: 30 },
];

/**
 * Forms whose meaning is not unambiguous. Every one is DROPPED: passing them
 * through because no forbidden substring appeared is precisely the reasoning
 * the parser exists to replace.
 */
const MALFORMED: string[] = [
  // Unmatched quotes — where does the destination end?
  '0;url="javascript:alert(1)',
  "0;url='javascript:alert(1)",
  '0;url="/safe',
  // Competing assignments.
  "0;url=/safe;url=javascript:alert(1)",
  "0;url=javascript:alert(1);url=/safe",
  // Missing or malformed delay.
  ";url=/safe",
  "abc;url=/safe",
  "-1;url=/safe",
  // Missing separator between delay and url.
  "0url=/safe",
  // Empty assignment.
  "0;url=",
  "0;url=''",
  '0;url=""',
  // Trailing junk after a quoted destination.
  "0;url='/safe' garbage",
  // A key that is not `url`.
  "0;uri=/safe",
];

describe("parseMetaRefreshContent — forbidden destinations", () => {
  for (const content of FORBIDDEN) {
    it(`rejects ${JSON.stringify(content)}`, () => {
      const decision = resolveMetaRefreshPolicy(attrs("refresh", content));
      expect(decision.kind, `parsed as ${decision.kind}`).toBe("forbidden");
    });
  }

  it("reports a reason for every forbidden decision", () => {
    for (const content of FORBIDDEN) {
      const decision = resolveMetaRefreshPolicy(attrs("refresh", content));
      if (decision.kind !== "forbidden") throw new Error(`expected forbidden for ${content}`);
      expect(decision.reason.length).toBeGreaterThan(0);
    }
  });
});

describe("parseMetaRefreshContent — allowed destinations", () => {
  for (const { content, destination } of ALLOWED) {
    it(`allows ${JSON.stringify(content)}`, () => {
      const decision = resolveMetaRefreshPolicy(attrs("refresh", content));
      if (decision.kind !== "allowed") throw new Error(`expected allowed, got ${decision.kind}`);
      expect(decision.destination).toBe(destination);
      expect(decision.sanitizedDestination).toBe(destination);
    });
  }
});

describe("parseMetaRefreshContent — delay-only directives", () => {
  for (const { content, delay } of DELAY_ONLY) {
    it(`treats ${JSON.stringify(content)} as delay-only`, () => {
      const decision = resolveMetaRefreshPolicy(attrs("refresh", content));
      if (decision.kind !== "delay-only") throw new Error(`expected delay-only, got ${decision.kind}`);
      expect(decision.delay).toBe(delay);
    });
  }
});

describe("parseMetaRefreshContent — malformed input is dropped", () => {
  for (const content of MALFORMED) {
    it(`drops ${JSON.stringify(content)}`, () => {
      const decision = resolveMetaRefreshPolicy(attrs("refresh", content));
      // Conservative: anything we cannot read the way a browser would is
      // refused outright rather than emitted on the hope that it is inert.
      expect(decision.kind, `malformed input was accepted as ${decision.kind}`).toBe("forbidden");
    });
  }
});

describe("resolveMetaRefreshPolicy — non-refresh entries", () => {
  it("ignores a non-refresh http-equiv even with dangerous content", () => {
    const decision = resolveMetaRefreshPolicy(attrs("x-custom", "0;url=javascript:alert(1)"));
    expect(decision.kind).toBe("not-refresh");
  });

  it("ignores an entry with no http-equiv", () => {
    const decision = resolveMetaRefreshPolicy(new Map([["name", "description"]]));
    expect(decision.kind).toBe("not-refresh");
  });

  it("matches http-equiv case-insensitively", () => {
    for (const spelling of ["refresh", "REFRESH", "Refresh", " Refresh "]) {
      const decision = resolveMetaRefreshPolicy(attrs(spelling, "0;url=javascript:alert(1)"));
      expect(decision.kind, `${spelling} was not recognised as refresh`).toBe("forbidden");
    }
  });

  it("treats a refresh with no content as not actionable", () => {
    const decision = resolveMetaRefreshPolicy(new Map([["http-equiv", "refresh"]]));
    expect(decision.kind).toBe("not-refresh");
  });

  it("exposes the parser independently of the attribute policy", () => {
    expect(parseMetaRefreshContent("5;url=/home")).toMatchObject({ kind: "allowed", destination: "/home" });
    expect(parseMetaRefreshContent("5")).toMatchObject({ kind: "delay-only", delay: 5 });
    expect(parseMetaRefreshContent("0;url=javascript:alert(1)").kind).toBe("forbidden");
  });
});

describe("duplicate case-insensitive attribute names", () => {
  it("rejects an entry carrying two spellings of http-equiv", () => {
    const decision = resolveMetaRefreshPolicy(
      new Map([
        ["http-equiv", "x-custom"],
        ["HTTP-EQUIV", "refresh"],
        ["content", "0;url=javascript:alert(1)"],
      ]),
    );
    // Validating the first match while the DOM commits the second is the whole
    // bug; the entry is refused rather than resolved by precedence.
    expect(decision.kind).toBe("forbidden");
  });

  it("rejects an entry carrying two spellings of content", () => {
    const decision = resolveMetaRefreshPolicy(
      new Map([
        ["HTTP-EQUIV", "refresh"],
        ["content", "5;url=/safe"],
        ["CONTENT", "0;url=data:text/html,x"],
      ]),
    );
    expect(decision.kind).toBe("forbidden");
  });

  it("rejects duplicates even when both values are safe", () => {
    const decision = resolveMetaRefreshPolicy(
      new Map([
        ["content", "5;url=/a"],
        ["CONTENT", "5;url=/a"],
        ["http-equiv", "refresh"],
      ]),
    );
    expect(decision.kind, "the duplicate rule must not depend on the values").toBe("forbidden");
  });

  it("accepts a single spelling in any casing", () => {
    for (const [equivKey, contentKey] of [
      ["HTTP-EQUIV", "CONTENT"],
      ["Http-Equiv", "Content"],
      ["http-equiv", "content"],
    ] as const) {
      const decision = resolveMetaRefreshPolicy(
        new Map([
          [equivKey, "refresh"],
          [contentKey, "5;url=/home"],
        ]),
      );
      expect(decision.kind, `${equivKey}/${contentKey} was refused`).toBe("allowed");
    }
  });
});
