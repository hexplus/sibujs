// @vitest-environment jsdom
//
// Form-control state in server HTML. `checked`, `selected` and a reactive
// `value` are committed to the IDL property, which a serializer never reads, so
// the server HTML used to arrive with no radio checked, no option selected and
// empty fields — and an adopted island changed visibly on takeover. On the
// server the writer now mirrors that state into the markup, and the serializer
// reads live state set any other way.

import { afterEach, describe, expect, it } from "vitest";
import { html } from "../../src/core/rendering/htm";
import { div, input, option, select, textarea } from "../../src/core/rendering/html";
import type { InputProps } from "../../src/core/rendering/tagPropTypes";
import { signal } from "../../src/core/signals/signal";
import { runInSSRContext } from "../../src/core/ssr-context";
import { hydrate } from "../../src/platform/ssr";
import { renderToStringAsync } from "../../src/platform/ssrAsync";
import { bindField, form } from "../../src/ui/form";
import { setSafeAttribute } from "../../src/utils/setSafeAttribute";
import { formStateCases } from "./ssr-form-control-state.cases";

afterEach(() => {
  document.body.replaceChildren();
});

function Form() {
  const [on] = signal(true);
  const [txt] = signal("hello");
  return div({ class: "form" }, [
    input({ type: "radio", name: "a", checked: true }),
    input({ type: "checkbox", checked: () => on() }),
    input({ type: "checkbox", checked: () => !on() }),
    input({ class: "static", value: "static" }),
    input({ class: "reactive", value: () => txt() }),
    textarea({ class: "static", value: "static" }),
    textarea({ class: "reactive", value: () => txt() }),
    select({ class: "opt-static" }, [option({ value: "a" }, "A"), option({ value: "b", selected: true }, "B")]),
    select({ class: "opt-reactive" }, [option({ value: "a" }, "A"), option({ value: "b", selected: () => on() }, "B")]),
    select({ class: "val-static", value: "b" }, [option({ value: "a" }, "A"), option({ value: "b" }, "B")]),
    select({ class: "val-reactive", value: () => "b" }, [option({ value: "a" }, "A"), option({ value: "b" }, "B")]),
  ]);
}

/** Every control's live state, in document order. */
function stateOf(root: Element): unknown[] {
  return Array.from(root.querySelectorAll("input, textarea, select")).map((el) => {
    if (el instanceof HTMLInputElement) return el.type === "text" ? el.value : el.checked;
    if (el instanceof HTMLTextAreaElement) return el.value;
    return (el as HTMLSelectElement).value;
  });
}

/** The live state of `root` and every control in it. */
function controlState(root: Element): unknown[] {
  const els = [root, ...Array.from(root.querySelectorAll("*"))];
  return els.map((el) => {
    if (el instanceof HTMLInputElement) return [el.type, el.checked, el.value];
    if (el instanceof HTMLTextAreaElement) return el.value;
    if (el instanceof HTMLSelectElement) return Array.from(el.selectedOptions, (o) => o.value);
    return el.textContent;
  });
}

const EXPECTED = [true, true, false, "static", "hello", "static", "hello", "b", "b", "b", "b"];

