import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { match, when } from "../src/core/rendering/directives";
import { dispose, registerDisposer } from "../src/core/rendering/dispose";
import { Fragment } from "../src/core/rendering/fragment";
import { button, div, input, span } from "../src/core/rendering/html";
import { onUnmount } from "../src/core/rendering/lifecycle";
import { effect } from "../src/core/signals/effect";
import { signal } from "../src/core/signals/signal";
import { runInSSRContext } from "../src/core/ssr-context";

// ---------------------------------------------------------------------------
// `when()` / `match()` exit (and enter) transitions.
//
// THE CONTRACT UNDER TEST: with `transition`, the outgoing branch stays in the
// DOM until its leave ends, FROZEN (its bindings and effects stop at the
// switch), `inert` and `aria-hidden`, and only then is it removed and disposed
// (its `onUnmount` / disposers run exactly once, at that point). A leave ends
// on the end event, at a computed timeout, or at once when nothing animates;
// it can never hang. Without `transition`, nothing changes.
// ---------------------------------------------------------------------------

let host: HTMLElement;
let sheet: HTMLStyleElement;

beforeAll(() => {
  sheet = document.createElement("style");
  sheet.textContent = [
    ".out { animation-name: fade; animation-duration: 0.3s; }",
    ".in { animation-name: fade; animation-duration: 0.2s; }",
    ".forever { animation-name: spin; animation-duration: 1s; animation-iteration-count: infinite; }",
    ".instant { animation-name: fade; animation-duration: 0s; }",
    ".reduced { animation-name: fade; animation-duration: 0.01ms; }",
    ".gone { animation-name: fade; animation-duration: 1s; display: none; }",
  ].join("\n");
  document.head.appendChild(sheet);
});

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  vi.useRealTimers();
  dispose(host);
  host.remove();
  vi.restoreAllMocks();
});

const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const end = (el: Element | null | undefined) => el?.dispatchEvent(new Event("animationend"));
const texts = () => Array.from(host.children).map((el) => el.textContent);

/** A branch component that records its lifecycle. */
function Panel(name: string, log: string[], count?: () => number) {
  const el = div({ class: "panel", "data-name": name }, count ? () => `${name}:${count()}` : name);
  onUnmount(() => log.push(`unmount ${name}`), el);
  if (count) {
    // Tied to the element, so it is disposed with the branch.
    registerDisposer(
      el,
      effect(() => {
        log.push(`effect ${name}:${count()}`);
      }),
    );
  }
  return el;
}

describe("leave with leaveClass", () => {
  it("keeps the old branch, frozen and inert, until its animation ends, then removes it once", async () => {
    const [on, setOn] = signal(true);
    const [count, setCount] = signal(0);
    const log: string[] = [];
    host.appendChild(
      when(
        () => on(),
        () => Panel("A", log, count),
        () => Panel("B", log),
        { transition: { leaveClass: "out" } },
      ),
    );
    await flush();
    expect(texts()).toEqual(["A:0"]);
    const a = host.querySelector('[data-name="A"]') as HTMLElement;
    log.length = 0;

    setOn(false);
    // The new branch is in; the old one is still there, leaving.
    expect(texts()).toEqual(["B", "A:0"]);
    expect(a.classList.contains("out")).toBe(true);
    expect(a.hasAttribute("inert")).toBe(true);
    expect(a.getAttribute("aria-hidden")).toBe("true");
    expect(log).toEqual([]);

    // Frozen: neither its reactive text nor its effect reacts any more.
    setCount(1);
    expect(a.textContent).toBe("A:0");
    expect(log).toEqual([]);

    end(a);
    expect(texts()).toEqual(["B"]);
    expect(a.isConnected).toBe(false);
    expect(log).toEqual(["unmount A"]);

    // Disposed for good: nothing of A runs again.
    setCount(2);
    expect(log).toEqual(["unmount A"]);
  });

  it("a binding valid only while its branch is mounted never sees the state that removed it", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const [selected, setSelected] = signal<{ name: string } | null>({ name: "Ada" });
    host.appendChild(
      when(
        () => selected(),
        () => span(() => selected()!.name),
        () => span("none"),
        { transition: { leaveClass: "out" } },
      ),
    );
    await flush();
    setSelected(null);
    expect(texts()).toEqual(["none", "Ada"]);
    expect(error).not.toHaveBeenCalled();
  });

  it("ignores end events bubbling from a descendant", async () => {
    const [on, setOn] = signal(true);
    host.appendChild(
      when(
        () => on(),
        () => div([span("inner")]),
        { transition: { leaveClass: "out" } },
      ),
    );
    await flush();
    const el = host.firstElementChild as HTMLElement;
    setOn(false);
    el.firstElementChild?.dispatchEvent(new Event("animationend", { bubbles: true }));
    expect(el.isConnected).toBe(true);
    end(el);
    expect(el.isConnected).toBe(false);
  });

  it("falls back to a timeout from the computed animation when no event fires", async () => {
    const [on, setOn] = signal(true);
    host.appendChild(
      when(
        () => on(),
        () => span("A"),
        { transition: { leaveClass: "out" } },
      ),
    );
    await flush();
    vi.useFakeTimers();
    const el = host.firstElementChild as HTMLElement;
    setOn(false);
    vi.advanceTimersByTime(349);
    expect(el.isConnected).toBe(true);
    vi.advanceTimersByTime(1);
    expect(el.isConnected).toBe(false);
  });

  it("removes synchronously when nothing animates: zero duration, reduced motion, display: none, no class", async () => {
    for (const leaveClass of ["instant", "reduced", "gone", "no-such-rule"]) {
      const [on, setOn] = signal(true);
      const disposed: string[] = [];
      const anchor = when(
        () => on(),
        () => {
          const el = span(leaveClass);
          registerDisposer(el, () => disposed.push(leaveClass));
          return el;
        },
        { transition: { leaveClass } },
      );
      host.appendChild(anchor);
      await flush();
      setOn(false);
      expect(host.querySelectorAll("span")).toHaveLength(0);
      expect(disposed).toEqual([leaveClass]);
      dispose(anchor);
    }
  });

  it("caps an infinite animation at maxDuration, and at 5 s without one", async () => {
    const [on, setOn] = signal(true);
    const [on2, setOn2] = signal(true);
    host.appendChild(
      when(
        () => on(),
        () => span("capped"),
        { transition: { leaveClass: "forever", maxDuration: 100 } },
      ),
    );
    host.appendChild(
      when(
        () => on2(),
        () => span("hard"),
        { transition: { leaveClass: "forever" } },
      ),
    );
    await flush();
    vi.useFakeTimers();
    setOn(false);
    setOn2(false);
    vi.advanceTimersByTime(100);
    expect(texts()).toEqual(["hard"]);
    vi.advanceTimersByTime(4899);
    expect(texts()).toEqual(["hard"]);
    vi.advanceTimersByTime(1);
    expect(texts()).toEqual([]);
  });
});

