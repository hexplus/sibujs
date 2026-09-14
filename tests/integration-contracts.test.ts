import { describe, expect, it } from "vitest";
import { media } from "../src/browser/media";
import { each } from "../src/core/rendering/each";
import { div } from "../src/core/rendering/html";
import { onCleanup } from "../src/core/rendering/lifecycle";
import { mount } from "../src/core/rendering/mount";
import { derived } from "../src/core/signals/derived";
import { effect } from "../src/core/signals/effect";
import { signal } from "../src/core/signals/signal";
import { getSubscriberCount } from "../src/devtools/introspect";
import { bindAttribute } from "../src/reactivity/bindAttribute";
import { untracked } from "../src/reactivity/track";

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("derived().dispose()", () => {
  it("releases every source subscription", () => {
    const [range, setRange] = signal({ top: 0, bottom: 0 });
    const flags = [];
    for (let i = 0; i < 100; i++) flags.push(derived(() => range().top <= i && i <= range().bottom));
    expect(getSubscriberCount(range)).toBe(100);
    for (const flag of flags) flag.dispose();
    expect(getSubscriberCount(range)).toBe(0);
    setRange({ top: 0, bottom: 5 });
    expect(getSubscriberCount(range)).toBe(0);
  });

  it("is idempotent", () => {
    const [n] = signal(1);
    const double = derived(() => n() * 2);
    double.dispose();
    expect(() => double.dispose()).not.toThrow();
    expect(getSubscriberCount(n)).toBe(0);
  });

  it("stops recomputing and never re-subscribes after disposal", () => {
    const [n, setN] = signal(1);
    let runs = 0;
    const double = derived(() => {
      runs++;
      return n() * 2;
    });
    expect(double()).toBe(2);
    setN(2);
    double.dispose();
    const before = runs;
    expect(double()).toBe(2);
    setN(3);
    expect(double()).toBe(2);
    expect(runs).toBe(before);
    expect(getSubscriberCount(n)).toBe(0);
  });

  it("can be owned by a row node so removed rows release their deriveds", async () => {
    const [range] = signal({ top: 0, bottom: 1 });
    const [rows, setRows] = signal([0, 1, 2, 3]);
    const list = div([
      each(
        () => rows(),
        (row) => {
          const index = row();
          const selected = derived(() => range().top <= index && index <= range().bottom);
          const el = div({ "aria-selected": selected }, String(index));
          onCleanup(selected.dispose, el);
          return el;
        },
        { key: (r) => r },
      ),
    ]);
    const { unmount } = mount(list, document.body);
    await flush();
    expect(getSubscriberCount(range)).toBe(4);
    expect(list.firstElementChild?.getAttribute("aria-selected")).toBe("true");
    expect(list.children[3].getAttribute("aria-selected")).toBe("false");
    setRows([0, 1]);
    await flush();
    expect(getSubscriberCount(range)).toBe(2);
    unmount();
    expect(getSubscriberCount(range)).toBe(0);
  });

  it("does not wake downstream consumers once disposed", () => {
    const [n, setN] = signal(1);
    const double = derived(() => n() * 2);
    let runs = 0;
    const stop = effect(() => {
      double();
      runs++;
    });
    double.dispose();
    setN(5);
    expect(runs).toBe(1);
    stop();
  });
});

describe("tracking contexts nested inside untracked()", () => {
  it("a binding created inside untracked() still subscribes to a derived it reads", () => {
    const [n, setN] = signal(1);
    const double = derived(() => n() * 2);
    const el = untracked(() => div(() => String(double())));
    expect(el.textContent).toBe("2");
    setN(2);
    expect(el.textContent).toBe("4");
  });

  it("a derived-of-derived created inside untracked() keeps its upstream edge", () => {
    const [a, setA] = signal(1);
    const b = derived(() => a() + 1);
    const c = untracked(() => {
      const inner = derived(() => b() * 10);
      inner();
      return inner;
    });
    setA(2);
    expect(c()).toBe(30);
  });

  it("recomputing a dirty derived-of-derived inside untracked() does not disconnect it", () => {
    const [a, setA] = signal(1);
    const b = derived(() => a() + 1);
    const c = derived(() => b() * 10);
    expect(c()).toBe(20);
    setA(2);
    expect(untracked(c)).toBe(30);
    setA(3);
    expect(c()).toBe(40);
    const seen: number[] = [];
    const stop = effect(() => {
      seen.push(c());
    });
    setA(4);
    expect(seen).toEqual([40, 50]);
    stop();
  });

  it("untracked() nested in a binding created inside untracked() does not leak reads into the binding", () => {
    const [shown, setShown] = signal(1);
    const [hidden, setHidden] = signal(1);
    let runs = 0;
    untracked(() =>
      effect(() => {
        shown();
        untracked(hidden);
        runs++;
      }),
    );
    setHidden(2);
    expect(runs).toBe(1);
    setShown(2);
    expect(runs).toBe(2);
  });
});

