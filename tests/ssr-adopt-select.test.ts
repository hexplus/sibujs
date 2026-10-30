import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetIdCounter } from "../src/core/rendering/createId";
import { each } from "../src/core/rendering/each";
import { div, input, optgroup, option, select, textarea } from "../src/core/rendering/html";
import { signal } from "../src/core/signals/signal";
import { hydrate } from "../src/platform/ssr";
import { renderToStringAsync } from "../src/platform/ssrAsync";

// Adopting hydration keeps a <select> selection the user made before the
// bundle loaded. The client builds a select's options BEFORE the select, so an
// option's `selected` write would reset the selection before the select itself
// is claimed; the session snapshots selections before any client code runs.

let container: HTMLElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  __resetIdCounter();
});

afterEach(() => {
  container.remove();
  vi.restoreAllMocks();
});

async function serverRender(app: () => Node): Promise<string> {
  return (await renderToStringAsync(app, { hydration: "adopt" })).html;
}

const values = (el: HTMLSelectElement) =>
  Array.from(el.options)
    .filter((o) => o.selected)
    .map((o) => o.value);

/** No instance override left on any element under `root`. */
function ownOverrides(root: Element): string[] {
  const keys = [
    "appendChild",
    "insertBefore",
    "replaceChildren",
    "textContent",
    "getAttribute",
    "setAttribute",
    "removeAttribute",
    "value",
    "checked",
  ];
  const found: string[] = [];
  for (const el of [root, ...Array.from(root.querySelectorAll("*"))]) {
    for (const key of keys) if (Object.hasOwn(el, key)) found.push(`${el.localName}.${key}`);
  }
  return found;
}

