import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setRuntimeErrorHandler } from "../../src/core/errors";
import { match, when } from "../../src/core/rendering/directives";
import { registerDisposer } from "../../src/core/rendering/dispose";
import { each } from "../../src/core/rendering/each";
import { div, span } from "../../src/core/rendering/html";
import { KeepAlive } from "../../src/core/rendering/keepAlive";
import { mount } from "../../src/core/rendering/mount";
import { effect } from "../../src/core/signals/effect";
import { signal } from "../../src/core/signals/signal";
import { batch } from "../../src/reactivity/batch";

// ---------------------------------------------------------------------------
// Bindings inside an OUTGOING when/match/each/KeepAlive branch must not run
// again in the flush that replaces the branch.
//
// THE DEFECT: a signal's subscribers are linked at the head of its list, so
// they are notified newest-first. The bindings inside a branch are created
// after the directive that owns the branch, so when both read the signal that
// switches the branch, the branch's bindings were queued — and ran — BEFORE the
// directive got to dispose them. A binding that is only valid while its branch
// is mounted (`() => sel()!.name`) then threw once per binding.
// ---------------------------------------------------------------------------

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

let host: HTMLElement;
let errors: unknown[];
let unmount: (() => void) | undefined;

beforeEach(() => {
  errors = [];
  setRuntimeErrorHandler((err) => {
    errors.push(err);
  });
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  unmount?.();
  unmount = undefined;
  setRuntimeErrorHandler(null);
  host.remove();
});

type Item = { name: string; kind?: string };

describe("match(): outgoing branch bindings", () => {
  it("does not re-run a binding of the branch being replaced (the reported repro)", async () => {
    const [sel, setSel] = signal<Item | null>({ name: "a" });
    let runs = 0;
    unmount = mount(
      () =>
        div([
          match(
            () => sel()?.name ?? "",
            { "": () => span("nothing selected") },
            () =>
              span(() => {
                runs++;
                return sel()!.name;
              }),
          ),
        ]),
      host,
    ).unmount;
    await flush();
    expect(host.textContent).toBe("a");
    expect(runs).toBe(1);

    setSel(null);
    expect(errors).toEqual([]);
    expect(runs).toBe(1);
    expect(host.textContent).toBe("nothing selected");
  });

  it("skips every kind of binding in the outgoing branch (text, attribute, class, property)", async () => {
    const [sel, setSel] = signal<{ rotation: number; on: boolean } | null>({ rotation: 5, on: true });
    let runs = 0;
    const read = () => {
      runs++;
      return sel()!;
    };
    unmount = mount(
      () =>
        div([
          match(() => (sel() ? "on" : "off"), {
            on: () =>
              div(
                {
                  "aria-selected": () => String(read().on),
                  class: () => (read().on ? "on" : "off"),
                  title: () => String(read().rotation),
                },
                [span(() => String(read().rotation))],
              ),
            off: () => span("none"),
          }),
        ]),
      host,
    ).unmount;
    await flush();
    const before = runs;
    expect(before).toBe(4);

    setSel(null);
    expect(errors).toEqual([]);
    expect(runs).toBe(before);
    expect(host.textContent).toBe("none");
  });

  it("still updates bindings of a branch that stays mounted, in the same flush", async () => {
    const [sel, setSel] = signal<Item>({ name: "a", kind: "x" });
    unmount = mount(
      () =>
        div([
          match(
            () => sel().kind ?? "",
            { x: () => span(() => sel().name) },
            () => span("other"),
          ),
        ]),
      host,
    ).unmount;
    await flush();
    expect(host.textContent).toBe("a");
    setSel({ name: "b", kind: "x" });
    expect(host.textContent).toBe("b");
    expect(errors).toEqual([]);
  });

  it("does not run the outgoing binding when the key changes through a DIFFERENT signal in one batch", async () => {
    const [mode, setMode] = signal("edit");
    const [sel, setSel] = signal<Item | null>({ name: "a" });
    let runs = 0;
    unmount = mount(
      () =>
        div([
          match(() => mode(), {
            edit: () =>
              span(() => {
                runs++;
                return sel()!.name;
              }),
            idle: () => span("idle"),
          }),
        ]),
      host,
    ).unmount;
    await flush();
    batch(() => {
      setSel(null);
      setMode("idle");
    });
    expect(errors).toEqual([]);
    expect(runs).toBe(1);
    expect(host.textContent).toBe("idle");
  });

  it("does not run an effect owned by the outgoing branch", async () => {
    const [sel, setSel] = signal<Item | null>({ name: "a" });
    const seen: string[] = [];
    const Panel = () => {
      const el = span("panel");
      // Effects are not tied to a node by themselves; the component ties this
      // one to its root, which the branch switch disposes.
      registerDisposer(
        el,
        effect(() => {
          seen.push(sel()!.name);
        }),
      );
      return el;
    };
    unmount = mount(
      () =>
        div([
          when(
            () => !!sel(),
            Panel,
            () => span("empty"),
          ),
        ]),
      host,
    ).unmount;
    await flush();
    expect(seen).toEqual(["a"]);
    setSel(null);
    expect(errors).toEqual([]);
    expect(seen).toEqual(["a"]);
    expect(host.textContent).toBe("empty");
  });
});

