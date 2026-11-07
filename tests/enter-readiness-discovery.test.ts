import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type DirectiveTransition, when } from "../src/core/rendering/directives";
import { dispose } from "../src/core/rendering/dispose";
import { Fragment } from "../src/core/rendering/fragment";
import { div, span } from "../src/core/rendering/html";
import { pendingCount } from "../src/core/rendering/range";
import { signal } from "../src/core/signals/signal";
import { createRouter, destroyRouter, Outlet, Route, Suspense } from "../src/plugins/router";

// ---------------------------------------------------------------------------
// Readiness revealed by content that arrives during the enter.
//
// When a pending registration settles, its content joins, and the enter's
// dependencies are taken again from the branch as it is now: a boundary or
// outlet the content revealed keeps the enter open too. The deadline fixed at
// the switch never moves. And content arriving inside an element that is
// still animating its enter does not get a second copy of that animation.
// ---------------------------------------------------------------------------

let host: HTMLElement;

beforeAll(() => {
  const sheet = document.createElement("style");
  sheet.textContent = ".in { animation-name: rise; animation-duration: 0.2s; }";
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
});

const flush = async (turns = 6) => {
  for (let i = 0; i < turns; i++) await new Promise<void>((r) => setTimeout(r, 0));
};
const end = (el: Element | null | undefined) => el?.dispatchEvent(new Event("animationend"));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const q = (selector: string) => host.querySelector(selector);

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * A branch whose content is a chain of `levels` Suspense boundaries: each
 * level's content is `.lN` holding the next boundary.
 */
function nested(levels: number, transition: DirectiveTransition) {
  const gates = Array.from({ length: levels }, () => deferred<void>());
  const level = (i: number): Node =>
    Suspense({
      nodes: async () => {
        await gates[i].promise;
        return div({ class: `l${i}` }, i + 1 < levels ? [level(i + 1)] : [`level ${i}`]);
      },
    });
  const [on, setOn] = signal(false);
  const anchor = when(on, () => Fragment([span({ class: "heading" }, "h"), level(0)]), { transition });
  host.appendChild(anchor);
  return { setOn, gates, anchor };
}

describe("class-based enter: dependencies revealed by committed content", () => {
  it("nested Suspense: the inner boundary keeps the enter open, and its content joins", async () => {
    const { setOn, gates } = nested(2, { enterClass: "in", waitForContent: 2000 });
    await flush();
    setOn(true);
    end(q(".heading"));
    gates[0].resolve();
    await flush();
    expect(q(".l0")?.classList.contains("in")).toBe(true);
    end(q(".l0"));
    // The outer content's animation ended; the inner boundary is pending.
    expect(q(".heading")?.classList.contains("in")).toBe(true);
    gates[1].resolve();
    await flush();
    // Its parent is no longer animating: it enters on its own.
    expect(q(".l1")?.classList.contains("in")).toBe(true);
    end(q(".l1"));
    expect(host.querySelectorAll(".in").length).toBe(0);
  });

  it("three levels", async () => {
    const { setOn, gates } = nested(3, { enterClass: "in", waitForContent: 2000 });
    await flush();
    setOn(true);
    end(q(".heading"));
    for (let i = 0; i < 3; i++) {
      gates[i].resolve();
      await flush();
      expect(q(`.l${i}`)?.classList.contains("in"), `level ${i}`).toBe(true);
      end(q(`.l${i}`));
      if (i < 2) expect(q(".heading")?.classList.contains("in"), `open after level ${i}`).toBe(true);
    }
    expect(host.querySelectorAll(".in").length).toBe(0);
  });

  it("a rejected inner boundary: its error view joins", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const inner = deferred<HTMLElement>();
    const outer = deferred<void>();
    const [on, setOn] = signal(false);
    host.appendChild(
      when(
        on,
        () =>
          Fragment([
            span({ class: "heading" }, "h"),
            Suspense({
              nodes: async () => {
                await outer.promise;
                return div({ class: "outer" }, [Suspense({ nodes: () => inner.promise })]);
              },
            }),
          ]),
        { transition: { enterClass: "in", waitForContent: 2000 } },
      ),
    );
    await flush();
    setOn(true);
    end(q(".heading"));
    outer.resolve();
    await flush();
    end(q(".outer"));
    expect(q(".heading")?.classList.contains("in")).toBe(true);
    inner.reject(new Error("offline"));
    await flush();
    expect(q(".suspense-error")?.classList.contains("in")).toBe(true);
    end(q(".suspense-error"));
    expect(host.querySelectorAll(".in").length).toBe(0);
  });

  it("a route layout revealing a pending Outlet keeps the enter open for the child page", async () => {
    const child = deferred<void>();
    createRouter(
      [
        {
          path: "/l",
          component: () => div({ class: "layout" }, [Outlet()]),
          children: [
            {
              path: "/a",
              component: async () => {
                await child.promise;
                return div({ class: "child" }, "child");
              },
            },
          ],
        },
      ],
      { mode: "memory", url: "/l/a" },
    );
    const [on, setOn] = signal(false);
    host.appendChild(
      when(on, () => Fragment([span({ class: "heading" }, "h"), Route()]), {
        transition: { enterClass: "in", waitForContent: 2000 },
      }),
    );
    await flush();
    setOn(true);
    await flush();
    end(q(".heading"));
    expect(q(".layout")?.classList.contains("in")).toBe(true);
    end(q(".layout"));
    expect(q(".heading")?.classList.contains("in")).toBe(true);
    child.resolve();
    await flush();
    expect(q(".child")?.classList.contains("in")).toBe(true);
    end(q(".child"));
    expect(host.querySelectorAll(".in").length).toBe(0);
  });

  it("a never-settling inner boundary: the enter closes at the ORIGINAL deadline", async () => {
    const outer = deferred<void>();
    const [on, setOn] = signal(false);
    host.appendChild(
      when(
        on,
        () =>
          Fragment([
            span({ class: "heading" }, "h"),
            Suspense({
              nodes: async () => {
                await outer.promise;
                return div({ class: "outer" }, [Suspense({ nodes: () => new Promise<HTMLElement>(() => {}) })]);
              },
            }),
          ]),
        { transition: { enterClass: "in", waitForContent: 500 } },
      ),
    );
    await flush();
    const started = Date.now();
    setOn(true);
    end(q(".heading"));
    await sleep(250);
    // Discovered ~250 ms in: the deadline stays 500 ms from the switch (a
    // restarted one would be ~750 ms).
    outer.resolve();
    await flush();
    end(q(".outer"));
    expect(q(".heading")?.classList.contains("in")).toBe(true);
    await sleep(Math.max(0, started + 625 - Date.now()));
    expect(q(".heading")?.classList.contains("in")).toBe(false);
  });

  it("cancellation: switching away while the inner boundary is pending leaves no class and no listener", async () => {
    const before = pendingCount();
    const { setOn, gates } = nested(2, { enterClass: "in", waitForContent: 2000 });
    await flush();
    setOn(true);
    gates[0].resolve();
    await flush();
    setOn(false);
    await flush();
    expect(host.querySelectorAll(".in").length).toBe(0);
    expect(pendingCount()).toBe(before);
    gates[1].resolve();
    await flush();
    expect(q(".l1")).toBeNull();
  });

  it("a completed enter is never replayed by a boundary revealed later", async () => {
    const { setOn, gates } = nested(2, { enterClass: "in", waitForContent: 60 });
    await flush();
    setOn(true);
    end(q(".heading"));
    await sleep(200);
    expect(host.querySelectorAll(".in").length).toBe(0);
    gates[0].resolve();
    await flush();
    gates[1].resolve();
    await flush();
    expect(q(".l1")).not.toBeNull();
    expect(host.querySelectorAll(".in").length).toBe(0);
  });
});