describe("multi-node (fragment) branches", () => {
  it("animates every element of the fragment and removes it when ALL of them have finished", async () => {
    const [on, setOn] = signal(true);
    const [n, setN] = signal(1);
    host.appendChild(
      when(
        () => on(),
        () => Fragment([div("one"), "text", () => div(`n${n()}`)]),
        { transition: { leaveClass: "out" } },
      ),
    );
    await flush();
    // Rendered after insertion: never part of the fragment, still part of the branch.
    setN(2);
    setOn(false);
    const [one, last] = Array.from(host.children);
    expect(one.classList.contains("out")).toBe(true);
    expect(last.textContent).toBe("n2");
    expect(last.classList.contains("out")).toBe(true);
    expect(last.hasAttribute("inert")).toBe(true);
    end(one);
    expect(host.textContent).toBe("onetextn2");
    end(last);
    expect(host.textContent).toBe("");
    expect(host.childNodes).toHaveLength(1);
  });
});

describe("custom JS leave / enter", () => {
  it("removes the branch when the leave promise settles, and passes every top-level node", async () => {
    const [on, setOn] = signal(true);
    let finish!: () => void;
    const seen: Node[][] = [];
    host.appendChild(
      when(
        () => on(),
        () => Fragment([span("a"), span("b")]),
        {
          transition: {
            leaveClass: "out",
            leave: (nodes) => {
              seen.push(nodes);
              return new Promise<void>((r) => {
                finish = r;
              });
            },
          },
        },
      ),
    );
    await flush();
    setOn(false);
    expect(seen[0].map((n) => n.textContent)).toEqual(["a", "b"]);
    // The custom leave overrides leaveClass.
    expect(host.querySelector(".out")).toBeNull();
    expect(texts()).toEqual(["a", "b"]);
    finish();
    await flush();
    expect(texts()).toEqual([]);
  });

  it("a leave that returns nothing removes the branch at once; a throwing one is reported and still removes", async () => {
    const [on, setOn] = signal(true);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    host.appendChild(
      when(
        () => on(),
        () => span("x"),
        () => span("y"),
        {
          transition: {
            leave: (nodes) => {
              if (nodes[0].textContent === "y") throw new Error("boom");
            },
          },
        },
      ),
    );
    await flush();
    setOn(false);
    expect(texts()).toEqual(["y"]);
    setOn(true);
    expect(texts()).toEqual(["x"]);
    expect(error).toHaveBeenCalled();
  });
});

