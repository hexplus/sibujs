import { afterEach, describe, expect, it, vi } from "vitest";
import { match, when } from "../src/core/rendering/directives";
import { dispose } from "../src/core/rendering/dispose";
import { div } from "../src/core/rendering/html";
import { signal } from "../src/core/signals/signal";
import { getSubscriberCount } from "../src/devtools/introspect";

// ---------------------------------------------------------------------------
// when() / match() disposed before their initial-render microtask runs.
//
// THE DEFECT: both directives queue their first render in a microtask guarded
// only by `initialized` and `anchor.parentNode`. `dispose(anchor)` does not
// detach the anchor, so a directive disposed before that microtask still
// rendered: the branch factory ran and inserted DOM after teardown, outside
// the disposal traversal that had already completed.
// ---------------------------------------------------------------------------

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

let host: HTMLElement;

afterEach(() => {
  host?.remove();
});

function mountHost(): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  return host;
}

describe("when() disposed before its initial microtask", () => {
  it("never runs the branch factory and inserts no node", async () => {
    const factory = vi.fn(() => div("late"));
    const anchor = when(() => true, factory);
    mountHost().append(anchor);

    dispose(anchor);
    await flush();

    expect(factory).not.toHaveBeenCalled();
    expect(host.childNodes).toHaveLength(1);
    expect(host.firstChild).toBe(anchor);
  });

  it("does not render the else branch either", async () => {
    const elseFactory = vi.fn(() => div("else"));
    const anchor = when(
      () => false,
      () => div("then"),
      elseFactory,
    );
    mountHost().append(anchor);

    dispose(anchor);
    await flush();

    expect(elseFactory).not.toHaveBeenCalled();
    expect(host.childNodes).toHaveLength(1);
  });

  it("stays inert when its condition changes after disposal", async () => {
    const [show, setShow] = signal(false);
    const factory = vi.fn(() => div("late"));
    const anchor = when(show, factory);
    mountHost().append(anchor);

    dispose(anchor);
    setShow(true);
    await flush();

    expect(factory).not.toHaveBeenCalled();
    expect(host.childNodes).toHaveLength(1);
    expect(getSubscriberCount(show)).toBe(0);
  });

  it("still renders when it is not disposed", async () => {
    const factory = vi.fn(() => div("shown"));
    const anchor = when(() => true, factory);
    mountHost().append(anchor);
    await flush();

    expect(factory).toHaveBeenCalledTimes(1);
    expect(host.textContent).toBe("shown");
    dispose(host);
  });
});

describe("match() disposed before its initial microtask", () => {
  it("never runs the case factory and inserts no node", async () => {
    const caseFactory = vi.fn(() => div("a"));
    const anchor = match(() => "a", { a: caseFactory });
    mountHost().append(anchor);

    dispose(anchor);
    await flush();

    expect(caseFactory).not.toHaveBeenCalled();
    expect(host.childNodes).toHaveLength(1);
    expect(host.firstChild).toBe(anchor);
  });

  it("does not render the fallback either", async () => {
    const fallback = vi.fn(() => div("fallback"));
    const anchor = match(() => "missing", { a: () => div("a") }, fallback);
    mountHost().append(anchor);

    dispose(anchor);
    await flush();

    expect(fallback).not.toHaveBeenCalled();
    expect(host.childNodes).toHaveLength(1);
  });

  it("stays inert when its value changes after disposal", async () => {
    const [key, setKey] = signal<"a" | "b">("a");
    const bFactory = vi.fn(() => div("b"));
    const anchor = match(key, { a: () => div("a"), b: bFactory });
    mountHost().append(anchor);

    dispose(anchor);
    setKey("b");
    await flush();

    expect(bFactory).not.toHaveBeenCalled();
    expect(host.childNodes).toHaveLength(1);
    expect(getSubscriberCount(key)).toBe(0);
  });

  it("still renders when it is not disposed", async () => {
    const caseFactory = vi.fn(() => div("matched"));
    const anchor = match(() => "a", { a: caseFactory });
    mountHost().append(anchor);
    await flush();

    expect(caseFactory).toHaveBeenCalledTimes(1);
    expect(host.textContent).toBe("matched");
    dispose(host);
  });
});
