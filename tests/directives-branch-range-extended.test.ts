import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { when } from "../src/core/rendering/directives";
import { dispose } from "../src/core/rendering/dispose";
import { each } from "../src/core/rendering/each";
import { Fragment } from "../src/core/rendering/fragment";
import { button, div, span } from "../src/core/rendering/html";
import { KeepAlive } from "../src/core/rendering/keepAlive";
import { signal } from "../src/core/signals/signal";
import { createRouter, destroyRouter, Route } from "../src/plugins/router";

// ---------------------------------------------------------------------------
// Follow-ups to branch ranges and leave timing.
//
// 1. Where the engine exposes `getAnimations()`, a leave waits for what
//    actually started: a listed `transition-property` whose value does not
//    change starts nothing and is not waited for (it used to hold the branch
//    until the computed fallback).
// 2. `KeepAlive` and the router outlets register the nodes they render, so a
//    branch holding their anchor makes those nodes inert and removes them with
//    it, like `each()` rows.
// 3. A branch whose range can still grow while it leaves (a caller-owned
//    `each()` is not frozen) makes the late nodes inert, and gives them the
//    leave class, until the leave ends.
// ---------------------------------------------------------------------------

let host: HTMLElement;

beforeAll(() => {
  const sheet = document.createElement("style");
  sheet.textContent = ".out { animation-name: fade; animation-duration: 0.3s; }";
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
  delete (Element.prototype as { getAnimations?: unknown }).getAnimations;
});

const flush = () => new Promise<void>((r) => setTimeout(r, 0));
const end = (el: Element | null | undefined) => el?.dispatchEvent(new Event("animationend"));

describe("getAnimations(): wait for what actually started", () => {
  /** A fake running animation whose `finished` the test settles. */
  function fakeAnimation() {
    let resolve!: () => void;
    let reject!: (e: unknown) => void;
    const finished = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { animation: { finished } as unknown as Animation, resolve, reject };
  }

  function mockTiming(running: Animation[]) {
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation((el: Element) =>
      el.classList.contains("out")
        ? ({
            display: "block",
            // Two properties are listed; only one will actually change.
            transitionProperty: "opacity, color",
            transitionDuration: "0.2s, 3s",
            transitionDelay: "0s",
            animationName: "none",
            animationDuration: "0s",
            animationDelay: "0s",
            animationIterationCount: "1",
          } as CSSStyleDeclaration)
        : real(el),
    );
    (Element.prototype as { getAnimations?: () => Animation[] }).getAnimations = function (this: Element) {
      return this.classList.contains("out") ? running : [];
    };
  }

  async function mountLeaving() {
    const [on, setOn] = signal(true);
    host.appendChild(
      when(
        () => on(),
        () => span("A"),
        { transition: { leaveClass: "out" } },
      ),
    );
    await flush();
    const el = host.firstElementChild as HTMLElement;
    vi.useFakeTimers();
    setOn(false);
    return el;
  }

  it("ends when the transitions that started finish, not at the fallback for one that did not", async () => {
    const opacity = fakeAnimation();
    mockTiming([opacity.animation]);
    const el = await mountLeaving();
    await vi.advanceTimersByTimeAsync(100);
    expect(el.isConnected).toBe(true);
    opacity.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(el.isConnected).toBe(false);
  });

  it("a cancelled animation settles too", async () => {
    const a = fakeAnimation();
    const b = fakeAnimation();
    mockTiming([a.animation, b.animation]);
    const el = await mountLeaving();
    a.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(el.isConnected).toBe(true);
    b.reject(new DOMException("cancelled", "AbortError"));
    await vi.advanceTimersByTimeAsync(0);
    expect(el.isConnected).toBe(false);
  });

  it("nothing started: the branch is removed at once", async () => {
    mockTiming([]);
    const el = await mountLeaving();
    expect(el.isConnected).toBe(false);
  });

  it("an animation that never finishes is still capped by the computed fallback", async () => {
    mockTiming([fakeAnimation().animation]);
    const el = await mountLeaving();
    await vi.advanceTimersByTimeAsync(3049);
    expect(el.isConnected).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(el.isConnected).toBe(false);
  });
});