describe("rapid switching", () => {
  it("A→B→A→B with factories never leaks nodes, and every disposer runs exactly once", async () => {
    const [on, setOn] = signal(true);
    const built: string[] = [];
    const disposed: string[] = [];
    let n = 0;
    const make = (name: string) => () => {
      const id = `${name}${n++}`;
      built.push(id);
      const el = span({ "data-id": id }, name);
      registerDisposer(el, () => disposed.push(id));
      return el;
    };
    host.appendChild(when(() => on(), make("A"), make("B"), { transition: { leaveClass: "out" } }));
    await flush();
    vi.useFakeTimers();
    setOn(false);
    setOn(true);
    setOn(false);
    // Three branches leaving at once, the newest one shown first.
    expect(host.querySelectorAll("span")).toHaveLength(4);
    expect(host.querySelectorAll("[inert]")).toHaveLength(3);
    vi.advanceTimersByTime(400);
    expect(Array.from(host.querySelectorAll("span")).map((s) => s.dataset.id)).toEqual(["B3"]);
    expect(disposed.sort()).toEqual(["A0", "A2", "B1"]);
    dispose(host);
    expect(disposed.sort()).toEqual(["A0", "A2", "B1", "B3"]);
    expect(new Set(disposed).size).toBe(built.length);
  });
});

describe("modes", () => {
  it("out-in builds and inserts the new branch only after the old one has left", async () => {
    const [on, setOn] = signal(true);
    const built: string[] = [];
    host.appendChild(
      when(
        () => on(),
        () => {
          built.push("A");
          return span("A");
        },
        () => {
          built.push("B");
          return span("B");
        },
        { transition: { leaveClass: "out", enterClass: "in", mode: "out-in" } },
      ),
    );
    await flush();
    const a = host.firstElementChild;
    setOn(false);
    expect(texts()).toEqual(["A"]);
    expect(built).toEqual(["A"]);
    end(a);
    expect(texts()).toEqual(["B"]);
    expect(built).toEqual(["A", "B"]);
    expect(host.firstElementChild?.classList.contains("in")).toBe(true);
  });

  it("out-in builds whatever is current once the leave ends, however often it flipped meanwhile", async () => {
    const [key, setKey] = signal("a");
    const built: string[] = [];
    host.appendChild(
      match(
        () => key(),
        {
          a: () => {
            built.push("a");
            return span("a");
          },
          b: () => {
            built.push("b");
            return span("b");
          },
          c: () => {
            built.push("c");
            return span("c");
          },
        },
        { transition: { leaveClass: "out", mode: "out-in" } },
      ),
    );
    await flush();
    const a = host.firstElementChild;
    setKey("b");
    setKey("c");
    expect(built).toEqual(["a"]);
    end(a);
    expect(texts()).toEqual(["c"]);
    expect(built).toEqual(["a", "c"]);
  });

  it("in-out inserts and enters the new branch first, then leaves the old one", async () => {
    const [on, setOn] = signal(true);
    host.appendChild(
      when(
        () => on(),
        () => span("A"),
        () => span("B"),
        { transition: { leaveClass: "out", enterClass: "in", mode: "in-out" } },
      ),
    );
    await flush();
    const a = host.firstElementChild as HTMLElement;
    setOn(false);
    const b = host.firstElementChild as HTMLElement;
    expect(texts()).toEqual(["B", "A"]);
    expect(b.classList.contains("in")).toBe(true);
    // Old branch: already inert and frozen, but not leaving yet.
    expect(a.hasAttribute("inert")).toBe(true);
    expect(a.classList.contains("out")).toBe(false);

    end(b);
    expect(b.classList.contains("in")).toBe(false);
    expect(a.classList.contains("out")).toBe(true);
    end(a);
    expect(texts()).toEqual(["B"]);
  });

  it("the first render plays no enter unless appear is set", async () => {
    const [a] = signal(true);
    host.appendChild(
      when(
        () => a(),
        () => span("plain"),
        { transition: { enterClass: "in" } },
      ),
    );
    host.appendChild(
      when(
        () => a(),
        () => span("appear"),
        { transition: { enterClass: "in", appear: true } },
      ),
    );
    await flush();
    const [plain, appear] = Array.from(host.querySelectorAll("span"));
    expect(plain.classList.contains("in")).toBe(false);
    expect(appear.classList.contains("in")).toBe(true);
    end(appear);
    expect(appear.classList.contains("in")).toBe(false);
  });
});

describe("match() with three keys", () => {
  it("lets several cases leave at once and settles on the last one", async () => {
    const [key, setKey] = signal<"a" | "b" | "c">("a");
    const log: string[] = [];
    host.appendChild(
      match(
        () => key(),
        { a: () => Panel("a", log), b: () => Panel("b", log), c: () => Panel("c", log) },
        { transition: { leaveClass: "out", enterClass: "in" } },
      ),
    );
    await flush();
    setKey("b");
    setKey("c");
    expect(texts()).toEqual(["c", "b", "a"]);
    const [c, b, a] = Array.from(host.children);
    expect(c.classList.contains("in")).toBe(true);
    expect(b.classList.contains("in")).toBe(false);
    expect(b.classList.contains("out")).toBe(true);
    end(a);
    end(b);
    expect(texts()).toEqual(["c"]);
    expect(log).toEqual(["unmount a", "unmount b"]);
  });
});

