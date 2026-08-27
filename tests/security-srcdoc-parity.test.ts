/**
 * `srcdoc` is an HTML-PARSING sink, not an inert attribute.
 *
 * The shared policy classified attributes into event handlers, URLs, `srcset`,
 * `style` — and "everything else passes through, because `setAttribute` stores
 * it as inert text". That last claim is false for exactly one attribute the
 * policy knew nothing about: the browser decodes `<iframe srcdoc>` and parses
 * it as a complete nested HTML document. Without a sandbox, scripts in that
 * document run with the embedding page's origin.
 *
 * Attribute escaping is not a defence here — it is the wrong layer entirely.
 * `srcdoc="&lt;script&gt;…"` is *correctly* escaped as an attribute and still
 * becomes `<script>…` once the browser parses the value as a document. So the
 * generic writers refuse it outright rather than trying to make it safe.
 *
 * Refusal is a POSTCONDITION, matching the `on*` rule: a writer that takes the
 * `srcdoc` slot removes whatever was already there, rather than merely
 * declining to add more.
 */

import { describe, expect, it } from "vitest";
import { html } from "../src/core/rendering/htm";
import { div } from "../src/core/rendering/html";
import { signal } from "../src/core/signals/signal";
import { svgElement } from "../src/platform/customElement";
import { enhance } from "../src/platform/enhance";
import { bindAttribute, bindDynamic } from "../src/reactivity/bindAttribute";
import { bindAttrs } from "../src/ui/reactiveAttr";
import { setSafeAttribute } from "../src/utils/setSafeAttribute";

const PAYLOAD = "<script>window.__XSS = true</script>";
const CASINGS = ["srcdoc", "SRCDOC", "SrcDoc"] as const;

/** Every public writer that can commit a generic attribute. */
interface Writer {
  name: string;
  /** Apply `value` to `attr` on a fresh iframe, returning the live element. */
  write(attr: string, value: string, existing?: string): HTMLElement;
}

function iframe(existing?: string): HTMLIFrameElement {
  const frame = document.createElement("iframe");
  if (existing !== undefined) frame.setAttribute("srcdoc", existing);
  return frame;
}

const WRITERS: Writer[] = [
  {
    name: "setSafeAttribute",
    write: (attr, value, existing) => {
      const el = iframe(existing);
      setSafeAttribute(el, attr, value);
      return el;
    },
  },
  {
    name: "bindAttribute",
    write: (attr, value, existing) => {
      const el = iframe(existing);
      bindAttribute(el, attr, () => value);
      return el;
    },
  },
  {
    name: "bindDynamic",
    write: (attr, value, existing) => {
      const el = iframe(existing);
      bindDynamic(el, attr, () => value);
      return el;
    },
  },
  {
    name: "bindAttrs (static)",
    write: (attr, value, existing) => {
      const el = iframe(existing);
      bindAttrs(el, { [attr]: value });
      return el;
    },
  },
  {
    name: "bindAttrs (reactive)",
    write: (attr, value, existing) => {
      const el = iframe(existing);
      bindAttrs(el, { [attr]: () => value });
      return el;
    },
  },
  {
    name: "enhance().attr()",
    write: (attr, value, existing) => {
      const root = document.createElement("div");
      const el = iframe(existing);
      el.id = "frame";
      root.appendChild(el);
      document.body.appendChild(root);
      enhance(root, ({ attr: bind }) => {
        bind("#frame", attr, () => value);
      });
      root.remove();
      return el;
    },
  },
];

describe("srcdoc is refused by every generic attribute writer", () => {
  for (const writer of WRITERS) {
    for (const casing of CASINGS) {
      it(`${writer.name} refuses ${casing}`, () => {
        const el = writer.write(casing, PAYLOAD);
        expect(el.hasAttribute("srcdoc"), `${writer.name} wrote ${casing}`).toBe(false);
        expect(el.hasAttribute(casing)).toBe(false);
      });

      it(`${writer.name} REMOVES a pre-existing srcdoc when taking the ${casing} slot`, () => {
        const el = writer.write(casing, PAYLOAD, "<p>server supplied</p>");
        expect(el.hasAttribute("srcdoc"), `${writer.name} left an existing srcdoc live`).toBe(false);
      });
    }
  }

  it("setSafeAttribute reports the refusal through its return value", () => {
    const el = iframe(PAYLOAD);
    const written = setSafeAttribute(el, "SRCDOC", PAYLOAD);
    expect(written).toBe(false);
    expect(el.hasAttribute("srcdoc")).toBe(false);
  });

  it("tagFactory refuses srcdoc without disturbing sibling props", () => {
    const el = div({ srcdoc: PAYLOAD, id: "keep", title: "kept" }) as HTMLElement;
    expect(el.hasAttribute("srcdoc")).toBe(false);
    expect(el.getAttribute("id")).toBe("keep");
    expect(el.getAttribute("title")).toBe("kept");
  });

  it("the html template refuses a dynamic srcdoc expression", () => {
    const el = html`<iframe srcdoc=${PAYLOAD} title="kept"></iframe>` as HTMLElement;
    expect(el.hasAttribute("srcdoc")).toBe(false);
    expect(el.getAttribute("title")).toBe("kept");
  });

  it("the html template refuses a MIXED srcdoc expression", () => {
    const el = html`<iframe srcdoc="<p>a</p>${PAYLOAD}"></iframe>` as HTMLElement;
    expect(el.hasAttribute("srcdoc")).toBe(false);
  });

  it("the html template refuses a mixed-case dynamic srcdoc", () => {
    const el = html`<iframe SRCDOC=${PAYLOAD}></iframe>` as HTMLElement;
    expect(el.hasAttribute("srcdoc")).toBe(false);
  });

  it("svgElement refuses srcdoc", () => {
    const el = svgElement("foreignObject", { srcdoc: PAYLOAD, width: "10" });
    expect(el.hasAttribute("srcdoc")).toBe(false);
    expect(el.getAttribute("width")).toBe("10");
  });

  it("leaves unrelated safe attributes untouched", () => {
    const el = iframe();
    el.setAttribute("title", "safe");
    setSafeAttribute(el, "srcdoc", PAYLOAD);
    expect(el.getAttribute("title")).toBe("safe");
  });
});

