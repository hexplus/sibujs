import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "../src/components/ErrorBoundary";
import { type RuntimeErrorContext, setRuntimeErrorHandler } from "../src/core/errors";
import { dispose } from "../src/core/rendering/dispose";
import { signal } from "../src/core/signals/signal";
import { getSubscriberCount } from "../src/devtools/introspect";
import { bindField, form } from "../src/ui/form";
import { VirtualList } from "../src/ui/virtualList";
import { accordion } from "../src/widgets/Accordion";
import { combobox } from "../src/widgets/Combobox";
import { datePicker } from "../src/widgets/datePicker";
import { fileUpload } from "../src/widgets/FileUpload";
import { popover } from "../src/widgets/Popover";
import { select } from "../src/widgets/Select";
import { tabs } from "../src/widgets/Tabs";
import { tooltip } from "../src/widgets/Tooltip";

// ---------------------------------------------------------------------------
// DOM-owned widget effects route later failures to the enclosing ErrorBoundary.
//
// THE DEFECT: VirtualList and the widget `bind()` methods registered their DOM
// updates with a plain `effect()`. An effect subscriber carries no owner node,
// so when an update threw on a LATER scheduled run (a user `renderItem` /
// `option` / `cell` callback, or a DOM write) the drain reported it with
// `node: undefined`. `reportError` then had no DOM position to start from, the
// nearest ErrorBoundary never saw it, and it fell through to the global handler.
//
// The fix binds each update through `reactiveBinding(commit, ownerNode)`.
// ---------------------------------------------------------------------------

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

let host: HTMLElement | null = null;

afterEach(() => {
  setRuntimeErrorHandler(null);
  host?.remove();
  host = null;
  vi.restoreAllMocks();
});

/** A plain `<div>` typed as HTMLElement, holding the given children or text. */
function box(children: Array<Node | string> | string = []): HTMLElement {
  const el = document.createElement("div");
  if (typeof children === "string") el.textContent = children;
  else el.append(...children);
  return el;
}

/** Make `prop` on `el` throw on writes while `bad()` is true. */
function throwingSetter(el: HTMLElement, prop: string, bad: () => boolean, message: string): void {
  let value: unknown = (el as unknown as Record<string, unknown>)[prop];
  Object.defineProperty(el, prop, {
    configurable: true,
    get: () => value,
    set: (v) => {
      if (bad()) throw new Error(message);
      value = v;
    },
  });
}

interface Scenario {
  name: string;
  /**
   * Build the widget DOM, bind it, and return the root plus the node the
   * binding must report as its owner. `trigger()` causes a scheduled update
   * that throws; `bad()` is true from then on.
   */
  build: (bad: () => boolean) => { root: HTMLElement; owner: HTMLElement; trigger: () => void };
}

