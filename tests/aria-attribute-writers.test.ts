/**
 * ARIA booleans serialize as "true"/"false" in EVERY attribute writer, native
 * boolean attributes keep presence semantics, and non-boolean ARIA values pass
 * through unchanged. Each writer is pinned separately because each one reaches
 * the shared commit primitive through its own path.
 */

import { afterEach, describe, expect, it } from "vitest";
import { compileHtmlTemplates } from "../src/build/compileTemplates";
import { html } from "../src/core/rendering/htm";
import { div, span } from "../src/core/rendering/html";
import { tagFactory } from "../src/core/rendering/tagFactory";
import { derived } from "../src/core/signals/derived";
import { signal } from "../src/core/signals/signal";
import { svgElement } from "../src/platform/customElement";
import { enhance } from "../src/platform/enhance";
import { collectStream, hydrate, renderToStream, renderToString } from "../src/platform/ssr";
import { bindAttribute, bindDynamic } from "../src/reactivity/bindAttribute";
import { bindAttrs, bindBoolAttr } from "../src/ui/reactiveAttr";

const SVG_NS = "http://www.w3.org/2000/svg";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("ARIA booleans across attribute writers", () => {
  it("tag factory props: static and reactive", () => {
    const [on, setOn] = signal(false);
    const el = div({ "aria-hidden": false, "aria-selected": on });
    expect(el.getAttribute("aria-hidden")).toBe("false");
    expect(el.getAttribute("aria-selected")).toBe("false");
    setOn(true);
    expect(el.getAttribute("aria-selected")).toBe("true");
  });

  it("bindBoolAttr(): static and reactive ARIA booleans serialize", () => {
    const el = document.createElement("div");
    bindBoolAttr(el, "aria-busy", false);
    expect(el.getAttribute("aria-busy")).toBe("false");

    const [on, setOn] = signal(false);
    bindBoolAttr(el, "aria-pressed", () => on());
    expect(el.getAttribute("aria-pressed")).toBe("false");
    setOn(true);
    expect(el.getAttribute("aria-pressed")).toBe("true");
  });

  it("documented migration: bindAttribute() with true | null writes or removes an ARIA attribute", () => {
    const el = document.createElement("div");
    const [busy, setBusy] = signal(true);
    bindAttribute(el, "aria-busy", () => (busy() ? true : null));
    expect(el.getAttribute("aria-busy")).toBe("true");
    setBusy(false);
    expect(el.hasAttribute("aria-busy")).toBe(false);
    setBusy(true);
    expect(el.getAttribute("aria-busy")).toBe("true");
  });

  it("bindBoolAttr(): native boolean attributes keep presence semantics", () => {
    const el = document.createElement("input");
    const [on, setOn] = signal(true);
    bindBoolAttr(el, "required", () => on());
    expect(el.getAttribute("required")).toBe("");
    setOn(false);
    expect(el.hasAttribute("required")).toBe(false);
  });

  it("bindAttrs() and bindDynamic()", () => {
    const el = document.createElement("div");
    const [on, setOn] = signal(false);
    bindAttrs(el, { "aria-expanded": () => on(), hidden: () => on() });
    bindDynamic(el, "aria-checked", () => on());
    expect(el.getAttribute("aria-expanded")).toBe("false");
    expect(el.getAttribute("aria-checked")).toBe("false");
    expect(el.hasAttribute("hidden")).toBe(false);
    setOn(true);
    expect(el.getAttribute("aria-expanded")).toBe("true");
    expect(el.getAttribute("aria-checked")).toBe("true");
    expect(el.getAttribute("hidden")).toBe("");
  });

  it("SVG elements: tag factory, svgElement() and bindAttribute()", () => {
    const svg = tagFactory("svg", SVG_NS);
    const icon = svg({ "aria-hidden": false }) as unknown as SVGElement;
    expect(icon.namespaceURI).toBe(SVG_NS);
    expect(icon.getAttribute("aria-hidden")).toBe("false");

    const path = svgElement("path", { "aria-hidden": true });
    expect(path.getAttribute("aria-hidden")).toBe("true");

    const [on, setOn] = signal(false);
    bindAttribute(path as unknown as HTMLElement, "aria-hidden", () => on());
    expect(path.getAttribute("aria-hidden")).toBe("false");
    setOn(true);
    expect(path.getAttribute("aria-hidden")).toBe("true");
  });

  it("html`` runtime templates: static and reactive expressions", () => {
    const [on, setOn] = signal(false);
    const el = html`<div aria-selected=${false} aria-pressed=${() => on()} hidden=${false}></div>`;
    expect(el.getAttribute("aria-selected")).toBe("false");
    expect(el.getAttribute("aria-pressed")).toBe("false");
    expect(el.hasAttribute("hidden")).toBe(false);
    setOn(true);
    expect(el.getAttribute("aria-pressed")).toBe("true");
  });

  it("compiled html`` templates produce the same attributes as the runtime parser", () => {
    const source =
      "const el = html`<div aria-selected=${sel} hidden=${hide}><svg aria-hidden=${iconHidden}></svg></div>`;";
    const result = compileHtmlTemplates(source);
    expect(result.code).not.toBeNull();
    const build = new Function(
      "div",
      "__sbTagFactory",
      "__sbSVG_NS",
      "sel",
      "hide",
      "iconHidden",
      `${result.code}\nreturn el;`,
    ) as (...args: unknown[]) => Element;

    const [on, setOn] = signal(false);
    const compiled = build(div, tagFactory, SVG_NS, () => on(), false, false);
    const runtime = html`<div aria-selected=${() => on()} hidden=${false}><svg aria-hidden=${false}></svg></div>`;

    for (const el of [compiled, runtime]) {
      expect(el.getAttribute("aria-selected")).toBe("false");
      expect(el.hasAttribute("hidden")).toBe(false);
      expect(el.firstElementChild?.getAttribute("aria-hidden")).toBe("false");
    }
    setOn(true);
    expect(compiled.getAttribute("aria-selected")).toBe("true");
    expect(runtime.getAttribute("aria-selected")).toBe("true");
  });

  it("enhance() attr()", () => {
    const root = document.createElement("div");
    root.innerHTML = `<button data-ref="toggle">x</button>`;
    document.body.appendChild(root);
    const [on, setOn] = signal(false);
    enhance(root, (ctx) => {
      ctx.attr("@toggle", "aria-pressed", () => on());
    });
    const button = root.querySelector("button") as HTMLButtonElement;
    expect(button.getAttribute("aria-pressed")).toBe("false");
    setOn(true);
    expect(button.getAttribute("aria-pressed")).toBe("true");
  });
});