describe("form-control state in server HTML", () => {
  it("serializes checked, selected and value as markup", async () => {
    const { html } = await renderToStringAsync(Form);

    expect(html).toContain('<input type="radio" name="a" checked="" />');
    expect(html).toContain('<input type="checkbox" checked="" />');
    expect(html).toContain('<input type="checkbox" />');
    expect(html).toContain('<input class="reactive" value="hello" />');
    expect(html).toContain('<textarea class="static">static</textarea>');
    expect(html).toContain('<textarea class="reactive">hello</textarea>');
    expect(html).not.toMatch(/<(textarea|select)[^>]* value=/);
    expect(html.match(/<option value="b" selected="">/g)).toHaveLength(4);
    expect(html).not.toContain('<option value="a" selected');
  });

  it("parses back to the state the client renders", async () => {
    const { html } = await renderToStringAsync(Form);
    const container = document.createElement("div");
    container.innerHTML = html;

    expect(stateOf(container)).toEqual(EXPECTED);
    expect(stateOf(Form())).toEqual(EXPECTED);
  });

  it("does not change any control when an adopting hydration takes over", async () => {
    const { html } = await renderToStringAsync(Form, { hydration: "adopt" });
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);
    const before = stateOf(container);

    const result = await hydrate(Form, container, { strategy: "adopt", onMismatch: () => {} });

    expect(before).toEqual(EXPECTED);
    expect(stateOf(container)).toEqual(EXPECTED);
    expect(result?.mismatches ?? []).toEqual([]);
  });

  it("keeps the markup in step with later writes during the render", () => {
    runInSSRContext(() => {
      const box = input({ type: "checkbox" });
      setSafeAttribute(box, "checked", true);
      expect(box.hasAttribute("checked")).toBe(true);
      setSafeAttribute(box, "checked", false);
      expect(box.hasAttribute("checked")).toBe(false);

      const a = option({ value: "a", selected: true }, "A");
      const b = option({ value: "b" }, "B");
      const single = select([a, b]);
      setSafeAttribute(b, "selected", true);
      expect([a.hasAttribute("selected"), b.hasAttribute("selected")]).toEqual([false, true]);

      setSafeAttribute(single, "value", "a");
      expect([a.hasAttribute("selected"), b.hasAttribute("selected")]).toEqual([true, false]);
      setSafeAttribute(single, "value", "missing");
      expect([a.hasAttribute("selected"), b.hasAttribute("selected")]).toEqual([false, false]);

      const c = option({ value: "c", selected: true }, "C");
      const d = option({ value: "d" }, "D");
      select({ multiple: true }, [c, d]);
      setSafeAttribute(d, "selected", true);
      expect([c.hasAttribute("selected"), d.hasAttribute("selected")]).toEqual([true, true]);

      const area = textarea();
      setSafeAttribute(area, "value", "one");
      setSafeAttribute(area, "value", "two");
      expect(area.textContent).toBe("two");
    });
  });

  for (const c of formStateCases()) {
    it(`${c.name}: same server HTML as the server DOM`, async () => {
      const { html } = await renderToStringAsync(c.build);
      expect(html.replace(' data-sibu-ssr="true"', "")).toBe(c.html);
    });

    // A typed password is deliberately left out of serialized markup.
    if (c.name.includes("password")) continue;
    it(`${c.name}: parses back to the state the client renders`, async () => {
      const { html } = await renderToStringAsync(c.build);
      const container = document.createElement("div");
      container.innerHTML = html;
      expect(controlState(container.firstElementChild as Element)).toEqual(controlState(c.build() as Element));
    });
  }

  it("bindField keeps a checkbox's `checked` in step with its boolean field", () => {
    const f = form({ agree: { initial: true } });
    const props = bindField(f.fields.agree);
    const box = input({ type: "checkbox", ...props } as unknown as InputProps);

    expect(props.value()).toBe(true);
    expect(box.checked).toBe(true);
    expect(box.hasAttribute("value")).toBe(false);
    f.fields.agree.set(false);
    expect(box.checked).toBe(false);
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    expect(f.fields.agree.value()).toBe(true);
  });

  it("an html template select follows its reactive value on the client", () => {
    const [picked, setPicked] = signal("b");
    const el =
      html`<select value=${() => picked()}><option value="a">A</option><option value="b">B</option></select>` as HTMLSelectElement;
    expect(el.value).toBe("b");
    setPicked("a");
    expect(el.value).toBe("a");
  });

  it("leaves a client render's markup alone: live state stays on the property", () => {
    const box = input({ type: "checkbox", checked: () => true });
    const field = input({ value: () => "typed" });
    const b = option({ value: "b", selected: () => true }, "B");

    expect(box.checked).toBe(true);
    expect(box.hasAttribute("checked")).toBe(false);
    expect(field.value).toBe("typed");
    expect(field.hasAttribute("value")).toBe(false);
    expect(b.hasAttribute("selected")).toBe(false);
  });
});