describe("adopting hydration preserves a <select> the user changed", () => {
  it("keeps B when the server selected A with an option-level `selected` (the review reproduction)", async () => {
    const App = () =>
      div([select({ id: "s" }, [option({ value: "a", selected: true }, "A"), option({ value: "b" }, "B")])]);
    container.innerHTML = await serverRender(App);
    const el = container.querySelector("select") as HTMLSelectElement;
    expect(el.value).toBe("a");
    el.value = "b";

    const result = await hydrate(App, container, { strategy: "adopt" });
    expect(container.querySelector("select")).toBe(el);
    expect(result.created).toBe(0);
    expect(el.value).toBe("b");
  });

  it("keeps several user-selected options of a multiple select", async () => {
    const App = () =>
      select({ multiple: true }, [
        option({ value: "a", selected: true }, "A"),
        option({ value: "b" }, "B"),
        option({ value: "c" }, "C"),
      ]);
    container.innerHTML = await serverRender(App);
    const el = container.querySelector("select") as HTMLSelectElement;
    el.options[0].selected = false;
    el.options[1].selected = true;
    el.options[2].selected = true;

    await hydrate(App, container, { strategy: "adopt" });
    expect(values(el)).toEqual(["b", "c"]);
  });

  it("keeps the user's choice over a select-level `value` binding, and tells the app's handlers", async () => {
    const [choice, setChoice] = signal("a");
    const changes: string[] = [];
    const App = () =>
      select(
        {
          value: () => choice(),
          on: {
            change: (e: Event) => {
              const v = (e.target as HTMLSelectElement).value;
              changes.push(v);
              setChoice(v);
            },
          },
        },
        [option({ value: "a" }, "A"), option({ value: "b" }, "B"), option({ value: "c" }, "C")],
      );
    container.innerHTML = await serverRender(App);
    const el = container.querySelector("select") as HTMLSelectElement;
    el.value = "c";

    await hydrate(App, container, { strategy: "adopt" });
    expect(el.value).toBe("c");
    expect(changes).toEqual(["c"]);
    expect(choice()).toBe("c");
  });

  it("lets the client initialize a select the user did not touch", async () => {
    // The server DOM keeps `value` as state, so the server markup carries no
    // `selected` attribute: the parser selects the first option. That default
    // is not a user change, and the client's `value` must apply.
    const [choice] = signal("b");
    const App = () => select({ value: () => choice() }, [option({ value: "a" }, "A"), option({ value: "b" }, "B")]);
    container.innerHTML = await serverRender(App);
    const el = container.querySelector("select") as HTMLSelectElement;
    const change = vi.fn();
    el.addEventListener("change", change);

    await hydrate(App, container, { strategy: "adopt" });
    expect(el.value).toBe("b");
    expect(change).not.toHaveBeenCalled();
  });

  it("restores the selection by value when the client reorders the options", async () => {
    const [order, setOrder] = signal(["a", "b", "c"]);
    const App = () =>
      select(
        { id: "s" },
        each(
          () => order(),
          (v) => option({ value: v() }, v().toUpperCase()),
          { key: (v) => v },
        ),
      );
    container.innerHTML = await serverRender(App);
    const el = container.querySelector("select") as HTMLSelectElement;
    el.value = "b";
    setOrder(["c", "b", "a"]);

    await hydrate(App, container, { strategy: "adopt" });
    expect(el.value).toBe("b");
  });

  it("falls back to the client's selection when the selected option no longer exists", async () => {
    let client = false;
    const App = () =>
      select(
        { id: "s" },
        client
          ? [option({ value: "a", selected: true }, "A"), option({ value: "c" }, "C")]
          : [option({ value: "a", selected: true }, "A"), option({ value: "b" }, "B")],
      );
    container.innerHTML = await serverRender(App);
    const el = container.querySelector("select") as HTMLSelectElement;
    el.value = "b";
    const change = vi.fn();
    el.addEventListener("change", change);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    client = true;
    await hydrate(App, container, { strategy: "adopt" });
    expect(Array.from(el.options, (o) => o.value)).toEqual(["a", "c"]);
    expect(el.value).toBe("a");
    expect(change).not.toHaveBeenCalled();
  });

  it("leaves no instance override behind, after a select was preserved", async () => {
    const App = () => div([select([option({ value: "a", selected: true }, "A"), option({ value: "b" }, "B")])]);
    container.innerHTML = await serverRender(App);
    (container.querySelector("select") as HTMLSelectElement).value = "b";

    await hydrate(App, container, { strategy: "adopt" });
    expect(ownOverrides(container)).toEqual([]);
    // The native setter works again.
    const el = container.querySelector("select") as HTMLSelectElement;
    el.value = "a";
    expect(el.value).toBe("a");
  });

  it("removes the overrides even when the client build throws", async () => {
    const App = () => div([select([option({ value: "a" }, "A")])]);
    container.innerHTML = await serverRender(App);
    const Broken = () =>
      div([
        select([option({ value: "a" }, "A")]),
        (() => {
          throw new Error("boom");
        })(),
      ]);
    await expect(hydrate(Broken, container, { strategy: "adopt" })).rejects.toThrow("boom");
    expect(ownOverrides(container)).toEqual([]);
  });

  it("keeps typed input, checkboxes, radios and textareas next to a preserved select", async () => {
    const App = () =>
      div([
        input({ id: "t", value: "" }),
        input({ id: "c", type: "checkbox" }),
        input({ id: "r1", type: "radio", name: "g", checked: true }),
        input({ id: "r2", type: "radio", name: "g" }),
        textarea({ id: "x" }, ""),
        select({ id: "s" }, [option({ value: "a" }, "A"), option({ value: "b" }, "B")]),
      ]);
    container.innerHTML = await serverRender(App);
    const q = <T extends Element>(sel: string) => container.querySelector(sel) as unknown as T;
    q<HTMLInputElement>("#t").value = "typed";
    q<HTMLInputElement>("#c").checked = true;
    q<HTMLInputElement>("#r2").checked = true;
    q<HTMLTextAreaElement>("#x").value = "notes";
    q<HTMLSelectElement>("#s").value = "b";

    await hydrate(App, container, { strategy: "adopt" });
    expect(q<HTMLInputElement>("#t").value).toBe("typed");
    expect(q<HTMLInputElement>("#c").checked).toBe(true);
    expect(q<HTMLInputElement>("#r2").checked).toBe(true);
    expect(q<HTMLTextAreaElement>("#x").value).toBe("notes");
    expect(q<HTMLSelectElement>("#s").value).toBe("b");
  });
});