describe("ARIA booleans in server output and hydration", () => {
  const Row = (selected: () => boolean) =>
    div({ role: "row", "aria-selected": selected, hidden: false }, [span({ "aria-hidden": true }, "cell")]);

  it("renderToString()", () => {
    const out = renderToString(Row(() => false));
    expect(out).toContain('aria-selected="false"');
    expect(out).toContain('aria-hidden="true"');
    expect(out).not.toContain('hidden=""');
  });

  it("renderToStream() matches renderToString()", async () => {
    const streamed = await collectStream(renderToStream(Row(() => false)));
    expect(streamed).toContain('aria-selected="false"');
    expect(streamed).toBe(renderToString(Row(() => false)));
  });

  it("hydrate() keeps the serialized state and stays reactive", () => {
    const [selected, setSelected] = signal(false);
    const container = document.createElement("div");
    container.innerHTML = renderToString(Row(() => false));
    document.body.appendChild(container);

    hydrate(() => Row(selected) as HTMLElement, container);
    const row = container.querySelector('[role="row"]') as HTMLElement;
    expect(row.getAttribute("aria-selected")).toBe("false");
    setSelected(true);
    expect(row.getAttribute("aria-selected")).toBe("true");
  });
});

describe("non-boolean ARIA values pass through", () => {
  it('token strings such as aria-checked="mixed"', () => {
    const [state, setState] = signal<boolean | "mixed">("mixed");
    const el = div({ role: "checkbox", "aria-checked": state });
    expect(el.getAttribute("aria-checked")).toBe("mixed");
    setState(false);
    expect(el.getAttribute("aria-checked")).toBe("false");
    setState(true);
    expect(el.getAttribute("aria-checked")).toBe("true");
  });

  it("numeric values, including 0", () => {
    const [now, setNow] = signal(0);
    const el = div({ role: "slider", "aria-valuenow": now, "aria-level": 2 });
    expect(el.getAttribute("aria-valuenow")).toBe("0");
    expect(el.getAttribute("aria-level")).toBe("2");
    setNow(42.5);
    expect(el.getAttribute("aria-valuenow")).toBe("42.5");
  });

  it("null and undefined remove ARIA attributes", () => {
    const [label, setLabel] = signal<string | null | undefined>("Name");
    const el = div({ "aria-label": label });
    expect(el.getAttribute("aria-label")).toBe("Name");
    setLabel(null);
    expect(el.hasAttribute("aria-label")).toBe(false);
    setLabel("Again");
    setLabel(undefined);
    expect(el.hasAttribute("aria-label")).toBe(false);
  });

  it("a derived boolean serializes like a signal", () => {
    const [n, setN] = signal(1);
    const positive = derived(() => n() > 0);
    const el = div({ "aria-invalid": () => !positive() });
    expect(el.getAttribute("aria-invalid")).toBe("false");
    setN(-1);
    expect(el.getAttribute("aria-invalid")).toBe("true");
  });
});
