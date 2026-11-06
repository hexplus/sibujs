import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DirectiveOptions, match, when } from "../src/core/rendering/directives";
import { dispose, registerDisposer } from "../src/core/rendering/dispose";
import { Fragment } from "../src/core/rendering/fragment";
import { div, span } from "../src/core/rendering/html";
import { signal } from "../src/core/signals/signal";

// ---------------------------------------------------------------------------
// The branch a `when()` / `match()` switches to is the directive's — reachable
// from its teardown, with its lifecycle — BEFORE the first node is inserted.
// Inserting a custom element runs its `connectedCallback` synchronously, and
// that may dispose the directive: the teardown then releases the whole
// incoming branch, the nodes already inserted and those not inserted yet,
// once, and ends its lifecycle; the insertion stops there. Nothing of it
// reacts, renders or enters afterwards. A bare (caller-owned) branch is only
// detached: what the caller built is never disposed by the directive.
// ---------------------------------------------------------------------------

type Kind = "when" | "match";

let host: HTMLElement;
let tags = 0;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
});

afterEach(() => {
  dispose(host);
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const flush = async (turns = 8) => {
  for (let i = 0; i < turns; i++) await Promise.resolve();
};

/** A fresh custom element type whose `connectedCallback` calls `onConnect`. */
function probe(onConnect: (el: HTMLElement) => void): { make: () => HTMLElement; connected: () => number } {
  const tag = `x-incoming-probe-${++tags}`;
  let connected = 0;
  customElements.define(
    tag,
    class extends HTMLElement {
      connectedCallback() {
        connected++;
        onConnect(this);
      }
    },
  );
  return { make: () => document.createElement(tag), connected: () => connected };
}

/**
 * A directive (`kind`) that renders nothing until `on` is set, then the
 * branch `content` builds. Returns the toggle and a way to read the anchor.
 */
function directive(kind: Kind, content: () => Node, options?: DirectiveOptions) {
  const [on, setOn] = signal(false);
  const anchor =
    kind === "when"
      ? when(on, content, options ?? {})
      : match(() => (on() ? "on" : "off"), { on: content }, options ?? {});
  host.append(anchor);
  return { setOn, anchor };
}

/** A trailing element with a reactive text binding (runs counted) and a counted cleanup. */
function trailing(label: string) {
  const [n, setN] = signal(0);
  const rec = { runs: 0, cleanup: vi.fn() };
  const make = () => {
    const el = div({ class: label }, () => {
      rec.runs++;
      return `${label}-${n()}`;
    });
    registerDisposer(el, rec.cleanup);
    return el;
  };
  return { make, setN, rec };
}

describe.each<Kind>(["when", "match"])("%s(): a connectedCallback that disposes the directive", (kind) => {
  it("reaches the trailing node not inserted yet: each cleanup runs once, nothing reacts", async () => {
    let anchor!: Comment;
    const ce = probe(() => dispose(anchor));
    const headCleanup = vi.fn();
    const tail = trailing("tail");
    const t = directive(kind, () => {
      const head = ce.make();
      registerDisposer(head, headCleanup);
      return Fragment([head, tail.make()]);
    });
    anchor = t.anchor;
    await flush();
    t.setOn(true);
    await flush();
    expect(ce.connected()).toBe(1);
    expect(headCleanup).toHaveBeenCalledTimes(1);
    expect(tail.rec.cleanup).toHaveBeenCalledTimes(1);
    // The insertion stopped: nothing of the branch is in the host.
    expect(host.children.length).toBe(0);
    const runs = tail.rec.runs;
    tail.setN(1);
    await flush();
    expect(tail.rec.runs).toBe(runs);
    expect(host.textContent).not.toContain("tail-1");
    // Later writes switch nothing.
    t.setOn(false);
    t.setOn(true);
    await flush();
    expect(ce.connected()).toBe(1);
    expect(host.children.length).toBe(0);
    expect(headCleanup).toHaveBeenCalledTimes(1);
    expect(tail.rec.cleanup).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["first", 0],
    ["middle", 1],
    ["last", 2],
  ])("a multi-node fragment disposed at its %s node is released whole, once", async (_, at) => {
    let anchor!: Comment;
    const ce = probe(() => dispose(anchor));
    const cleanups = [vi.fn(), vi.fn(), vi.fn()];
    const t = directive(kind, () => {
      const nodes = [0, 1, 2].map((i) => (i === at ? ce.make() : span({ class: `n${i}` }, `n${i}`)));
      for (let i = 0; i < nodes.length; i++) registerDisposer(nodes[i], cleanups[i]);
      const fragment = Fragment(nodes);
      const fragmentCleanup = vi.fn();
      registerDisposer(fragment, fragmentCleanup);
      cleanups.push(fragmentCleanup);
      return fragment;
    });
    anchor = t.anchor;
    await flush();
    t.setOn(true);
    await flush();
    for (const cleanup of cleanups) expect(cleanup).toHaveBeenCalledTimes(1);
    expect(host.children.length).toBe(0);
    expect(host.childNodes.length).toBe(1); // the anchor
  });

  it("a nested directive in the incoming branch never runs its queued first render", async () => {
    let anchor!: Comment;
    const ce = probe(() => dispose(anchor));
    const nestedFactory = vi.fn(() => span({ class: "nested" }, "nested"));
    const t = directive(kind, () => Fragment([ce.make(), when(() => true, nestedFactory)]));
    anchor = t.anchor;
    await flush();
    t.setOn(true);
    await flush();
    vi.runAllTimers();
    await flush();
    expect(nestedFactory).not.toHaveBeenCalled();
    expect(host.querySelector(".nested")).toBeNull();
    expect(host.children.length).toBe(0);
  });

  it.each([
    "both",
    "out-in",
    "in-out",
  ] as const)("with a transition (mode %s): no enter, no timer, and the leaving branch is released once", async (mode) => {
    let anchor!: Comment;
    let armed = false;
    const ce = probe(() => {
      if (armed) dispose(anchor);
    });
    const enter = vi.fn();
    let release!: () => void;
    const leave = vi.fn(() => new Promise<void>((r) => (release = r)));
    const [on, setOn] = signal("a");
    const before = trailing("before");
    const tail = trailing("tail");
    const options: DirectiveOptions = { transition: { mode, enter, leave } };
    const branches = {
      a: () => before.make(),
      b: () => Fragment([ce.make(), tail.make()]),
    };
    anchor = kind === "when" ? when(() => on() === "a", branches.a, branches.b, options) : match(on, branches, options);
    host.append(anchor);
    await flush();
    const base = vi.getTimerCount();
    armed = true;
    setOn("b");
    if (mode === "out-in") {
      release();
      await flush();
    }
    await flush();
    expect(ce.connected()).toBe(1);
    expect(enter).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(base);
    expect(host.children.length).toBe(0);
    expect(before.rec.cleanup).toHaveBeenCalledTimes(1);
    expect(tail.rec.cleanup).toHaveBeenCalledTimes(1);
    // A leave completing afterwards resurrects nothing.
    release?.();
    await flush();
    vi.runAllTimers();
    await flush();
    expect(host.children.length).toBe(0);
    expect(enter).not.toHaveBeenCalled();
    expect(before.rec.cleanup).toHaveBeenCalledTimes(1);
    expect(tail.rec.cleanup).toHaveBeenCalledTimes(1);
    const runs = tail.rec.runs;
    tail.setN(5);
    await flush();
    expect(tail.rec.runs).toBe(runs);
  });

  it("a bare (caller-owned) fragment is detached, never disposed: its bindings keep running", async () => {
    let anchor!: Comment;
    const ce = probe(() => dispose(anchor));
    const head = ce.make();
    const headCleanup = vi.fn();
    registerDisposer(head, headCleanup);
    const tail = trailing("tail");
    const tailEl = tail.make();
    const bare = Fragment([head, tailEl]);
    const [on, setOn] = signal(false);
    anchor = kind === "when" ? when(on, bare) : match(() => (on() ? "on" : "off"), { on: bare });
    host.append(anchor);
    await flush();
    setOn(true);
    await flush();
    expect(host.children.length).toBe(0);
    expect(headCleanup).not.toHaveBeenCalled();
    expect(tail.rec.cleanup).not.toHaveBeenCalled();
    tail.setN(3);
    await flush();
    expect(tailEl.textContent).toBe("tail-3");
    dispose(tailEl);
    dispose(head);
  });

  it("a connectedCallback that switches the condition instead: the final branch is shown, the first released once", async () => {
    let setOn!: (v: boolean) => void;
    const ce = probe(() => setOn(false));
    const tail = trailing("tail");
    const t = directive(kind, () => Fragment([ce.make(), tail.make()]));
    setOn = t.setOn;
    await flush();
    t.setOn(true);
    await flush();
    expect(ce.connected()).toBe(1);
    expect(tail.rec.cleanup).toHaveBeenCalledTimes(1);
    expect(host.children.length).toBe(0);
    expect(t.anchor.parentNode).toBe(host);
  });
});