/** The selected option NODES of `el`, in document order. */
const selectedNodes = (el: HTMLSelectElement) => Array.from(el.options).filter((o) => o.selected);

/**
 * Server markup in which the options with `values` carry the `selected`
 * attribute. The server DOM keeps `selected: true` as state, not as an
 * attribute, so a multiple select's server-side selection is written into the
 * markup here, as a static page or another server would deliver it.
 */
async function serverRenderSelected(app: () => Node, ...values: string[]): Promise<string> {
  let html = await serverRender(app);
  for (const v of values) html = html.replace(`<option value="${v}"`, `<option value="${v}" selected`);
  return html;
}

/** Strip the adoption ids from the server's options, so the client cannot claim them and builds fresh ones. */
function unclaimableOptions(root: Element): void {
  for (const o of Array.from(root.querySelectorAll("option"))) o.removeAttribute("data-sibu-h");
}

describe("adopting hydration keeps an intentionally EMPTY selection", () => {
  it("keeps a multiple select the user cleared, the server having selected one option", async () => {
    const seen: number[] = [];
    const App = () =>
      select(
        {
          multiple: true,
          on: { change: (e: Event) => seen.push((e.target as HTMLSelectElement).selectedOptions.length) },
        },
        [option({ value: "a", selected: true }, "A"), option({ value: "b" }, "B")],
      );
    container.innerHTML = await serverRenderSelected(App, "a");
    const el = container.querySelector("select") as HTMLSelectElement;
    expect(selectedNodes(el)).toEqual([el.options[0]]);
    el.options[0].selected = false;

    await hydrate(App, container, { strategy: "adopt" });
    expect(container.querySelector("select")).toBe(el);
    expect(selectedNodes(el)).toEqual([]);
    // The replayed change saw the restored, empty selection.
    expect(seen).toEqual([0]);
  });

  it("keeps a multiple select the user cleared, the server having selected several options", async () => {
    const App = () =>
      select({ multiple: true }, [
        option({ value: "a", selected: true }, "A"),
        option({ value: "b" }, "B"),
        option({ value: "c", selected: true }, "C"),
      ]);
    container.innerHTML = await serverRenderSelected(App, "a", "c");
    const el = container.querySelector("select") as HTMLSelectElement;
    expect(selectedNodes(el).map((o) => o.value)).toEqual(["a", "c"]);
    for (const o of Array.from(el.options)) o.selected = false;

    await hydrate(App, container, { strategy: "adopt" });
    expect(selectedNodes(el)).toEqual([]);
  });

  it("keeps a single select emptied with selectedIndex = -1, and replays it", async () => {
    const seen: number[] = [];
    const App = () =>
      select({ on: { change: (e: Event) => seen.push((e.target as HTMLSelectElement).selectedIndex) } }, [
        option({ value: "a", selected: true }, "A"),
        option({ value: "b" }, "B"),
      ]);
    container.innerHTML = await serverRender(App);
    const el = container.querySelector("select") as HTMLSelectElement;
    el.selectedIndex = -1;

    await hydrate(App, container, { strategy: "adopt" });
    expect(el.selectedIndex).toBe(-1);
    expect(selectedNodes(el)).toEqual([]);
    expect(seen).toEqual([-1]);
  });

  it("leaves an untouched multiple select to the client's initialization", async () => {
    const change = vi.fn();
    const App = () =>
      select({ multiple: true }, [option({ value: "a", selected: true }, "A"), option({ value: "b" }, "B")]);
    container.innerHTML = await serverRenderSelected(App, "a");
    const el = container.querySelector("select") as HTMLSelectElement;
    el.addEventListener("change", change);

    await hydrate(App, container, { strategy: "adopt" });
    expect(selectedNodes(el)).toEqual([el.options[0]]);
    expect(change).not.toHaveBeenCalled();
  });

  it("falls back to the client's selection when every previously selected option is gone", async () => {
    // Keyed rows: the select itself stays adopted while its options change.
    const [rows, setRows] = signal(["a", "b", "c"]);
    const App = () =>
      select(
        { multiple: true },
        each(
          () => rows(),
          (v) => option({ value: v(), selected: v() === "a" }, v().toUpperCase()),
          { key: (v) => v },
        ),
      );
    container.innerHTML = await serverRender(App);
    const el = container.querySelector("select") as HTMLSelectElement;
    el.options[0].selected = false;
    el.options[1].selected = true;
    el.options[2].selected = true;
    const change = vi.fn();
    el.addEventListener("change", change);

    setRows(["a", "z"]);
    await hydrate(App, container, { strategy: "adopt" });
    expect(container.querySelector("select")).toBe(el);
    expect(Array.from(el.options, (o) => o.value)).toEqual(["a", "z"]);
    expect(selectedNodes(el).map((o) => o.value)).toEqual(["a"]);
    expect(change).not.toHaveBeenCalled();
  });
});

