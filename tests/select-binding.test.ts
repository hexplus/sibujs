import { beforeEach, describe, expect, test } from "vitest";
import { bindField, form } from "../src/ui/form";

describe("bindField — <select multiple> binding", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  function multiSelect(values: string[], selected: string[]): HTMLSelectElement {
    const sel = document.createElement("select");
    sel.multiple = true;
    for (const v of values) {
      const opt = document.createElement("option");
      opt.value = v;
      opt.selected = selected.includes(v);
      sel.appendChild(opt);
    }
    document.body.appendChild(sel);
    return sel;
  }

  test("a change on a <select multiple> sets the field to the array of selected values", () => {
    const f = form<{ tags: string[] }>({ tags: { initial: [] } });
    const props = bindField(f.fields.tags);

    const sel = multiSelect(["a", "b", "c"], ["a", "c"]);
    props.on.change({ target: sel } as unknown as Event);

    expect(f.fields.tags.value()).toEqual(["a", "c"]);
  });

  test("an empty multi-selection sets the field to an empty array (not the first value)", () => {
    const f = form<{ tags: string[] }>({ tags: { initial: ["x"] } });
    const props = bindField(f.fields.tags);

    const sel = multiSelect(["a", "b"], []);
    props.on.change({ target: sel } as unknown as Event);

    expect(f.fields.tags.value()).toEqual([]);
  });

  test("a single (non-multiple) <select> still sets the scalar value", () => {
    const f = form<{ color: string }>({ color: { initial: "" } });
    const props = bindField(f.fields.color);

    const sel = document.createElement("select");
    for (const v of ["red", "green"]) {
      const opt = document.createElement("option");
      opt.value = v;
      sel.appendChild(opt);
    }
    sel.value = "green";
    document.body.appendChild(sel);
    props.on.change({ target: sel } as unknown as Event);

    expect(f.fields.color.value()).toBe("green");
  });
});
