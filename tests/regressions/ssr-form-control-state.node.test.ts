// @vitest-environment node
//
// The report's reproduction on the built-in server DOM (no DOM library
// registered): form-control state reaches the server HTML.

import { describe, expect, it } from "vitest";
import { div, input, option, select, textarea } from "../../src/core/rendering/html";
import { signal } from "../../src/core/signals/signal";
import { renderToStringAsync } from "../../src/platform/ssrAsync";
import { formStateCases } from "./ssr-form-control-state.cases";

describe("form-control state on the server DOM", () => {
  it("serializes checked, selected and reactive value", async () => {
    const [on] = signal(true);
    const [txt] = signal("hello");
    const { html } = await renderToStringAsync(() =>
      div([
        input({ type: "radio", checked: true }),
        input({ type: "radio", checked: () => on() }),
        input({ value: () => txt() }),
        textarea({ value: () => txt() }),
        select([option({ value: "a" }, "A"), option({ value: "b", selected: true }, "B")]),
        select({ value: () => "b" }, [option({ value: "a" }, "A"), option({ value: "b" }, "B")]),
      ]),
    );
    expect(html).toBe(
      '<div data-sibu-ssr="true"><input type="radio" checked="" /><input type="radio" checked="" />' +
        '<input value="hello" /><textarea>hello</textarea>' +
        '<select><option value="a">A</option><option value="b" selected="">B</option></select>' +
        '<select><option value="a">A</option><option value="b" selected="">B</option></select></div>',
    );
  });

  for (const c of formStateCases()) {
    it(c.name, async () => {
      const { html } = await renderToStringAsync(c.build);
      expect(html.replace(' data-sibu-ssr="true"', "")).toBe(c.html);
    });
  }
});