describe("adopting hydration keeps the selected option NODES, not their values", () => {
  it("keeps the second of two equal-valued options in a single select", async () => {
    const App = () => select([option({ value: "same" }, "First"), option({ value: "same" }, "Second")]);
    container.innerHTML = await serverRender(App);
    const el = container.querySelector("select") as HTMLSelectElement;
    const second = el.options[1];
    el.selectedIndex = 1;

    await hydrate(App, container, { strategy: "adopt" });
    expect(el.selectedIndex).toBe(1);
    expect(selectedNodes(el)).toEqual([second]);
  });

  it("selects only the one equal-valued option the user chose in a multiple select", async () => {
    const App = () =>
      select({ multiple: true }, [
        option({ value: "same" }, "1"),
        option({ value: "same" }, "2"),
        option({ value: "same" }, "3"),
      ]);
    container.innerHTML = await serverRender(App);
    const el = container.querySelector("select") as HTMLSelectElement;
    const chosen = el.options[1];
    chosen.selected = true;

    await hydrate(App, container, { strategy: "adopt" });
    expect(selectedNodes(el)).toEqual([chosen]);
  });

  it("selects exactly the two equal-valued options chosen, not the third", async () => {
    const App = () =>
      select({ multiple: true }, [
        option({ value: "same" }, "1"),
        option({ value: "same" }, "2"),
        option({ value: "same" }, "3"),
      ]);
    container.innerHTML = await serverRender(App);
    const el = container.querySelector("select") as HTMLSelectElement;
    const [first, , third] = Array.from(el.options);
    first.selected = true;
    third.selected = true;

    await hydrate(App, container, { strategy: "adopt" });
    expect(selectedNodes(el)).toEqual([first, third]);
  });

  it("keeps the exact selected node when the surviving options are reordered", async () => {
    const [order, setOrder] = signal(["x", "y", "z"]);
    const App = () =>
      select(
        each(
          () => order(),
          (k) => option({ value: "same" }, k()),
          { key: (k) => k },
        ),
      );
    container.innerHTML = await serverRender(App);
    const el = container.querySelector("select") as HTMLSelectElement;
    const y = el.options[1];
    el.selectedIndex = 1;
    setOrder(["z", "y", "x"]);

    await hydrate(App, container, { strategy: "adopt" });
    expect(Array.from(el.options, (o) => o.textContent)).toEqual(["z", "y", "x"]);
    expect(selectedNodes(el)).toEqual([y]);
    expect(y.isConnected).toBe(true);
  });

  it("restores rebuilt equal-valued options one-to-one, by occurrence", async () => {
    // Fallback policy: an option the client rebuilt is matched by its value and
    // its occurrence among the options with that value, one to one.
    const App = () =>
      select({ multiple: true }, [
        option({ value: "same" }, "1"),
        option({ value: "same" }, "2"),
        option({ value: "same" }, "3"),
      ]);
    container.innerHTML = await serverRender(App);
    unclaimableOptions(container);
    const el = container.querySelector("select") as HTMLSelectElement;
    const before = Array.from(el.options);
    el.options[2].selected = true;
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await hydrate(App, container, { strategy: "adopt" });
    const after = Array.from(el.options);
    expect(after).toHaveLength(3);
    for (const o of after) expect(before).not.toContain(o);
    expect(selectedNodes(el)).toEqual([after[2]]);
  });

  it("drops a removed selected option and keeps the surviving ones, selecting nothing extra", async () => {
    // x and z are selected; z is removed. y shares z's value but was never
    // selected, so it must not inherit z's selection.
    const [rows, setRows] = signal(["x", "y", "z"]);
    const App = () =>
      select(
        { multiple: true },
        each(
          () => rows(),
          (k) => option({ value: "same" }, k()),
          { key: (k) => k },
        ),
      );
    container.innerHTML = await serverRender(App);
    const el = container.querySelector("select") as HTMLSelectElement;
    const [x, y] = Array.from(el.options);
    x.selected = true;
    el.options[2].selected = true;

    setRows(["x", "y"]);
    await hydrate(App, container, { strategy: "adopt" });
    expect(container.querySelector("select")).toBe(el);
    expect(Array.from(el.options)).toEqual([x, y]);
    expect(selectedNodes(el)).toEqual([x]);
  });

  it("keeps a selection inside an <optgroup>", async () => {
    const App = () =>
      select([
        optgroup({ label: "One" }, [option({ value: "same" }, "1a"), option({ value: "same" }, "1b")]),
        optgroup({ label: "Two" }, [option({ value: "same" }, "2a"), option({ value: "same" }, "2b")]),
      ]);
    container.innerHTML = await serverRender(App);
    const el = container.querySelector("select") as HTMLSelectElement;
    const chosen = el.options[3];
    el.selectedIndex = 3;

    await hydrate(App, container, { strategy: "adopt" });
    expect(selectedNodes(el)).toEqual([chosen]);
    expect(chosen.parentElement?.getAttribute("label")).toBe("Two");
  });

  it("uses the DOM's option value: the text when `value` is omitted, and empty values as values", async () => {
    const App = () =>
      select({ multiple: true }, [
        option("One"),
        option("Two"),
        option({ value: "" }, "Empty 1"),
        option({ value: "" }, "Empty 2"),
      ]);
    container.innerHTML = await serverRender(App);
    const el = container.querySelector("select") as HTMLSelectElement;
    expect(Array.from(el.options, (o) => o.value)).toEqual(["One", "Two", "", ""]);
    const two = el.options[1];
    const empty2 = el.options[3];
    two.selected = true;
    empty2.selected = true;
    unclaimableOptions(container);
    vi.spyOn(console, "warn").mockImplementation(() => {});

    await hydrate(App, container, { strategy: "adopt" });
    const after = Array.from(el.options);
    expect(selectedNodes(el)).toEqual([after[1], after[3]]);
  });
});

