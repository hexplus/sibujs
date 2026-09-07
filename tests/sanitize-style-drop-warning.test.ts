import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { div } from "../src/core/rendering/html";
import { sanitizeCSSValue, sanitizeStyleAttribute } from "../src/utils/sanitize";

// ---------------------------------------------------------------------------
// A dropped style declaration must ANNOUNCE ITSELF in dev.
//
// The guard is correct and stays: `url()` in an inline style is a real
// exfiltration channel (it issues a request whose path can carry data), so the
// declaration is removed. What was wrong is that removal was SILENT. A
// consumer's images rendered as empty boxes across five renderers with nothing
// in any console, because "background-image: url(/poster.jpg)" simply
// evaporated between the author writing it and the browser seeing it.
//
// These tests pin the diagnostic: which declaration, on which element, why it
// went, and what to do instead.
// ---------------------------------------------------------------------------

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

function messages(): string[] {
  return warn.mock.calls.map((c) => String(c[0]));
}

describe("sanitizeStyleAttribute — announcing dropped declarations", () => {
  it("warns naming the property and the reason when a url() declaration is dropped", () => {
    const out = sanitizeStyleAttribute("color: red; background-image: url(/poster.jpg)");

    // The guard still applies — the url() declaration is gone, the rest stays.
    expect(out).toContain("color");
    expect(out).not.toContain("url(");

    const msg = messages().join("\n");
    expect(msg).toContain("background-image");
    expect(msg).toContain("was dropped by the style sanitizer");
  });

  it("names <img> as the sanctioned alternative for a legitimate image", () => {
    // A distinct URL from the test above on purpose: identical declarations on
    // the same element are deduplicated so a reactive style cannot flood the
    // console, and reusing the value here would assert against a suppressed
    // warning rather than a real one.
    sanitizeStyleAttribute("background-image: url(/banner-for-img-advice.jpg)");
    expect(messages().join("\n")).toMatch(/<img>/);
  });

  it("quotes the offending value so the author can find it in their source", () => {
    sanitizeStyleAttribute("background: url(https://cdn.example.com/a.png) no-repeat");
    expect(messages().join("\n")).toContain("cdn.example.com/a.png");
  });

  it("stays silent when nothing is dropped", () => {
    const out = sanitizeStyleAttribute("color: red; margin: 0");
    expect(out).toContain("color");
    expect(messages()).toHaveLength(0);
  });

  it("warns once per dropped declaration, not once per style attribute", () => {
    sanitizeStyleAttribute("background-image: url(/a.png); border-image: url(/b.png)");
    const dropWarnings = messages().filter((m) => m.includes("was dropped by the style sanitizer"));
    expect(dropWarnings).toHaveLength(2);
  });

  it("warns for the OBJECT form too, not only the string form", () => {
    // The object form goes through sanitizeCSSValue per property, which is the
    // path `style: { backgroundImage: … }` takes. It dropped just as silently.
    const out = sanitizeCSSValue("url(/poster.jpg)");
    expect(out).toBe("");
    expect(messages().join("\n")).toContain("was dropped by the style sanitizer");
  });

  it("identifies the element the declaration was dropped from", () => {
    div({ id: "hero", class: "banner", style: "background-image: url(/poster.jpg)" });
    const msg = messages().join("\n");
    // Enough of a fingerprint to locate the element in a page full of divs.
    expect(msg).toContain("div");
    expect(msg).toContain("hero");
  });
});
