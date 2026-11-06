import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { match, when } from "../src/core/rendering/directives";
import { dispose, registerDisposer } from "../src/core/rendering/dispose";
import { div } from "../src/core/rendering/html";
import { signal } from "../src/core/signals/signal";

// ---------------------------------------------------------------------------
// A caller-owned nested directive used as a bare branch of a `when()` /
// `match()` stays live while that branch leaves, is parked or is taken back.
// Taking the branch back re-attaches what the nested directive renders NOW —
// read synchronously from the DOM, whether or not a MutationObserver has
// delivered — never a stale snapshot. A nested range that became empty brings
// only its anchor; content it removed (and disposed) is never re-inserted.
// ---------------------------------------------------------------------------

let host: HTMLElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  dispose(host);
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const flush = async (turns = 8) => {
  for (let i = 0; i < turns; i++) await Promise.resolve();
};

const NEVER = () => new Promise<void>(() => {});

type Kind = "when" | "match";

/**
 * An outer directive (`kind`) whose "on" branch is a caller-owned nested
 * directive of the same kind, rendering `.inner` while `inner` is on.
 */
function setup(kind: Kind, transition: { leave?: () => Promise<void> | void } | undefined, innerOn = true) {
  const [outer, setOuter] = signal(true);
  const [inner, setInner] = signal(innerOn);
  const innerCleanup = vi.fn();
  const innerContent = () => {
    const el = div({ class: "inner" }, "inner");
    registerDisposer(el, innerCleanup);
    return el;
  };
  const options = transition ? { transition } : undefined;
  let nested: Comment;
  let anchor: Comment;
  if (kind === "when") {
    nested = when(inner, innerContent);
    anchor = when(outer, nested, () => div({ class: "off" }, "off"), options);
  } else {
    nested = match(() => (inner() ? "on" : "off"), { on: innerContent });
    anchor = match(() => (outer() ? "on" : "off"), { on: nested, off: () => div({ class: "off" }, "off") }, options);
  }
  host.append(anchor);
  return { setOuter, setInner, nested, anchor, innerCleanup };
}

const inners = () => host.querySelectorAll(".inner").length;

describe.each<Kind>(["when", "match"])("%s(): taking back a leaving caller-owned nested directive", (kind) => {
  it.each([
    ["with microtasks (observer delivery) between the changes", true, false],
    ["synchronously, before any observer delivery", false, false],
    ["without MutationObserver", true, true],
  ])("re-attaches the nested range as it is now: empty — %s", async (_, between, noObserver) => {
    if (noObserver) vi.stubGlobal("MutationObserver", undefined);
    const t = setup(kind, { leave: NEVER });
    await flush();
    expect(inners()).toBe(1);
    const old = host.querySelector(".inner");
    t.setOuter(false);
    if (between) await flush();
    t.setInner(false);
    if (between) await flush();
    // Removed and disposed by the nested directive, which stayed live.
    expect(t.innerCleanup).toHaveBeenCalledTimes(1);
    t.setOuter(true);
    await flush();
    expect(t.nested.parentNode).toBe(host);
    expect(inners()).toBe(0);
    expect(old?.parentNode).toBeNull();
    // The nested directive keeps rendering into the re-attached range.
    t.setInner(true);
    await flush();
    expect(inners()).toBe(1);
    expect(host.querySelector(".inner")).not.toBe(old);
    expect(host.querySelector(".inner")?.hasAttribute("inert")).toBe(false);
    expect(t.innerCleanup).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["with microtasks between the changes", true],
    ["synchronously", false],
  ])("re-attaches content the nested range gained while leaving, once — %s", async (_, between) => {
    const t = setup(kind, { leave: NEVER }, false);
    await flush();
    expect(inners()).toBe(0);
    t.setOuter(false);
    if (between) await flush();
    t.setInner(true);
    if (between) await flush();
    t.setOuter(true);
    await flush();
    expect(inners()).toBe(1);
    const el = host.querySelector(".inner") as Element;
    expect(el.previousSibling).toBe(t.nested);
    expect(el.hasAttribute("inert")).toBe(false);
    expect(el.getAttribute("aria-hidden")).toBeNull();
  });

  it("a nested range emptied and refilled while leaving brings only its current content", async () => {
    const t = setup(kind, { leave: NEVER });
    await flush();
    const first = host.querySelector(".inner");
    t.setOuter(false);
    t.setInner(false);
    t.setInner(true);
    t.setOuter(true);
    await flush();
    expect(inners()).toBe(1);
    expect(host.querySelector(".inner")).not.toBe(first);
    expect(first?.parentNode).toBeNull();
    expect(t.innerCleanup).toHaveBeenCalledTimes(1);
  });
});

describe.each<Kind>(["when", "match"])("%s(): a parked caller-owned nested directive", (kind) => {
  it.each([
    ["without a transition", undefined],
    ["after a leave that ended", { leave: () => {} }],
  ])("keeps reconciling while parked in a detached fragment — %s", async (_, transition) => {
    const t = setup(kind, transition);
    await flush();
    t.setOuter(false);
    await flush();
    // Parked: off the page, still live.
    expect(t.nested.parentNode).not.toBe(host);
    expect(t.nested.parentNode).not.toBeNull();
    expect(inners()).toBe(0);
    t.setInner(false);
    await flush();
    expect(t.innerCleanup).toHaveBeenCalledTimes(1);
    t.setOuter(true);
    await flush();
    expect(t.nested.parentNode).toBe(host);
    expect(inners()).toBe(0);
    // Gaining content while parked: it comes back with the range.
    t.setOuter(false);
    await flush();
    t.setInner(true);
    await flush();
    t.setOuter(true);
    await flush();
    expect(inners()).toBe(1);
    expect(host.querySelector(".inner")?.previousSibling).toBe(t.nested);
  });
});