describe("each() render callbacks run untracked", () => {
  it("does not subscribe the list to signals read in the render body of initial or later rows", async () => {
    const [items, setItems] = signal([1, 2]);
    const [outside, setOutside] = signal(0);
    let renders = 0;
    let reconciles = 0;
    const list = div([
      each(
        () => {
          reconciles++;
          return items();
        },
        (item) => {
          outside();
          renders++;
          return div(String(item()));
        },
        { key: (i) => i },
      ),
    ]);
    const { unmount } = mount(list, document.body);
    await flush();
    setItems([1, 2, 3]);
    await flush();
    expect(renders).toBe(3);
    const before = reconciles;
    setOutside(1);
    await flush();
    expect(reconciles).toBe(before);
    expect(renders).toBe(3);
    expect(list.textContent).toBe("123");
    unmount();
  });

  it("rows added by an update before the deferred first pass are untracked too", () => {
    const [items, setItems] = signal([1]);
    const [outside, setOutside] = signal(0);
    let reconciles = 0;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const anchor = document.createComment("x");
    host.appendChild(anchor);
    const listAnchor = each(
      () => {
        reconciles++;
        return items();
      },
      (item) => {
        outside();
        return div(() => String(item()));
      },
      { key: (i) => i },
    );
    host.replaceChild(listAnchor, anchor);
    setItems([1, 2]);
    const before = reconciles;
    setOutside(1);
    expect(reconciles).toBe(before);
    expect(host.textContent).toBe("12");
    host.remove();
  });

  it("row bindings inside the render body stay reactive", async () => {
    const [items, setItems] = signal([{ id: 1, label: "a" }]);
    const [suffix, setSuffix] = signal("!");
    const label = derived(() => suffix());
    const list = div([
      each(
        () => items(),
        (item) => div(() => item().label + label()),
        { key: (i) => i.id },
      ),
    ]);
    const { unmount } = mount(list, document.body);
    await flush();
    setItems([
      { id: 1, label: "a" },
      { id: 2, label: "b" },
    ]);
    setSuffix("?");
    expect(list.textContent).toBe("a?b?");
    setItems([
      { id: 1, label: "c" },
      { id: 2, label: "b" },
    ]);
    expect(list.textContent).toBe("c?b?");
    unmount();
  });
});

describe("boolean attribute values", () => {
  it("serializes booleans on aria-* attributes instead of removing them", () => {
    const [selected, setSelected] = signal(false);
    const el = document.createElement("div");
    bindAttribute(el, "aria-selected", () => selected());
    expect(el.getAttribute("aria-selected")).toBe("false");
    setSelected(true);
    expect(el.getAttribute("aria-selected")).toBe("true");
    const static_ = div({ "aria-hidden": false });
    expect(static_.getAttribute("aria-hidden")).toBe("false");
  });

  it("keeps removal semantics for native boolean attributes and null on aria-*", () => {
    const [on, setOn] = signal(true);
    const el = document.createElement("input");
    bindAttribute(el, "hidden", () => on());
    bindAttribute(el, "required", () => on());
    expect(el.hasAttribute("hidden")).toBe(true);
    setOn(false);
    expect(el.hasAttribute("hidden")).toBe(false);
    expect(el.hasAttribute("required")).toBe(false);

    const [label, setLabel] = signal<string | null>("x");
    bindAttribute(el, "aria-label", () => label());
    setLabel(null);
    expect(el.hasAttribute("aria-label")).toBe(false);
  });
});

describe("media()", () => {
  it("returns { matches, dispose }", () => {
    const result = media("(max-width: 640px)");
    expect(typeof result.matches).toBe("function");
    expect(typeof result.matches()).toBe("boolean");
    expect(typeof result.dispose).toBe("function");
    result.dispose();
  });
});

describe("each(): the documented row pattern stays fresh", () => {
  type User = { id: number; name: string };

  // Mirrors docs/best-practices.md: getters are passed into the row and read
  // inside bindings, never unwrapped in the render body.
  function Row({ user, index }: { user: () => User; index: () => number }) {
    return div({ "data-id": () => String(user().id) }, [() => `${index() + 1}.${user().name}`]);
  }

  it("updates a reused row on same-key replacement and on reorder, rendering once per key", async () => {
    const [users, setUsers] = signal<User[]>([
      { id: 1, name: "Ada" },
      { id: 2, name: "Grace" },
    ]);
    let renders = 0;
    const list = div([
      each(
        () => users(),
        (user, index) => {
          renders++;
          return Row({ user, index });
        },
        { key: (u) => u.id },
      ),
    ]);
    const { unmount } = mount(list, document.body);
    await flush();
    const [first, second] = Array.from(list.children);
    expect(list.textContent).toBe("1.Ada2.Grace");

    setUsers([
      { id: 1, name: "Ada Lovelace" },
      { id: 2, name: "Grace" },
    ]);
    expect(list.textContent).toBe("1.Ada Lovelace2.Grace");

    setUsers([
      { id: 2, name: "Grace Hopper" },
      { id: 1, name: "Ada Lovelace" },
    ]);
    expect(list.textContent).toBe("1.Grace Hopper2.Ada Lovelace");
    expect(list.children[0]).toBe(second);
    expect(list.children[1]).toBe(first);
    expect(renders).toBe(2);
    unmount();
  });
});
