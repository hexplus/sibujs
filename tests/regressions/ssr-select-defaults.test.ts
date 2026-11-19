// @vitest-environment jsdom
//
// Two follow-ups to form-control state in server HTML:
//
// 1. A static `select({ value })` establishes the select's RESET default (the
//    `selected` attributes of its options), on a client render, in the server
//    HTML, and after an adopting hydration — so `form.reset()` restores the
//    declared value everywhere. A reactive value changes only the current
//    selection, as a reactive input value does.
// 2. The serializer's selection snapshot belongs to one serialization of one
//    select: a fragment render (an option or optgroup without its select), a
//    repeated render, or a stream reads the live selection of that moment, and
//    never a snapshot an earlier render took.

import { afterEach, describe, expect, it } from "vitest";
import { html } from "../../src/core/rendering/htm";
import { form, optgroup, option, select } from "../../src/core/rendering/html";
import { signal } from "../../src/core/signals/signal";
import { collectStream, hydrate, renderToStream, renderToString } from "../../src/platform/ssr";
import { renderToStringAsync } from "../../src/platform/ssrAsync";

afterEach(() => {
  document.body.replaceChildren();
});

const App = () => form([select({ value: "b" }, [option({ value: "a" }, "A"), option({ value: "b" }, "B")])]);

/** The selected values and the `defaultSelected` flags of `el`'s options. */
function stateOf(el: HTMLSelectElement) {
  const options = Array.from(el.options);
  return {
    selected: options.filter((o) => o.selected).map((o) => o.value),
    defaults: options.filter((o) => o.defaultSelected).map((o) => o.value),
  };
}