describe("bare element branches", () => {
  it("switching back to a still-leaving bare element cancels its leave and re-attaches it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const [on, setOn] = signal(true);
    const [label, setLabel] = signal("x");
    const a = span(() => `A:${label()}`) as HTMLElement;
    const b = span("B") as HTMLElement;
    host.appendChild(when(() => on(), a, b, { transition: { leaveClass: "out" } }));
    await flush();
    setOn(false);
    expect(a.classList.contains("out")).toBe(true);
    expect(a.hasAttribute("inert")).toBe(true);

    setOn(true);
    expect(a.classList.contains("out")).toBe(false);
    expect(a.hasAttribute("inert")).toBe(false);
    expect(a.hasAttribute("aria-hidden")).toBe(false);
    expect(host.firstElementChild).toBe(a);
    expect(host.querySelectorAll("span")).toHaveLength(2);
    expect(b.classList.contains("out")).toBe(true);

    // Never frozen or disposed: it belongs to its creator.
    setLabel("y");
    expect(a.textContent).toBe("A:y");
    end(b);
    expect(texts()).toEqual(["A:y"]);
    expect(b.hasAttribute("inert")).toBe(false);
  });
});

describe("focus", () => {
  function setup(policy?: Parameters<typeof when>[3] extends infer O ? O : never) {
    const [on, setOn] = signal(true);
    host.appendChild(
      when(
        () => on(),
        () => div([input({ id: "q", "data-v": "A" })]),
        () => div([input({ id: "q", "data-v": "B" })]),
        { ...(policy as object), transition: { leaveClass: "out" } },
      ),
    );
    return setOn;
  }

  it("moves focus out of the leaving branch to its counterpart (preserve)", async () => {
    const setOn = setup();
    await flush();
    (host.querySelector('[data-v="A"]') as HTMLInputElement).focus();
    setOn(false);
    expect((document.activeElement as HTMLElement).dataset.v).toBe("B");
  });

  it("drops it with focus: discard", async () => {
    const setOn = setup({ focus: "discard" });
    await flush();
    (host.querySelector('[data-v="A"]') as HTMLInputElement).focus();
    setOn(false);
    expect(document.activeElement).toBe(document.body);
  });

  it("routes it with focus: { restoreTo } when there is no counterpart", async () => {
    const target = button("back") as HTMLButtonElement;
    document.body.appendChild(target);
    const [on, setOn] = signal(true);
    host.appendChild(
      when(
        () => on(),
        () => div([input({ "data-v": "A" })]),
        () => div("nothing to focus"),
        { focus: { restoreTo: target }, transition: { leaveClass: "out" } },
      ),
    );
    await flush();
    (host.querySelector('[data-v="A"]') as HTMLInputElement).focus();
    setOn(false);
    expect(document.activeElement).toBe(target);
    target.remove();
  });
});

describe("lifetime", () => {
  it("disposing the directive removes leaving branches at once and runs their disposers", async () => {
    const [on, setOn] = signal(true);
    const log: string[] = [];
    const anchor = when(
      () => on(),
      () => Panel("A", log),
      () => Panel("B", log),
      { transition: { leaveClass: "out" } },
    );
    host.appendChild(anchor);
    await flush();
    setOn(false);
    expect(texts()).toEqual(["B", "A"]);
    dispose(anchor);
    expect(texts()).toEqual([]);
    expect(log.sort()).toEqual(["unmount A", "unmount B"]);
  });

  it("is ignored in a server render", async () => {
    const [on, setOn] = signal(true);
    const anchor = runInSSRContext(() =>
      when(
        () => on(),
        () => span("A"),
        () => span("B"),
        { transition: { leaveClass: "out", enterClass: "in", appear: true } },
      ),
    );
    host.appendChild(anchor);
    await flush();
    expect(host.querySelector(".in")).toBeNull();
    setOn(false);
    expect(texts()).toEqual(["B"]);
    expect(host.querySelector(".out, .in, [inert]")).toBeNull();
  });

  it("without transition, the old branch is removed and disposed at the switch, as before", async () => {
    const [on, setOn] = signal(true);
    const log: string[] = [];
    host.appendChild(
      when(
        () => on(),
        () => Panel("A", log),
        () => Panel("B", log),
      ),
    );
    await flush();
    setOn(false);
    expect(texts()).toEqual(["B"]);
    expect(log).toEqual(["unmount A"]);
  });
});
