import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { match, when } from "../src/core/rendering/directives";
import { button, div, input, span } from "../src/core/rendering/html";
import { signal } from "../src/core/signals/signal";

// ---------------------------------------------------------------------------
// The `focus` option of when()/match(): an explicit, local way to say that a
// rebuild drops focus on purpose ("discard"), or where focus should go instead
// of <body> ({ restoreTo }). The default keeps the existing warning.
// ---------------------------------------------------------------------------

const flushMicrotasks = () => Promise.resolve().then(() => Promise.resolve());

let warn: MockInstance<(...args: unknown[]) => void>;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  document.body.innerHTML = "";
});

afterEach(() => {
  warn.mockRestore();
  document.body.innerHTML = "";
});

function focusWarnings(): string[] {
  return warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("discarded the focused element"));
}

describe("when(): focus option", () => {
  it("warns by default when the focused element is discarded", async () => {
    const [open, setOpen] = signal(true);
    const host = div([
      when(
        () => open(),
        () => input({ type: "text" }),
      ),
    ]);
    document.body.appendChild(host);
    await flushMicrotasks();
    host.querySelector("input")!.focus();

    setOpen(false);
    expect(document.activeElement).toBe(document.body);
    expect(focusWarnings()).toHaveLength(1);
    expect(focusWarnings()[0]).toContain('focus: "discard"');
  });

  it('"discard" drops focus silently', async () => {
    const [open, setOpen] = signal(true);
    const host = div([
      when(
        () => open(),
        () => input({ type: "text" }),
        { focus: "discard" },
      ),
    ]);
    document.body.appendChild(host);
    await flushMicrotasks();
    host.querySelector("input")!.focus();

    setOpen(false);
    expect(document.activeElement).toBe(document.body);
    expect(focusWarnings()).toEqual([]);
  });

  it('"discard" also skips identity restoration', async () => {
    const [n, setN] = signal(1);
    const host = div([
      when(
        () => n(),
        () => input({ id: "f", type: "text" }),
        undefined,
        { focus: "discard" },
      ),
    ]);
    document.body.appendChild(host);
    await flushMicrotasks();
    host.querySelector("input")!.focus();

    setN(2);
    expect(host.querySelector("#f")).not.toBeNull();
    expect(document.activeElement).toBe(document.body);
    expect(focusWarnings()).toEqual([]);
  });

  it("restoreTo moves focus to the given element instead of <body>", async () => {
    const trigger = button("open");
    document.body.appendChild(trigger);
    const [open, setOpen] = signal(true);
    const host = div([
      when(
        () => open(),
        () => input({ type: "text" }),
        () => span("closed"),
        { focus: { restoreTo: trigger } },
      ),
    ]);
    document.body.appendChild(host);
    await flushMicrotasks();
    host.querySelector("input")!.focus();

    setOpen(false);
    expect(document.activeElement).toBe(trigger);
    expect(focusWarnings()).toEqual([]);
  });

  it("restoreTo still prefers the rebuilt counterpart when there is one", async () => {
    const trigger = button("open");
    document.body.appendChild(trigger);
    const [n, setN] = signal(1);
    const host = div([
      when(
        () => n(),
        () => input({ id: "f", type: "text" }),
        { focus: { restoreTo: trigger } },
      ),
    ]);
    document.body.appendChild(host);
    await flushMicrotasks();
    host.querySelector("input")!.focus();

    setN(2);
    expect(document.activeElement).toBe(host.querySelector("#f"));
  });

  it("restoreTo accepts a getter resolved at rebuild time", async () => {
    const [open, setOpen] = signal(true);
    let target: HTMLElement | null = null;
    const host = div([
      when(
        () => open(),
        () => input({ type: "text" }),
        { focus: { restoreTo: () => target } },
      ),
    ]);
    document.body.appendChild(host);
    await flushMicrotasks();
    host.querySelector("input")!.focus();
    target = button("late");
    document.body.appendChild(target);

    setOpen(false);
    expect(document.activeElement).toBe(target);
  });

  it("restoreTo falls back to the warning when the target is not in the document", async () => {
    const [open, setOpen] = signal(true);
    const detached = button("nowhere");
    const host = div([
      when(
        () => open(),
        () => input({ type: "text" }),
        { focus: { restoreTo: detached } },
      ),
    ]);
    document.body.appendChild(host);
    await flushMicrotasks();
    host.querySelector("input")!.focus();

    setOpen(false);
    expect(document.activeElement).toBe(document.body);
    expect(focusWarnings()).toHaveLength(1);
  });

  it("does nothing when focus was elsewhere on the page", async () => {
    const outside = button("outside");
    document.body.appendChild(outside);
    const [open, setOpen] = signal(true);
    const host = div([
      when(
        () => open(),
        () => input({ type: "text" }),
        { focus: { restoreTo: document.body } },
      ),
    ]);
    document.body.appendChild(host);
    await flushMicrotasks();
    outside.focus();

    setOpen(false);
    expect(document.activeElement).toBe(outside);
  });
});

describe("match(): focus option", () => {
  it("warns by default", async () => {
    const [k, setK] = signal("edit");
    const host = div([match(() => k(), { edit: () => input({ type: "text" }), view: () => span("v") })]);
    document.body.appendChild(host);
    await flushMicrotasks();
    host.querySelector("input")!.focus();
    setK("view");
    expect(focusWarnings()).toHaveLength(1);
  });

  it('"discard" is silent and leaves focus on <body>', async () => {
    const [k, setK] = signal("edit");
    const host = div([
      match(() => k(), { edit: () => input({ type: "text" }), view: () => span("v") }, { focus: "discard" }),
    ]);
    document.body.appendChild(host);
    await flushMicrotasks();
    host.querySelector("input")!.focus();
    setK("view");
    expect(document.activeElement).toBe(document.body);
    expect(focusWarnings()).toEqual([]);
  });

  it("restoreTo moves focus to the element (fallback given positionally)", async () => {
    const trigger = button("t");
    document.body.appendChild(trigger);
    const [k, setK] = signal("edit");
    const host = div([
      match(
        () => k(),
        { edit: () => input({ type: "text" }) },
        () => span("other"),
        { focus: { restoreTo: trigger } },
      ),
    ]);
    document.body.appendChild(host);
    await flushMicrotasks();
    host.querySelector("input")!.focus();
    setK("view");
    expect(host.textContent).toBe("other");
    expect(document.activeElement).toBe(trigger);
    expect(focusWarnings()).toEqual([]);
  });
});