/** Choose `value` the way a user does, with the events a user's choice fires. */
function choose(el: HTMLSelectElement, value: string): void {
  el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

async function serverMarkup(app: () => Node, adopt = true): Promise<HTMLElement> {
  const { html: markup } = await renderToStringAsync(app, adopt ? { hydration: "adopt" } : {});
  const container = document.createElement("div");
  container.innerHTML = markup;
  document.body.appendChild(container);
  return container;
}

describe("a static select value is the select's reset default", () => {
  it("on a client render: reset restores it after a user change", () => {
    const root = App() as HTMLFormElement;
    const el = root.querySelector("select") as HTMLSelectElement;
    expect(stateOf(el)).toEqual({ selected: ["b"], defaults: ["b"] });

    choose(el, "a");
    root.reset();
    expect(stateOf(el)).toEqual({ selected: ["b"], defaults: ["b"] });
  });

  it("in the server HTML parsed into a document", async () => {
    const container = await serverMarkup(App, false);
    const root = container.querySelector("form") as HTMLFormElement;
    const el = root.querySelector("select") as HTMLSelectElement;
    expect(stateOf(el)).toEqual({ selected: ["b"], defaults: ["b"] });

    choose(el, "a");
    root.reset();
    expect(stateOf(el)).toEqual({ selected: ["b"], defaults: ["b"] });
  });

  it("after an adopting hydration, which keeps the server's options and their default", async () => {
    const container = await serverMarkup(App);
    const root = container.querySelector("form") as HTMLFormElement;
    const el = root.querySelector("select") as HTMLSelectElement;
    const serverOptions = Array.from(el.options);
    root.reset();
    expect(stateOf(el)).toEqual({ selected: ["b"], defaults: ["b"] });

    const result = await hydrate(App, container, { strategy: "adopt" });
    expect(result?.mismatches ?? []).toEqual([]);
    expect(container.querySelector("select")).toBe(el);
    expect(Array.from(el.options)).toEqual(serverOptions);
    expect(stateOf(el)).toEqual({ selected: ["b"], defaults: ["b"] });

    choose(el, "a");
    root.reset();
    expect(stateOf(el)).toEqual({ selected: ["b"], defaults: ["b"] });
  });

  it("keeps a choice the user made before takeover, and reset still restores the declared default", async () => {
    const container = await serverMarkup(App);
    const root = container.querySelector("form") as HTMLFormElement;
    const el = root.querySelector("select") as HTMLSelectElement;
    el.value = "a"; // the user's choice, before the client code runs

    await hydrate(App, container, { strategy: "adopt" });
    expect(container.querySelector("select")).toBe(el);
    expect(stateOf(el)).toEqual({ selected: ["a"], defaults: ["b"] });

    root.reset();
    expect(stateOf(el)).toEqual({ selected: ["b"], defaults: ["b"] });
  });

  it("from an html template with a static runtime value", async () => {
    const Template = () =>
      html`<form><select value=${"b"}><option value="a">A</option><option value="b">B</option></select></form>` as Node;

    const root = Template() as HTMLFormElement;
    const el = root.querySelector("select") as HTMLSelectElement;
    expect(stateOf(el)).toEqual({ selected: ["b"], defaults: ["b"] });
    choose(el, "a");
    root.reset();
    expect(stateOf(el).selected).toEqual(["b"]);

    const container = await serverMarkup(Template);
    const adopted = container.querySelector("select") as HTMLSelectElement;
    await hydrate(Template, container, { strategy: "adopt" });
    expect(container.querySelector("select")).toBe(adopted);
    expect(stateOf(adopted)).toEqual({ selected: ["b"], defaults: ["b"] });
  });

  it("picks the first of several options with that value, as the value setter does", () => {
    const el = select({ value: "same" }, [
      option({ value: "x" }, "X"),
      option({ value: "same" }, "1"),
      option({ value: "same" }, "2"),
    ]) as HTMLSelectElement;
    expect(el.selectedIndex).toBe(1);
    expect(Array.from(el.options, (o) => o.defaultSelected)).toEqual([false, true, false]);
  });

  it("wins over an option's own static `selected`, as the value setter does", () => {
    const root = form([
      select({ value: "b" }, [option({ value: "a", selected: true }, "A"), option({ value: "b" }, "B")]),
    ]) as HTMLFormElement;
    const el = root.querySelector("select") as HTMLSelectElement;
    expect(stateOf(el)).toEqual({ selected: ["b"], defaults: ["b"] });
    choose(el, "a");
    root.reset();
    expect(stateOf(el).selected).toEqual(["b"]);
  });

  it("selects one option of a multiple select, the default included", () => {
    const root = form([
      select({ multiple: true, value: "b" }, [
        option({ value: "a" }, "A"),
        option({ value: "b" }, "B"),
        option({ value: "c" }, "C"),
      ]),
    ]) as HTMLFormElement;
    const el = root.querySelector("select") as HTMLSelectElement;
    expect(stateOf(el)).toEqual({ selected: ["b"], defaults: ["b"] });
    el.options[2].selected = true;
    root.reset();
    expect(stateOf(el)).toEqual({ selected: ["b"], defaults: ["b"] });
  });

  it("a reactive value changes the current selection only, as a reactive input value does", () => {
    const [picked, setPicked] = signal("b");
    const root = form([
      select({ value: () => picked() }, [option({ value: "a" }, "A"), option({ value: "b" }, "B")]),
    ]) as HTMLFormElement;
    const el = root.querySelector("select") as HTMLSelectElement;
    expect(stateOf(el)).toEqual({ selected: ["b"], defaults: [] });

    setPicked("a");
    expect(stateOf(el)).toEqual({ selected: ["a"], defaults: [] });
    setPicked("b");
    expect(stateOf(el)).toEqual({ selected: ["b"], defaults: [] });
    // No reset baseline was written: reset falls back to the markup's own
    // default, the first option.
    root.reset();
    expect(stateOf(el).selected).toEqual(["a"]);
  });
});

// ─── Selection snapshots ────────────────────────────────────────────────────

/** Whether each option of `el` carries `selected` in `markup`, in order. */
function markedIn(markup: string, values: string[]): boolean[] {
  return values.map((v) => new RegExp(`<option value="${v}"[^>]* selected=""`).test(markup));
}

/** Every option's live and default selectedness: the source DOM, for "nothing was mutated" checks. */
function sourceState(el: HTMLSelectElement) {
  return Array.from(el.options, (o) => [o.selected, o.hasAttribute("selected")]);
}

/** The selection a document gives `markup` (a `<select>` or its options) back. */
function parsedSelection(markup: string, multiple = false): string[] {
  const host = document.createElement("div");
  host.innerHTML = markup.startsWith("<select") ? markup : `<select${multiple ? " multiple" : ""}>${markup}</select>`;
  const el = host.querySelector("select") as HTMLSelectElement;
  return Array.from(el.selectedOptions, (o) => o.value);
}

describe("the serializer's selection snapshot belongs to one serialization", () => {
  it("renders an option fragment from the live selection, not an earlier full render's", () => {
    const b = option({ value: "b", selected: true }, "B");
    const c = option({ value: "c" }, "C");
    const el = select([option({ value: "a" }, "A"), b, c]) as HTMLSelectElement;
    expect(markedIn(renderToString(el), ["a", "b", "c"])).toEqual([false, true, false]);

    el.value = "c";
    const before = sourceState(el);
    expect(markedIn(renderToString(c), ["c"])).toEqual([true]);
    expect(markedIn(renderToString(b), ["b"])).toEqual([false]);
    expect(sourceState(el)).toEqual(before);
  });

  it("emits `selected` for an option made the default after an earlier full render", () => {
    const a = option({ value: "a" }, "A");
    const b = option({ value: "b" }, "B");
    const el = select([a, b]) as HTMLSelectElement;
    renderToString(el);

    b.defaultSelected = true;
    expect(b.selected).toBe(true);
    expect(b.hasAttribute("selected")).toBe(true);
    expect(renderToString(b)).toMatch(/<option value="b" selected=""/);
    expect(renderToString(a)).not.toMatch(/selected/);
  });

  it("renders an optgroup fragment from the live selection", () => {
    const el = select([
      optgroup({ label: "G" }, [option({ value: "a" }, "A"), option({ value: "b" }, "B")]),
      option({ value: "c" }, "C"),
    ]) as HTMLSelectElement;
    el.value = "c";
    expect(markedIn(renderToString(el), ["a", "b", "c"])).toEqual([false, false, true]);

    el.value = "b";
    const before = sourceState(el);
    const group = el.querySelector("optgroup") as Element;
    const markup = renderToString(group);
    expect(markedIn(markup, ["a", "b"])).toEqual([false, true]);
    expect(parsedSelection(markup)).toEqual(["b"]);
    expect(sourceState(el)).toEqual(before);
  });

  it("follows the selection across repeated full renders of the same select", () => {
    const el = select([option({ value: "a" }, "A"), option({ value: "b" }, "B"), option({ value: "c" }, "C")]);
    const values = ["a", "b", "c"];
    for (const v of ["c", "b", "c"]) {
      (el as HTMLSelectElement).value = v;
      const markup = renderToString(el);
      expect(parsedSelection(markup)).toEqual([v]);
    }
    // The first option is the drop-down's implicit default: no attribute needed.
    (el as HTMLSelectElement).value = "a";
    expect(markedIn(renderToString(el), values)).toEqual([false, false, false]);
    expect(parsedSelection(renderToString(el))).toEqual(["a"]);
  });

  it("renders each option of a multiple select from its own live selection", () => {
    const el = select({ multiple: true }, [
      option({ value: "x" }, "X"),
      optgroup({ label: "G" }, [option({ value: "y" }, "Y"), option({ value: "z" }, "Z")]),
    ]) as HTMLSelectElement;
    renderToString(el);
    el.options[0].selected = true;
    el.options[2].selected = true;
    const before = sourceState(el);

    expect(markedIn(renderToString(el.options[0]), ["x"])).toEqual([true]);
    const group = renderToString(el.querySelector("optgroup") as Element);
    expect(markedIn(group, ["y", "z"])).toEqual([false, true]);
    expect(parsedSelection(`${renderToString(el.options[0])}${group}`, true)).toEqual(["x", "z"]);
    expect(sourceState(el)).toEqual(before);
  });

  it("adds no `selected` to an option some engine picks as the implicit default", () => {
    // WebKit reports the first option selected even inside a disabled optgroup,
    // and with every option disabled: emulated here. An attribute the client
    // never writes would be removed by an adopting hydration, changing the
    // selection on takeover, so none is added.
    const grouped = select([
      optgroup({ label: "G", disabled: true }, [option({ value: "a" }, "A")]),
      option({ value: "b", disabled: true }, "B"),
    ]) as HTMLSelectElement;
    grouped.selectedIndex = 0;
    expect(markedIn(renderToString(grouped), ["a", "b"])).toEqual([false, false]);

    // A choice no engine makes on its own still reaches the markup.
    const plain = select([
      option({ value: "a", disabled: true }, "A"),
      option({ value: "b" }, "B"),
      option({ value: "c" }, "C"),
    ]) as HTMLSelectElement;
    plain.value = "c";
    expect(markedIn(renderToString(plain), ["a", "b", "c"])).toEqual([false, false, true]);
    plain.value = "b";
    expect(markedIn(renderToString(plain), ["a", "b", "c"])).toEqual([false, false, false]);
  });

  it("streams from the live selection, and two streams do not share a snapshot", async () => {
    const el = select([option({ value: "a" }, "A"), option({ value: "b" }, "B"), option({ value: "c" }, "C")]);
    const sel = el as HTMLSelectElement;
    renderToString(el);

    sel.value = "b";
    expect(parsedSelection(await collectStream(renderToStream(el)))).toEqual(["b"]);
    expect(markedIn(await collectStream(renderToStream(sel.options[2])), ["c"])).toEqual([false]);

    // A stream paused after the select's open tag keeps the selection it
    // opened with; a stream started meanwhile reads the new one.
    const first = renderToStream(el);
    let head = "";
    while (!head.startsWith("<select")) head += (await first.next()).value ?? "";
    sel.value = "c";
    expect(parsedSelection(await collectStream(renderToStream(el)))).toEqual(["c"]);
    let rest = head;
    for await (const chunk of first) rest += chunk;
    expect(parsedSelection(rest)).toEqual(["b"]);
  });
});