const SCENARIOS: Scenario[] = [
  {
    name: "VirtualList renderItem",
    build: (bad) => {
      const [items, setItems] = signal([1, 2, 3]);
      const list = VirtualList({
        items,
        itemHeight: 10,
        containerHeight: 30,
        renderItem: (n) => {
          if (bad()) throw new Error("renderItem exploded");
          return box(String(n));
        },
      });
      return { root: list, owner: list, trigger: () => setItems([4, 5, 6]) };
    },
  },
  {
    name: "Combobox.bind option",
    build: (bad) => {
      const cb = combobox({ items: ["a", "b"] });
      const input = document.createElement("input");
      const listbox = box();
      const root = box([input, listbox]);
      cb.bind({
        input,
        listbox,
        option: () => {
          if (bad()) throw new Error("combobox option exploded");
          return null;
        },
      });
      return { root, owner: input, trigger: () => cb.open() };
    },
  },
  {
    name: "Select.bind option",
    build: (bad) => {
      const s = select({ items: ["a", "b"] });
      const listbox = box();
      const root = box([listbox]);
      s.bind({
        listbox,
        option: () => {
          if (bad()) throw new Error("select option exploded");
          return null;
        },
      });
      return { root, owner: listbox, trigger: () => s.highlightNext() };
    },
  },
  {
    name: "datePicker.bind cell",
    build: (bad) => {
      const dp = datePicker({ initialDate: new Date(2026, 0, 15) });
      const grid = box();
      const root = box([grid]);
      dp.bind({
        grid,
        cell: () => {
          if (bad()) throw new Error("datePicker cell exploded");
          return null;
        },
      });
      return { root, owner: grid, trigger: () => dp.nextMonth() };
    },
  },
  {
    name: "Tabs.bind",
    build: (bad) => {
      const t = tabs({
        tabs: [
          { id: "one", label: "One" },
          { id: "two", label: "Two" },
        ],
      });
      const tablist = box();
      const one = box();
      const two = box();
      const root = box([tablist, one, two]);
      t.bind({ tablist, tabs: { one, two } });
      throwingSetter(two, "tabIndex", bad, "tabs update exploded");
      return { root, owner: tablist, trigger: () => t.setActiveTab("two") };
    },
  },
  {
    name: "Accordion.bind with root",
    build: (bad) => {
      const a = accordion({ items: [{ id: "x", label: "X" }] });
      const trig = box();
      const panel = box();
      const root = box([trig, panel]);
      a.bind({ root, triggers: { x: trig }, panels: { x: panel } });
      throwingSetter(panel, "hidden", bad, "accordion update exploded");
      return { root, owner: root, trigger: () => a.toggle("x") };
    },
  },
  {
    name: "Accordion.bind without root (first trigger)",
    build: (bad) => {
      const a = accordion({ items: [{ id: "x", label: "X" }] });
      const trig = box();
      const panel = box();
      const root = box([trig, panel]);
      a.bind({ triggers: { x: trig }, panels: { x: panel } });
      throwingSetter(panel, "hidden", bad, "accordion update exploded");
      return { root, owner: trig, trigger: () => a.toggle("x") };
    },
  },
  {
    name: "FileUpload.bind",
    build: (bad) => {
      const f = fileUpload();
      const input = document.createElement("input");
      const dropZone = box();
      const root = box([input, dropZone]);
      f.bind({ input, dropZone });
      const original = dropZone.setAttribute.bind(dropZone);
      dropZone.setAttribute = (name: string, value: string) => {
        if (bad()) throw new Error("fileUpload update exploded");
        original(name, value);
      };
      return { root, owner: input, trigger: () => f.setDragOver(true) };
    },
  },
  {
    name: "Popover.bind",
    build: (bad) => {
      const p = popover();
      const trigger = document.createElement("button");
      const pop = box();
      const root = box([trigger, pop]);
      p.bind({ trigger, popover: pop });
      throwingSetter(pop, "hidden", bad, "popover update exploded");
      return { root, owner: trigger, trigger: () => p.open() };
    },
  },
  {
    name: "Tooltip.bind",
    build: (bad) => {
      const t = tooltip({ delay: 0 });
      const trigger = document.createElement("button");
      const tip = box();
      const root = box([trigger, tip]);
      t.bind({ trigger, tooltip: tip });
      throwingSetter(tip, "hidden", bad, "tooltip update exploded");
      return { root, owner: trigger, trigger: () => t.show() };
    },
  },
  {
    name: "bindField multi-select",
    build: (bad) => {
      const f = form({ tags: { initial: ["a"] as string[] } });
      const el = document.createElement("select");
      el.multiple = true;
      const opt = document.createElement("option");
      opt.value = "a";
      el.appendChild(opt);
      (bindField(f.fields.tags).onElement as (el: HTMLElement) => void)(el);
      throwingSetter(opt, "selected", bad, "multi-select update exploded");
      const root = box([el]);
      return { root, owner: el, trigger: () => f.fields.tags.set(["b"]) };
    },
  },
];

describe("widget DOM bindings report their owner node", () => {
  for (const scenario of SCENARIOS) {
    it(`${scenario.name}: a scheduled failure carries phase "binding" and the owner node`, async () => {
      const reports: Array<{ error: unknown; context: RuntimeErrorContext }> = [];
      setRuntimeErrorHandler((error, context) => reports.push({ error, context }));

      let isBad = false;
      const { owner, trigger } = scenario.build(() => isBad);
      expect(reports).toHaveLength(0);

      isBad = true;
      trigger();
      await flush();

      expect(reports).toHaveLength(1);
      expect(reports[0].context.phase).toBe("binding");
      expect(reports[0].context.node).toBe(owner);
    });
  }
});

describe("a scheduled widget failure is claimed by the enclosing ErrorBoundary", () => {
  for (const scenario of SCENARIOS) {
    it(`${scenario.name}: renders the fallback and skips the global handler`, async () => {
      const handler = vi.fn();
      setRuntimeErrorHandler(handler);
      vi.spyOn(console, "error").mockImplementation(() => {});

      let isBad = false;
      let trigger: () => void = () => {};
      const boundary = ErrorBoundary(
        {
          fallback: () => {
            const fb = box("caught");
            fb.className = "boundary-fallback";
            return fb;
          },
        },
        () => {
          const built = scenario.build(() => isBad);
          trigger = built.trigger;
          return built.root;
        },
      );

      host = document.createElement("div");
      document.body.appendChild(host);
      host.appendChild(boundary);
      await flush();
      expect(host.querySelector(".boundary-fallback")).toBeNull();

      isBad = true;
      trigger();
      await flush();

      expect(host.querySelector(".boundary-fallback")?.textContent).toBe("caught");
      expect(handler).not.toHaveBeenCalled();
    });
  }
});

describe("VirtualList disposal still releases its binding", () => {
  it("dispose() unsubscribes the items source", () => {
    const [items] = signal([1, 2, 3]);
    const list = VirtualList({ items, itemHeight: 10, containerHeight: 30, renderItem: (n) => box(String(n)) });
    expect(getSubscriberCount(items)).toBe(1);
    dispose(list);
    expect(getSubscriberCount(items)).toBe(0);
  });
});
