import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type DirectiveTransition, when } from "../src/core/rendering/directives";
import { dispose } from "../src/core/rendering/dispose";
import { Fragment } from "../src/core/rendering/fragment";
import { div, span } from "../src/core/rendering/html";
import { signal } from "../src/core/signals/signal";
import { createRouter, destroyRouter, Route, Suspense } from "../src/plugins/router";

// ---------------------------------------------------------------------------
// Enter readiness for asynchronously loaded content (`waitForContent`).
//
// The initial content of a `Suspense` boundary or route outlet in an entering
// branch enters with it when it settles in time: a class-based enter stays
// open for it, a custom enter waits for it. Bounded by a deadline fixed at
// the switch; never replayed; cancelled with the branch.
// ---------------------------------------------------------------------------

let host: HTMLElement;

beforeAll(() => {
  const sheet = document.createElement("style");
  sheet.textContent = [
    ".in { animation-name: rise; animation-duration: 0.2s; }",
    ".out { animation-name: fade; animation-duration: 0.3s; }",
  ].join("\n");
  document.head.appendChild(sheet);
});

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  dispose(host);
  host.remove();
  destroyRouter();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const flush = async (turns = 4) => {
  for (let i = 0; i < turns; i++) await new Promise<void>((r) => setTimeout(r, 0));
};
const end = (el: Element | null | undefined) => el?.dispatchEvent(new Event("animationend"));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * `when(show, …)` whose "on" branch is a heading plus a Suspense boundary at
 * its top level; the boundary's content is a `.content` element.
 */
function mount(transition: DirectiveTransition, initiallyOn = false) {
  const [on, setOn] = signal(initiallyOn);
  const content = deferred<HTMLElement>();
  const nodes = vi.fn(() => content.promise);
  const anchor = when(
    on,
    () => Fragment([span({ class: "heading" }, "heading"), Suspense({ nodes })]),
    () => span({ class: "off" }, "off"),
    { transition },
  );
  host.appendChild(anchor);
  return { anchor, setOn, content, nodes, contentEl: () => host.querySelector(".content") };
}

const contentNode = () => div({ class: "content" }, "content");

