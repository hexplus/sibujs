import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { div } from "../src/core/rendering/html";
import { sanitizeCSSValue } from "../src/utils/sanitize";

// ---------------------------------------------------------------------------
// The de-duplication caches are bounded, and the bound must not re-open the
// flood it exists to prevent.
//
// Both caches were written as:
//
//     if (seen.has(key)) return "";
//     if (seen.size < MAX) seen.add(key);
//     return message;
//
// which is correct right up to the cap and wrong immediately after it. Once
// `size` reaches MAX nothing more is inserted, so `has(key)` is permanently
// false for every new key — and the message is still returned. The 101st
// distinct mistake therefore warns on EVERY render, forever: precisely the
// per-element flood the cache was added to stop, just deferred.
//
// Past the cap the caches now go quiet, after one notice saying so. Silence
// that announces itself is honest; silence that does not is how this whole
// class of bug started.
//
// This file lives on its own because filling a cache to its cap is global to
// the module, and would leak into any other test in the same file.
// ---------------------------------------------------------------------------

const CAP = 100;

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

const hits = (needle: string) => warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes(needle)).length;

// Each cap can only be crossed ONCE per module instance, so each is exercised
// in a single test. Splitting the crossing across two tests would leave the
// second asserting against a cache another test had already filled — which is
// how the first draft of this file passed for the wrong reason.
describe("lone-string warning cache past its cap", () => {
  it("goes quiet after the cap, announcing once instead of warning per render", () => {
    // Fill the cache with CAP distinct mistakes. Each is a genuine
    // two-utility-token class string, so each warns exactly once.
    for (let i = 0; i < CAP; i++) div(`mt-${i} mb-${i}`);
    expect(hits("looks like a class list")).toBeGreaterThanOrEqual(CAP);

    // One more DISTINCT mistake, rendered repeatedly — a list of rows, say.
    // Before the fix this produced one warning per render, forever.
    warn.mockClear();
    for (let i = 0; i < 50; i++) div("pt-9 pb-9");

    expect(hits("looks like a class list")).toBe(0);
    expect(hits("suppressing further")).toBe(1);

    // And the notice itself does not repeat.
    warn.mockClear();
    for (let i = 0; i < 20; i++) div(`px-${i} py-${i}`);
    expect(hits("suppressing further")).toBe(0);
    expect(hits("looks like a class list")).toBe(0);
  });
});

describe("style-sanitizer warning cache past its cap", () => {
  it("goes quiet after the cap, announcing once instead of warning per recomputation", () => {
    for (let i = 0; i < CAP; i++) sanitizeCSSValue(`url(/fill-${i}.png)`, { property: `background-image-${i}` });
    expect(hits("was dropped by the style sanitizer")).toBeGreaterThanOrEqual(CAP);

    // A reactive style recomputing every frame with a blocked value.
    warn.mockClear();
    for (let i = 0; i < 50; i++) sanitizeCSSValue("url(/overflow.png)", { property: "background-image" });

    expect(hits("was dropped by the style sanitizer")).toBe(0);
    expect(hits("suppressing further")).toBe(1);

    warn.mockClear();
    for (let i = 0; i < 20; i++) sanitizeCSSValue(`url(/more-${i}.png)`, { property: "background-image" });
    expect(hits("suppressing further")).toBe(0);
  });

  it("still returns the empty string for every blocked value after the cap", () => {
    // Reporting is capped; the SECURITY decision never is. Whatever happens to
    // the warning, the dangerous declaration must still be dropped.
    for (let i = 0; i < CAP + 10; i++) {
      expect(sanitizeCSSValue(`url(/cap-${i}.png)`, { property: "background-image" })).toBe("");
    }
    expect(sanitizeCSSValue("url(/anything.png)")).toBe("");
    // And a safe value is still returned untouched.
    expect(sanitizeCSSValue("red")).toBe("red");
  });
});