describe("when(): outgoing branch bindings", () => {
  it("does not re-run a binding of the then-branch when the condition turns falsy", async () => {
    const [sel, setSel] = signal<Item | null>({ name: "a" });
    let runs = 0;
    unmount = mount(
      () =>
        div([
          when(
            () => sel(),
            () =>
              span(() => {
                runs++;
                return sel()!.name;
              }),
            () => span("empty"),
          ),
        ]),
      host,
    ).unmount;
    await flush();
    expect(runs).toBe(1);
    setSel(null);
    expect(errors).toEqual([]);
    expect(runs).toBe(1);
    expect(host.textContent).toBe("empty");
  });

  it("handles a match nested inside an outgoing when branch", async () => {
    const [sel, setSel] = signal<Item | null>({ name: "a", kind: "k" });
    let selectorRuns = 0;
    let bindingRuns = 0;
    unmount = mount(
      () =>
        div([
          when(
            () => !!sel(),
            () =>
              div([
                match(
                  () => {
                    selectorRuns++;
                    return sel()!.kind ?? "";
                  },
                  {
                    k: () =>
                      span(() => {
                        bindingRuns++;
                        return sel()!.name;
                      }),
                  },
                ),
              ]),
            () => span("empty"),
          ),
        ]),
      host,
    ).unmount;
    await flush();
    await flush();
    expect(host.textContent).toBe("a");
    const s = selectorRuns;
    const b = bindingRuns;

    setSel(null);
    expect(errors).toEqual([]);
    expect(selectorRuns).toBe(s);
    expect(bindingRuns).toBe(b);
    expect(host.textContent).toBe("empty");
  });

  it("handles a reactive child (function child) whose subtree is replaced", async () => {
    const [sel, setSel] = signal<Item | null>({ name: "a" });
    let runs = 0;
    unmount = mount(
      () =>
        div([
          () =>
            sel()
              ? span(() => {
                  runs++;
                  return sel()!.name;
                })
              : span("empty"),
        ]),
      host,
    ).unmount;
    await flush();
    expect(runs).toBe(1);
    setSel(null);
    expect(errors).toEqual([]);
    expect(runs).toBe(1);
    expect(host.textContent).toBe("empty");
  });
});

describe("each(): removed rows", () => {
  it("does not re-run a binding of a removed row that reads the removed item", async () => {
    const [items, setItems] = signal([
      { id: 1, name: "one" },
      { id: 2, name: "two" },
    ]);
    let runs = 0;
    unmount = mount(
      () =>
        div([
          each(
            () => items(),
            (item) =>
              span(() => {
                runs++;
                // Only valid while the row's item is still in the list.
                return items().find((x) => x.id === item().id)!.name;
              }),
            { key: (x) => x.id },
          ),
        ]),
      host,
    ).unmount;
    await flush();
    expect(host.textContent).toBe("onetwo");
    expect(runs).toBe(2);

    setItems([{ id: 1, name: "uno" }]);
    expect(errors).toEqual([]);
    expect(host.textContent).toBe("uno");
    // Row 1 re-ran once (its data changed); row 2 was removed and never re-ran.
    expect(runs).toBe(3);
  });
});

describe("KeepAlive: evicted branches", () => {
  it("does not re-run a binding of the branch evicted by the switch", async () => {
    const [tab, setTab] = signal("a");
    const [data, setData] = signal<Record<string, string> | null>({ a: "A" });
    let runs = 0;
    unmount = mount(
      () =>
        div([
          KeepAlive(
            () => tab(),
            {
              a: () =>
                span(() => {
                  runs++;
                  return data()!.a;
                }),
              b: () => span("B"),
            },
            { max: 1 },
          ),
        ]),
      host,
    ).unmount;
    await flush();
    expect(runs).toBe(1);
    batch(() => {
      setData(null);
      setTab("b");
    });
    expect(errors).toEqual([]);
    expect(runs).toBe(1);
    expect(host.textContent).toBe("B");
  });
});