describe("custom enter: the same dependencies", () => {
  it("waits for the inner boundary the outer content revealed", async () => {
    const enter = vi.fn();
    const { setOn, gates } = nested(2, { enter, waitForContent: 2000 });
    await flush();
    setOn(true);
    gates[0].resolve();
    await flush();
    expect(enter).not.toHaveBeenCalled();
    gates[1].resolve();
    await flush();
    expect(enter).toHaveBeenCalledTimes(1);
  });

  it("is called at the original deadline when the inner boundary never settles", async () => {
    const enter = vi.fn();
    const { setOn, gates } = nested(2, { enter, waitForContent: 400 });
    await flush();
    const started = Date.now();
    setOn(true);
    await sleep(50);
    gates[0].resolve();
    await flush();
    expect(enter).not.toHaveBeenCalled();
    await sleep(Math.max(0, started + 600 - Date.now()));
    expect(enter).toHaveBeenCalledTimes(1);
  });
});

describe("no compounded animation on content inside an element still entering", () => {
  it("content revealed inside an element whose enter animation is running does not get the class", async () => {
    const content = deferred<HTMLElement>();
    const [on, setOn] = signal(false);
    host.appendChild(
      when(on, () => div({ class: "card" }, [Suspense({ nodes: () => content.promise })]), {
        transition: { enterClass: "in", waitForContent: 2000 },
      }),
    );
    await flush();
    setOn(true);
    // The card is still animating when its content arrives.
    content.resolve(div({ class: "content" }, "c"));
    await flush();
    expect(q(".card")?.classList.contains("in")).toBe(true);
    expect(q(".content")).not.toBeNull();
    expect(q(".content")?.classList.contains("in")).toBe(false);
    // Nothing else to wait for: the enter ends with the card's animation.
    end(q(".card"));
    expect(host.querySelectorAll(".in").length).toBe(0);
  });

  it("sibling range elements still join (they are not inside an animating element)", async () => {
    const content = deferred<HTMLElement>();
    const [on, setOn] = signal(false);
    host.appendChild(
      when(on, () => Fragment([span({ class: "heading" }, "h"), Suspense({ nodes: () => content.promise })]), {
        transition: { enterClass: "in", waitForContent: 2000 },
      }),
    );
    await flush();
    setOn(true);
    // The heading is still animating; the content is its sibling.
    content.resolve(div({ class: "content" }, "c"));
    await flush();
    expect(q(".content")?.classList.contains("in")).toBe(true);
  });

  it("a nested transition configured on its own is untouched", async () => {
    const [on, setOn] = signal(false);
    const [inner, setInner] = signal(false);
    host.appendChild(
      when(
        on,
        () =>
          div({ class: "card" }, [
            when(inner, () => span({ class: "inner" }, "i"), { transition: { enterClass: "in" } }),
          ]),
        { transition: { enterClass: "in", waitForContent: 2000 } },
      ),
    );
    await flush();
    setOn(true);
    await flush();
    setInner(true);
    await flush();
    // Its own enter, while the card is still entering.
    expect(q(".inner")?.classList.contains("in")).toBe(true);
  });
});
