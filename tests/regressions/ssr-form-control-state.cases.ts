// Form-control state cases shared by the jsdom and server-DOM suites: each
// builds a control and states the exact server HTML it must produce, so the two
// DOM implementations are held to the same bytes.

import { html } from "../../src/core/rendering/htm";
import { input, option, pre, select, textarea } from "../../src/core/rendering/html";
import type { InputProps, SelectProps } from "../../src/core/rendering/tagPropTypes";
import { signal } from "../../src/core/signals/signal";
import { bindField, form } from "../../src/ui/form";

export interface FormStateCase {
  name: string;
  build: () => Node;
  html: string;
}

const options = () => [option({ value: "a" }, "A"), option({ value: "b" }, "B")];

export function formStateCases(): FormStateCase[] {
  const f = form({
    email: { initial: "a@b.c" },
    agree: { initial: true },
    declined: { initial: false },
    tags: { initial: ["x", "z"] },
  });
  const [picked] = signal("b");
  return [
    {
      name: "bindField on a text input",
      build: () => input(bindField(f.fields.email, { type: "email" })),
      html: '<input value="a@b.c" type="email" />',
    },
    {
      name: "bindField on a checked checkbox",
      build: () => input(bindField(f.fields.agree, { type: "checkbox" }) as unknown as InputProps),
      html: '<input type="checkbox" checked="" />',
    },
    {
      name: "bindField on an unchecked checkbox",
      build: () => input({ type: "checkbox", ...bindField(f.fields.declined) } as unknown as InputProps),
      html: '<input type="checkbox" />',
    },
    {
      name: "bindField on a multiple select",
      build: () =>
        select(bindField(f.fields.tags, { multiple: true }) as unknown as SelectProps, [
          option({ value: "x" }, "X"),
          option({ value: "y" }, "Y"),
          option({ value: "z" }, "Z"),
        ]),
      html:
        '<select multiple=""><option value="x" selected="">X</option><option value="y">Y</option>' +
        '<option value="z" selected="">Z</option></select>',
    },
    {
      name: "html template select with a static runtime value",
      build: () => html`<select value=${"b"}><option value="a">A</option><option value="b">B</option></select>` as Node,
      html: '<select><option value="a">A</option><option value="b" selected="">B</option></select>',
    },
    {
      name: "html template select with a reactive value",
      build: () =>
        html`<select value=${() => picked()}><option value="a">A</option><option value="b">B</option></select>` as Node,
      html: '<select><option value="a">A</option><option value="b" selected="">B</option></select>',
    },
    {
      name: "html template textarea with a reactive value",
      build: () => html`<textarea value=${() => "typed"}></textarea>` as Node,
      html: "<textarea>typed</textarea>",
    },
    {
      name: "textarea value starting with a newline",
      build: () => textarea({ value: () => "\nline" }),
      html: "<textarea>\n\nline</textarea>",
    },
    {
      name: "pre text starting with a newline",
      build: () => pre("\nline"),
      html: "<pre>\n\nline</pre>",
    },
    {
      name: "checkbox checked imperatively",
      build: () =>
        input({
          type: "checkbox",
          onElement: (el) => {
            el.checked = true;
          },
        }),
      html: '<input type="checkbox" checked="" />',
    },
    {
      name: "radio unchecked imperatively over a checked attribute",
      build: () =>
        input({
          type: "radio",
          checked: "",
          onElement: (el: HTMLInputElement) => {
            el.checked = false;
          },
        } as never),
      html: '<input type="radio" />',
    },
    {
      name: "input value set imperatively",
      build: () =>
        input({
          value: "default",
          onElement: (el) => {
            el.value = "live";
          },
        }),
      html: '<input value="live" />',
    },
    {
      name: "textarea value set imperatively",
      build: () =>
        textarea({
          onElement: (el) => {
            el.value = "live";
          },
        }),
      html: "<textarea>live</textarea>",
    },
    {
      name: "select value set imperatively",
      build: () =>
        select(
          {
            onElement: (el) => {
              el.value = "b";
            },
          },
          options(),
        ),
      html: '<select><option value="a">A</option><option value="b" selected="">B</option></select>',
    },
    {
      name: "first option selected imperatively over a selected attribute",
      build: () =>
        select(
          {
            onElement: (el) => {
              el.selectedIndex = 0;
            },
          },
          [option({ value: "a" }, "A"), option({ value: "b", selected: "" } as never, "B")],
        ),
      // The stale attribute goes; the first option needs none, being the
      // drop-down's implicit default.
      html: '<select><option value="a">A</option><option value="b">B</option></select>',
    },
    {
      name: "a multiple select keeps every selected option",
      build: () =>
        select({ multiple: true }, [
          option({ value: "a", selected: true }, "A"),
          option({ value: "b" }, "B"),
          option({ value: "c", selected: true }, "C"),
        ]),
      html:
        '<select multiple=""><option value="a" selected="">A</option><option value="b">B</option>' +
        '<option value="c" selected="">C</option></select>',
    },
    {
      name: "a multiple select with nothing selected selects nothing",
      build: () => select({ multiple: true }, options()),
      html: '<select multiple=""><option value="a">A</option><option value="b">B</option></select>',
    },
    {
      name: "a drop-down's implicit default is not added",
      build: () => select(options()),
      html: '<select><option value="a">A</option><option value="b">B</option></select>',
    },
    {
      name: "a typed password is not serialized",
      build: () =>
        input({
          type: "password",
          onElement: (el) => {
            el.value = "secret";
          },
        }),
      html: '<input type="password" />',
    },
  ];
}