describe("KeepAlive and router outlets inside a leaving branch", () => {
  it("a KeepAlive's shown case leaves with the branch", async () => {
    const [on, setOn] = signal(true);
    const [tab] = signal("a");
    host.appendChild(
      when(
        () => on(),
        () => Fragment([span("tabs"), KeepAlive(() => tab(), { a: () => button("case a") })]),
        { transition: { leaveClass: "out" } },
      ),
    );
    await flush();
    await flush();
    setOn(false);
    const shown = host.querySelector("button") as HTMLElement;
    expect(shown.hasAttribute("inert")).toBe(true);
    expect(shown.classList.contains("out")).toBe(true);
    for (const el of Array.from(host.querySelectorAll(".out"))) end(el);
    expect(host.querySelector("button")).toBeNull();
  });

  it("a Route() outlet's page leaves with the branch", async () => {
    window.history.replaceState({}, "", "/");
    createRouter([{ path: "/", component: () => div([button("page")]) }], { mode: "history" });
    try {
      const [on, setOn] = signal(true);
      host.appendChild(
        when(
          () => on(),
          () => Fragment([span("shell"), Route()]),
          { transition: { leaveClass: "out" } },
        ),
      );
      for (let i = 0; i < 6; i++) await flush();
      expect(host.textContent).toBe("shellpage");
      setOn(false);
      const page = host.querySelector("button")?.parentElement as HTMLElement;
      expect(page.hasAttribute("inert")).toBe(true);
      for (const el of Array.from(host.querySelectorAll(".out"))) end(el);
      expect(host.textContent).toBe("");
    } finally {
      destroyRouter();
    }
  });
});

describe("a caller-owned each() that grows while its branch leaves", () => {
  it("makes rows added during the leave inert, with the leave class, and undoes it on re-attach", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const [visible, setVisible] = signal(true);
    const [items, setItems] = signal([1]);
    const fragment = Fragment([each(items, (item) => button(String(item.peek())), { key: (item) => item })]);
    host.appendChild(when(visible, fragment, { transition: { leaveClass: "out" } }));
    await flush();

    setVisible(false);
    setItems([1, 2]);
    await flush(); // the watch runs as a microtask after the insertion
    const late = host.querySelectorAll("button")[1] as HTMLElement;
    expect(late.textContent).toBe("2");
    expect(late.hasAttribute("inert")).toBe(true);
    expect(late.getAttribute("aria-hidden")).toBe("true");
    expect(late.classList.contains("out")).toBe(true);

    // Taking the branch back cancels the leave for every node, late ones included.
    setVisible(true);
    for (const b of Array.from(host.querySelectorAll("button"))) {
      expect(b.hasAttribute("inert")).toBe(false);
      expect(b.hasAttribute("aria-hidden")).toBe(false);
      expect(b.classList.contains("out")).toBe(false);
    }
    // And no watch is left behind: a row added now stays interactive.
    setItems([1, 2, 3]);
    await flush();
    expect(host.querySelectorAll("[inert]")).toHaveLength(0);
  });

  it("removes late rows with the branch when the leave ends", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const [visible, setVisible] = signal(true);
    const [items, setItems] = signal([1]);
    const fragment = Fragment([each(items, (item) => button(String(item.peek())), { key: (item) => item })]);
    host.appendChild(when(visible, fragment, { transition: { leaveClass: "out" } }));
    await flush();
    setVisible(false);
    setItems([1, 2]);
    await flush();
    for (const el of Array.from(host.querySelectorAll(".out"))) end(el);
    expect(host.querySelectorAll("button")).toHaveLength(0);
  });
});
