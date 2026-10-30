import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __resetIdCounter } from "../src/core/rendering/createId";
import { each } from "../src/core/rendering/each";
import { div, input, option, select, textarea } from "../src/core/rendering/html";
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