describe("reactive srcdoc transitions", () => {
  it("safe → unsafe leaves the attribute absent", () => {
    const el = iframe();
    const [value, setValue] = signal<string | null>(null);
    bindAttribute(el, "srcdoc", () => value());
    expect(el.hasAttribute("srcdoc")).toBe(false);

    setValue(PAYLOAD);
    expect(el.hasAttribute("srcdoc")).toBe(false);
  });

  it("pre-existing unsafe → binding installs → attribute removed", () => {
    const el = iframe("<p>existing</p>");
    expect(el.hasAttribute("srcdoc")).toBe(true);

    const [value] = signal(PAYLOAD);
    bindAttribute(el, "srcdoc", () => value());
    expect(el.hasAttribute("srcdoc")).toBe(false);
  });

  it("unsafe → null stays absent", () => {
    const el = iframe("<p>existing</p>");
    const [value, setValue] = signal<string | null>(PAYLOAD);
    bindAttribute(el, "srcdoc", () => value());
    expect(el.hasAttribute("srcdoc")).toBe(false);

    setValue(null);
    expect(el.hasAttribute("srcdoc")).toBe(false);
  });

  it("a bindDynamic name change onto srcdoc removes the previous attribute too", () => {
    const el = iframe();
    const [name, setName] = signal("title");
    bindDynamic(
      el,
      () => name(),
      () => PAYLOAD,
    );
    expect(el.getAttribute("title")).toBe(PAYLOAD);

    setName("srcdoc");
    expect(el.hasAttribute("srcdoc")).toBe(false);
    expect(el.hasAttribute("title"), "the previous attribute was stranded").toBe(false);
  });
});

describe("existing attribute policies remain intact", () => {
  it("blocks javascript: href across writers", () => {
    for (const w of WRITERS) {
      const el = w.write("href", "javascript:alert(1)");
      expect(el.getAttribute("href") ?? "", `${w.name} let javascript: through`).not.toContain("javascript:");
    }
  });

  it("blocks javascript: src across writers", () => {
    for (const w of WRITERS) {
      const el = w.write("src", "javascript:alert(1)");
      expect(el.getAttribute("src") ?? "").not.toContain("javascript:");
    }
  });

  it("validates srcset candidates", () => {
    const el = iframe();
    setSafeAttribute(el, "srcset", "javascript:alert(1) 1x, https://ok.example/a.png 2x");
    expect(el.getAttribute("srcset") ?? "").not.toContain("javascript:");
  });

  it("sanitizes style declaration lists", () => {
    const el = iframe();
    setSafeAttribute(el, "style", "background: url(https://attacker.example/x); color: red");
    const style = el.getAttribute("style") ?? "";
    expect(style).not.toContain("url(");
    expect(style).toContain("color");
  });

  it("still refuses on* handlers", () => {
    const el = iframe();
    el.setAttribute("onclick", "alert(1)");
    expect(setSafeAttribute(el, "onclick", "alert(2)")).toBe(false);
    expect(el.hasAttribute("onclick")).toBe(false);
  });

  it("keeps xlink:href in the xlink namespace and URL-filtered", () => {
    const safe = svgElement("use", { "xlink:href": "#icon" });
    expect(safe.getAttributeNS("http://www.w3.org/1999/xlink", "href")).toBe("#icon");

    const unsafe = svgElement("use", { "xlink:href": "javascript:alert(1)" });
    expect(unsafe.getAttributeNS("http://www.w3.org/1999/xlink", "href") ?? "").not.toContain("javascript:");
  });

  it("keeps null/undefined removal semantics", () => {
    const el = iframe();
    el.setAttribute("title", "before");
    setSafeAttribute(el, "title", null);
    expect(el.hasAttribute("title")).toBe(false);
  });

  it("keeps boolean attribute semantics", () => {
    const input = document.createElement("input");
    setSafeAttribute(input, "required", true);
    expect(input.getAttribute("required")).toBe("");
    setSafeAttribute(input, "required", false);
    expect(input.hasAttribute("required")).toBe(false);
  });

  it("keeps HTML IDL synchronisation case-insensitive", () => {
    const input = document.createElement("input");
    input.value = "typed";
    setSafeAttribute(input, "VALUE", "new");
    expect(input.value).toBe("new");
  });

  it("keeps SVG attribute names case-sensitive", () => {
    const svg = svgElement("svg", { viewBox: "0 0 10 10" });
    expect(svg.getAttribute("viewBox")).toBe("0 0 10 10");
    expect(svg.hasAttribute("viewbox")).toBe(false);
  });
});