describe("class-based enter with waitForContent", () => {
  it("content settling during the enter joins it, and the enter ends with its animation", async () => {
    const { setOn, content, contentEl } = mount({ enterClass: "in", waitForContent: 1000 });
    await flush();
    setOn(true);
    const heading = host.querySelector(".heading");
    expect(heading?.classList.contains("in")).toBe(true);
    // The heading's animation ends; the enter stays open for the content.
    end(heading);
    expect(heading?.classList.contains("in")).toBe(true);
    content.resolve(contentNode());
    await flush();
    expect(contentEl()?.classList.contains("in")).toBe(true);
    end(contentEl());
    expect(heading?.classList.contains("in")).toBe(false);
    expect(contentEl()?.classList.contains("in")).toBe(false);
  });

  it("a failure's error view joins the enter instead", async () => {
    const { setOn, content } = mount({ enterClass: "in", waitForContent: 1000 });
    vi.spyOn(console, "error").mockImplementation(() => {});
    await flush();
    setOn(true);
    content.reject(new Error("offline"));
    await flush();
    const error = host.querySelector(".suspense-error");
    expect(error?.classList.contains("in")).toBe(true);
  });

  it("never-settling content: the enter ends at the deadline; nothing joins after it", async () => {
    const { setOn, content, contentEl } = mount({ enterClass: "in", waitForContent: 40 });
    await flush();
    setOn(true);
    const heading = host.querySelector(".heading");
    end(heading);
    expect(heading?.classList.contains("in")).toBe(true);
    await sleep(250);
    expect(heading?.classList.contains("in")).toBe(false);
    content.resolve(contentNode());
    await flush();
    expect(contentEl()).not.toBeNull();
    expect(contentEl()?.classList.contains("in")).toBe(false);
  });

  it("a deadline is never restarted by content that keeps arriving", async () => {
    const [items, setItems] = signal<string[]>([]);
    const [on, setOn] = signal(false);
    const { each } = await import("../src/core/rendering/each");
    const pending = deferred<HTMLElement>();
    host.appendChild(
      when(
        on,
        () =>
          Fragment([
            Suspense({ nodes: () => pending.promise }),
            each(items, (item) => span({ class: "row" }, item.peek()), { key: (item) => item }),
          ]),
        { transition: { enterClass: "in", waitForContent: 60 } },
      ),
    );
    await flush();
    setOn(true);
    const started = Date.now();
    // Rows keep joining while the enter is open...
    for (let i = 0; i < 4; i++) {
      setItems([...items(), `r${i}`]);
      await sleep(20);
    }
    // ...but the enter ended at its deadline, not 60 ms after the last row.
    const rows = [...host.querySelectorAll(".row")];
    expect(rows.length).toBe(4);
    for (const row of rows) end(row);
    await sleep(Math.max(0, started + 120 - Date.now()));
    expect(host.querySelectorAll(".in").length).toBe(0);
  });

  it("content settling after the enter ended appears without one", async () => {
    // No waitForContent: the enter is not kept open.
    const { setOn, content, contentEl } = mount({ enterClass: "in" });
    await flush();
    setOn(true);
    end(host.querySelector(".heading"));
    expect(host.querySelector(".in")).toBeNull();
    content.resolve(contentNode());
    await flush();
    expect(contentEl()?.classList.contains("in")).toBe(false);
  });

  it("a switch away cancels it: no class, no listener left, content disposed with the branch", async () => {
    const { setOn, content, contentEl } = mount({ enterClass: "in", waitForContent: 1000 });
    await flush();
    setOn(true);
    setOn(false);
    content.resolve(contentNode());
    await flush();
    expect(contentEl()).toBeNull();
    expect(host.querySelector(".heading.in")).toBeNull();
  });

  it("appear: false — the first render plays no enter, and waits for nothing", async () => {
    const { content, contentEl } = mount({ enterClass: "in", waitForContent: 1000 }, true);
    await flush();
    expect(host.querySelector(".in")).toBeNull();
    content.resolve(contentNode());
    await flush();
    expect(contentEl()?.classList.contains("in")).toBe(false);
  });

  it("appear: true — the first render's content joins", async () => {
    const { content, contentEl } = mount({ enterClass: "in", waitForContent: 1000, appear: true }, true);
    await flush();
    content.resolve(contentNode());
    await flush();
    expect(contentEl()?.classList.contains("in")).toBe(true);
  });

  it("in-out: the outgoing branch leaves only once the content has entered", async () => {
    const { setOn, content, contentEl } = mount({
      enterClass: "in",
      leaveClass: "out",
      mode: "in-out",
      waitForContent: 1000,
    });
    await flush();
    setOn(true);
    end(host.querySelector(".heading"));
    expect(host.querySelector(".off.out")).toBeNull();
    content.resolve(contentNode());
    await flush();
    expect(host.querySelector(".off.out")).toBeNull();
    end(contentEl());
    expect(host.querySelector(".off.out")).not.toBeNull();
  });

  it("content nested inside an element joins too", async () => {
    const [on, setOn] = signal(false);
    const content = deferred<HTMLElement>();
    host.appendChild(
      when(on, () => div({ class: "card" }, [Suspense({ nodes: () => content.promise })]), {
        transition: { enterClass: "in", waitForContent: 1000 },
      }),
    );
    await flush();
    setOn(true);
    end(host.querySelector(".card"));
    expect(host.querySelector(".card.in")).not.toBeNull();
    content.resolve(contentNode());
    await flush();
    expect(host.querySelector(".content.in")).not.toBeNull();
    end(host.querySelector(".content"));
    expect(host.querySelector(".in")).toBeNull();
  });

  it("a route outlet's first page joins", async () => {
    const page = deferred<void>();
    window.history.replaceState({}, "", "/");
    createRouter(
      [
        {
          path: "/",
          component: async () => {
            await page.promise;
            return div({ class: "content" }, "page");
          },
        },
      ],
      { mode: "history" },
    );
    const [on, setOn] = signal(false);
    host.appendChild(
      when(on, () => Fragment([span({ class: "heading" }, "h"), Route()]), {
        transition: { enterClass: "in", waitForContent: 1000 },
      }),
    );
    await flush();
    setOn(true);
    end(host.querySelector(".heading"));
    page.resolve();
    await flush();
    expect(host.querySelector(".content.in")).not.toBeNull();
  });
});

