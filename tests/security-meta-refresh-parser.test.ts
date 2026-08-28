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
import {
  findDuplicateAttributeName,
  parseMetaRefreshContent,
  planMetaEntry,
  resolveMetaRefreshPolicy,
} from "../src/utils/metaRefresh";

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

/**
 * The shared PIPELINE, as distinct from the parser.
 *
 * `planMetaEntry` is what fixes the order every rendering target must follow —
 * raw duplicate names, then name filtering, then value resolution, then
 * sanitization, then the refresh verdict on the effective snapshot. Calling the
 * same policy function at different points in three different pipelines is
 * exactly how the client and the two servers came to disagree, so the order is
 * pinned here rather than left to each caller.
 */
describe("planMetaEntry — the shared pipeline", () => {
  /** A minimal policy: emit everything, coerce to string, sanitize nothing. */
  const passthrough = {
    isEmittableName: () => true,
    resolveValue: (_name: string, value: string) => value,
  };

  it("returns the effective attributes for an accepted entry", () => {
    const plan = planMetaEntry({ name: "description", content: "A page" }, passthrough);
    if (plan.kind !== "publish") throw new Error(`expected publish, got ${plan.reason}`);
    expect(Object.fromEntries(plan.attributes)).toEqual({ name: "description", content: "A page" });
    expect(plan.refresh.kind).toBe("not-refresh");
  });

  it("drops a forbidden refresh and reports why", () => {
    const plan = planMetaEntry({ "http-equiv": "refresh", content: "0;url=javascript:1" }, passthrough);
    expect(plan.kind).toBe("drop");
    if (plan.kind === "drop") expect(plan.reason.length).toBeGreaterThan(0);
  });

  it("checks duplicate names BEFORE the name filter", () => {
    // Both handlers would be filtered away, so a duplicate check that ran after
    // filtering would see a perfectly ordinary description entry. This is the
    // exact ordering the client got wrong.
    const plan = planMetaEntry(
      { name: "description", content: "ok", onload: "a", ONLOAD: "b" },
      { isEmittableName: (n) => !n.toLowerCase().startsWith("on"), resolveValue: (_n, v: string) => v },
    );
    expect(plan.kind).toBe("drop");
  });

  it("checks duplicate names before resolving any value", () => {
    // A duplicate is a property of the authored NAMES, so no getter should need
    // to run to detect one.
    let reads = 0;
    const plan = planMetaEntry<string | (() => string)>(
      {
        "http-equiv": "refresh",
        "HTTP-EQUIV": "x-custom",
        content: () => {
          reads++;
          return "5;url=/home";
        },
      },
      {
        isEmittableName: () => true,
        resolveValue: (_n, v) => (typeof v === "function" ? v() : v),
        isReactiveValue: (v) => typeof v === "function",
      },
    );
    expect(plan.kind).toBe("drop");
    expect(reads, "a getter ran for an entry already known to be rejected").toBe(0);
  });

  it("validates the SANITIZED value, not the authored one", () => {
    // The sanitizer here rewrites the destination into a dangerous one. If the
    // verdict were computed before sanitization it would approve a snapshot that
    // is not the one committed.
    const plan = planMetaEntry(
      { "http-equiv": "refresh", content: "5;url=/home" },
      {
        isEmittableName: () => true,
        resolveValue: (_n, v: string) => v,
        sanitizeValue: (name, value) => (name === "content" ? "0;url=javascript:alert(1)" : value),
      },
    );
    expect(plan.kind, "the verdict was computed on a value that is not committed").toBe("drop");
  });

  it("drops an attribute whose sanitizer returns null", () => {
    const plan = planMetaEntry(
      { name: "x", content: "ok", href: "javascript:1" },
      {
        isEmittableName: () => true,
        resolveValue: (_n, v: string) => v,
        sanitizeValue: (name, value) => (name === "href" ? null : value),
      },
    );
    if (plan.kind !== "publish") throw new Error("expected publish");
    expect(plan.attributes.has("href")).toBe(false);
    expect(plan.attributes.get("content")).toBe("ok");
  });

  it("withholds a refresh directive from a REACTIVE entry, safe or not", () => {
    for (const content of ["5;url=/home", "30"]) {
      const plan = planMetaEntry<string | (() => string)>(
        { "http-equiv": "refresh", content: () => content },
        {
          isEmittableName: () => true,
          resolveValue: (_n, v) => (typeof v === "function" ? v() : v),
          isReactiveValue: (v) => typeof v === "function",
        },
      );
      // The parse itself still succeeds — this is a PUBLICATION rule. A browser
      // schedules the navigation when the element is inserted, and removing it
      // afterwards is not a defined cancellation, so what cannot be withdrawn is
      // never handed over.
      expect(parseMetaRefreshContent(content).kind).not.toBe("forbidden");
      expect(plan.kind, `${content} was published from a reactive entry`).toBe("drop");
    }
  });

  it("publishes a reactive entry that is not a refresh directive", () => {
    const plan = planMetaEntry<string | (() => string)>(
      { name: "description", content: () => "hello" },
      {
        isEmittableName: () => true,
        resolveValue: (_n, v) => (typeof v === "function" ? v() : v),
        isReactiveValue: (v) => typeof v === "function",
      },
    );
    if (plan.kind !== "publish") throw new Error("an ordinary reactive entry was withheld");
    expect(plan.attributes.get("content")).toBe("hello");
  });

  it("publishes a STATIC refresh directive unchanged", () => {
    const plan = planMetaEntry({ "http-equiv": "refresh", content: "5;url=/home" }, passthrough);
    if (plan.kind !== "publish") throw new Error("a static safe refresh was withheld");
    expect(plan.refresh.kind).toBe("allowed");
    expect(plan.attributes.get("content")).toBe("5;url=/home");
  });
});

describe("findDuplicateAttributeName", () => {
  it("reports the folded name of the first repeat", () => {
    expect(findDuplicateAttributeName(["http-equiv", "content", "HTTP-EQUIV"])).toBe("http-equiv");
  });

  it("returns null when every name is distinct under folding", () => {
    expect(findDuplicateAttributeName(["NAME", "Content", "id"])).toBeNull();
  });

  it("returns null for an empty entry", () => {
    expect(findDuplicateAttributeName([])).toBeNull();
  });
});