/** Count the input/change events a select receives during hydration. */
function replays(el: HTMLSelectElement): () => string[] {
  const seen: string[] = [];
  el.addEventListener("input", () => seen.push("input"));
  el.addEventListener("change", () => seen.push("change"));
  return () => seen;
}

describe("adopting hydration computes the markup's default selection as the browser does", () => {
  // A: disabled through its optgroup; B, C: enabled. No `selected` attribute in
  // the server markup (the server DOM keeps `selected: true` as state), so the
  // parser selects B — the first option that is not disabled.
  const Grouped = () =>
    select({ id: "g" }, [
      optgroup({ label: "Unavailable", disabled: true }, [option({ value: "a" }, "A")]),
      option({ value: "b" }, "B"),
      option({ value: "c", selected: true }, "C"),
    ]);

  it("treats an untouched select after a disabled optgroup as untouched: the client's C stands", async () => {
    container.innerHTML = await serverRender(Grouped);
    const el = container.querySelector("select") as HTMLSelectElement;
    expect(el.querySelector("optgroup")?.hasAttribute("disabled")).toBe(true);
    expect(el.selectedIndex).toBe(1);
    const c = el.options[2];

    await hydrate(Grouped, container, { strategy: "adopt" });
    expect(container.querySelector("select")).toBe(el);
    expect(el.selectedIndex).toBe(2);
    expect(selectedNodes(el)).toEqual([c]);
  });

  it("replays no input/change event for that untouched select", async () => {
    container.innerHTML = await serverRender(Grouped);
    const el = container.querySelector("select") as HTMLSelectElement;
    const seen = replays(el);

    await hydrate(Grouped, container, { strategy: "adopt" });
    expect(seen()).toEqual([]);
  });

  it("keeps a genuine user change among the grouped options, and replays it", async () => {
    // The client initializes B, the markup default; the user picked C.
    const heard: number[] = [];
    const App = () =>
      select({ on: { change: (e: Event) => heard.push((e.target as HTMLSelectElement).selectedIndex) } }, [
        optgroup({ label: "Unavailable", disabled: true }, [option({ value: "a" }, "A")]),
        option({ value: "b", selected: true }, "B"),
        option({ value: "c" }, "C"),
      ]);
    container.innerHTML = await serverRender(App);
    const el = container.querySelector("select") as HTMLSelectElement;
    const c = el.options[2];
    el.selectedIndex = 2;

    await hydrate(App, container, { strategy: "adopt" });
    expect(selectedNodes(el)).toEqual([c]);
    expect(heard).toEqual([2]);
  });

  it("skips an individually disabled first option for the implicit default", async () => {
    const App = () =>
      select([
        option({ value: "a", disabled: true }, "A"),
        option({ value: "b" }, "B"),
        option({ value: "c", selected: true }, "C"),
      ]);
    container.innerHTML = await serverRender(App);
    const el = container.querySelector("select") as HTMLSelectElement;
    expect(el.selectedIndex).toBe(1);
    const seen = replays(el);

    await hydrate(App, container, { strategy: "adopt" });
    expect(selectedNodes(el)).toEqual([el.options[2]]);
    expect(seen()).toEqual([]);
  });

  it("honors an explicit `selected` on a disabled option or one in a disabled optgroup, untouched", async () => {
    // The client marks the same option selected the server did; the server
    // markup carries it as the `selected` attribute.
    for (const value of ["a", "c"]) {
      const App = () =>
        select([
          optgroup({ label: "Unavailable", disabled: true }, [option({ value: "a", selected: value === "a" }, "A")]),
          option({ value: "b" }, "B"),
          option({ value: "c", disabled: true, selected: value === "c" }, "C"),
        ]);
      container.innerHTML = await serverRenderSelected(App, value);
      const el = container.querySelector("select") as HTMLSelectElement;
      const explicit = el.querySelector(`option[value="${value}"]`) as HTMLOptionElement;
      // What the DOM does with it: the explicit selection holds, disabled or not.
      expect(selectedNodes(el), value).toEqual([explicit]);
      const seen = replays(el);

      await hydrate(App, container, { strategy: "adopt" });
      expect(seen(), value).toEqual([]);
      expect(selectedNodes(el), value).toEqual([explicit]);
      container.innerHTML = "";
      __resetIdCounter();
    }
  });

  it("treats a drop-down with every option disabled as untouched, whatever the DOM selected", async () => {
    const App = () =>
      select([
        optgroup({ label: "Group", disabled: true }, [option({ value: "a" }, "A")]),
        option({ value: "b", disabled: true }, "B"),
      ]);
    container.innerHTML = await serverRender(App);
    const el = container.querySelector("select") as HTMLSelectElement;
    const before = el.selectedIndex;
    const seen = replays(el);

    await hydrate(App, container, { strategy: "adopt" });
    expect(seen()).toEqual([]);
    expect(el.selectedIndex).toBe(before);
  });

  it("keeps multiple selects and listboxes on their default: nothing selected without `selected`", async () => {
    for (const props of [{ multiple: true }, { size: 3 }]) {
      const App = () =>
        select(props, [
          optgroup({ label: "Unavailable", disabled: true }, [option({ value: "a" }, "A")]),
          option({ value: "b" }, "B"),
          option({ value: "c", selected: true }, "C"),
        ]);
      container.innerHTML = await serverRender(App);
      const el = container.querySelector("select") as HTMLSelectElement;
      expect(selectedNodes(el)).toEqual([]);
      const c = el.options[2];
      const seen = replays(el);

      await hydrate(App, container, { strategy: "adopt" });
      expect(seen()).toEqual([]);
      expect(selectedNodes(el)).toEqual([c]);
      container.innerHTML = "";
      __resetIdCounter();
    }
  });
});