describe("custom enter with waitForContent", () => {
  it("is called once, after the content settled, with it", async () => {
    const enter = vi.fn();
    const { setOn, content } = mount({ enter, waitForContent: 1000 });
    await flush();
    setOn(true);
    await flush();
    expect(enter).not.toHaveBeenCalled();
    content.resolve(contentNode());
    await flush();
    expect(enter).toHaveBeenCalledTimes(1);
    const classes = (enter.mock.calls[0][0] as Node[])
      .filter((n): n is Element => n.nodeType === 1)
      .map((el) => el.className);
    expect(classes).toEqual(["heading", "content"]);
  });

  it("is called at the deadline when the content never settles; not again later", async () => {
    const enter = vi.fn();
    const { setOn, content } = mount({ enter, waitForContent: 40 });
    await flush();
    setOn(true);
    await sleep(250);
    expect(enter).toHaveBeenCalledTimes(1);
    content.resolve(contentNode());
    await flush();
    expect(enter).toHaveBeenCalledTimes(1);
  });

  it("synchronous content, rendered a microtask after the switch, is included", async () => {
    const enter = vi.fn();
    const [on, setOn] = signal(false);
    host.appendChild(
      when(on, () => Fragment([span("h"), Suspense({ nodes: () => contentNode() })]), {
        transition: { enter, waitForContent: 1000 },
      }),
    );
    await flush();
    setOn(true);
    await flush();
    expect(enter).toHaveBeenCalledTimes(1);
    expect((enter.mock.calls[0][0] as Node[]).some((n) => (n as Element).className === "content")).toBe(true);
  });

  it("disposal drops the wait: the enter is never called", async () => {
    const enter = vi.fn();
    const { setOn, content, anchor } = mount({ enter, waitForContent: 1000 });
    await flush();
    setOn(true);
    dispose(anchor);
    content.resolve(contentNode());
    await flush();
    expect(enter).not.toHaveBeenCalled();
  });

  it("the content factory and the load run once, whatever the enter does", async () => {
    const enter = vi.fn();
    const { setOn, content, nodes } = mount({ enter, waitForContent: 1000 });
    await flush();
    setOn(true);
    content.resolve(contentNode());
    await flush();
    expect(nodes).toHaveBeenCalledTimes(1);
  });
});

describe("readiness inside a paused ancestor", () => {
  it("content held while the ancestor is paused joins once it resumes, if the enter is still open", async () => {
    const [outer, setOuter] = signal(true);
    const [on, setOn] = signal(false);
    const content = deferred<HTMLElement>();
    let shared: HTMLElement | null = null;
    host.appendChild(
      when(
        outer,
        () =>
          (shared ??= div([
            when(on, () => Fragment([span({ class: "heading" }, "h"), Suspense({ nodes: () => content.promise })]), {
              transition: { enterClass: "in", waitForContent: 2000 },
            }),
          ])),
        () => span("other"),
        { transition: { leaveClass: "out" } },
      ),
    );
    await flush();
    setOn(true);
    end(host.querySelector(".heading"));
    setOuter(false); // the ancestor pauses: the boundary holds its result
    content.resolve(contentNode());
    await flush();
    expect(host.querySelector(".content")).toBeNull();
    setOuter(true); // taken back: the result is adopted, and joins
    await flush();
    expect(host.querySelector(".content.in")).not.toBeNull();
  });

  it("a custom enter waiting for content waits for the ancestor too", async () => {
    const enter = vi.fn();
    const [outer, setOuter] = signal(true);
    const [on, setOn] = signal(false);
    const content = deferred<HTMLElement>();
    let shared: HTMLElement | null = null;
    host.appendChild(
      when(
        outer,
        () =>
          (shared ??= div([
            when(on, () => Fragment([span("h"), Suspense({ nodes: () => content.promise })]), {
              transition: { enter, waitForContent: 2000 },
            }),
          ])),
        () => span("other"),
        { transition: { leaveClass: "out" } },
      ),
    );
    await flush();
    setOn(true);
    setOuter(false);
    content.resolve(contentNode());
    await flush();
    expect(enter).not.toHaveBeenCalled();
    setOuter(true);
    await flush();
    expect(enter).toHaveBeenCalledTimes(1);
  });
});
