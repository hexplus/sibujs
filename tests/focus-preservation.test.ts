import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { when } from "../src/core/rendering/directives";
import { div, input } from "../src/core/rendering/html";
import { signal } from "../src/core/signals/signal";

// ---------------------------------------------------------------------------
// A reactive rebuild must not silently take the caret with it.
//
// A block that re-creates its children destroys the focused node, and focus
// falls back to <body>. Typing one character into an input inside such a block
// therefore ends the edit — the user's next keystroke goes nowhere. Nothing is
// logged; it reads as the app "losing" what you typed.
//
// Two behaviours are pinned here:
//   1. Where the rebuilt subtree contains an element of re-establishable
//      identity, focus AND the selection range come back.
//   2. Where identity cannot be re-established, dev says so out loud and points
//      at the keying pattern that avoids the rebuild altogether.
// ---------------------------------------------------------------------------

// Reactive bindings commit synchronously; when()/match() defer their FIRST
// render to a microtask. Two turns covers both.
const flushMicrotasks = () => Promise.resolve().then(() => Promise.resolve());

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  document.body.innerHTML = "";
});

afterEach(() => {
  warn.mockRestore();
  document.body.innerHTML = "";
});

function messages(): string {
  return warn.mock.calls.map((c) => String(c[0])).join("\n");
}

describe("focus preservation across reactive rebuilds", () => {
  it("keeps focus on an input with a stable id when the subtree rebuilds", async () => {
    const [n, setN] = signal(0);
    // Each run builds a BRAND NEW input — node identity is not preserved by the
    // getter, which is exactly the situation that loses the caret.
    const host = div(() => [input({ id: "title", type: "text", value: String(n()) })]);
    document.body.appendChild(host);
    await flushMicrotasks();

    const first = host.querySelector<HTMLInputElement>("#title");
    expect(first).not.toBeNull();
    first?.focus();
    expect(document.activeElement).toBe(first);

    setN(1);
    await flushMicrotasks();

    const rebuilt = host.querySelector<HTMLInputElement>("#title");
    expect(rebuilt).not.toBe(first); // proves a real rebuild happened
    expect(document.activeElement).toBe(rebuilt);
  });

  it("restores the selection range, not just focus", async () => {
    const [n, setN] = signal(0);
    // The getter MUST read the signal, or there is no rebuild and the test
    // proves nothing.
    const host = div(() => [input({ id: "title", type: "text", value: `hello world ${n()}` })]);
    document.body.appendChild(host);
    await flushMicrotasks();

    const first = host.querySelector<HTMLInputElement>("#title");
    if (!first) throw new Error("input not rendered");
    first.focus();
    first.setSelectionRange(2, 7);

    setN(n() + 1);
    await flushMicrotasks();

    const rebuilt = host.querySelector<HTMLInputElement>("#title");
    if (!rebuilt) throw new Error("input not rebuilt");
    expect(document.activeElement).toBe(rebuilt);
    expect(rebuilt.selectionStart).toBe(2);
    expect(rebuilt.selectionEnd).toBe(7);
  });

  it("re-establishes identity from name when there is no id", async () => {
    const [n, setN] = signal(0);
    const host = div(() => [input({ name: "email", type: "email", value: String(n()) })]);
    document.body.appendChild(host);
    await flushMicrotasks();

    const first = host.querySelector<HTMLInputElement>("[name=email]");
    first?.focus();
    setN(1);
    await flushMicrotasks();

    const rebuilt = host.querySelector<HTMLInputElement>("[name=email]");
    expect(rebuilt).not.toBe(first);
    expect(document.activeElement).toBe(rebuilt);
  });

  it("warns in dev when a rebuild discards the focused element and identity cannot be re-established", async () => {
    const [showText, setShowText] = signal(true);
    // The branches have nothing in common — no id, no name, not even the same
    // tag — so there is no honest way to decide what "the same element" is.
    const host = div(() => (showText() ? [input({ type: "text" })] : [div("replaced")]));
    document.body.appendChild(host);
    await flushMicrotasks();

    host.querySelector("input")?.focus();
    setShowText(false);
    await flushMicrotasks();

    expect(messages()).toContain("discarded the focused element");
  });

  it("names the match() keying pattern in the warning", async () => {
    const [showText, setShowText] = signal(true);
    const host = div(() => (showText() ? [input({ type: "text" })] : [div("replaced")]));
    document.body.appendChild(host);
    await flushMicrotasks();
    host.querySelector("input")?.focus();
    setShowText(false);
    await flushMicrotasks();

    expect(messages()).toContain("match(");
  });

  it("stays silent when the focused element is outside the rebuilt subtree", async () => {
    const [n, setN] = signal(0);
    const outside = input({ id: "outside", type: "text" });
    const host = div(() => [div(String(n()))]);
    document.body.append(outside, host);
    await flushMicrotasks();

    outside.focus();
    setN(1);
    await flushMicrotasks();

    expect(document.activeElement).toBe(outside);
    expect(messages()).not.toContain("discarded the focused element");
  });

  it("stays silent when nothing was focused", async () => {
    const [n, setN] = signal(0);
    // Reads the signal, so setN below genuinely rebuilds the subtree — the
    // point is that a rebuild with NOTHING focused must stay quiet.
    const host = div(() => [input({ type: "text", value: `v${n()}` })]);
    document.body.appendChild(host);
    await flushMicrotasks();

    const first = host.querySelector("input");
    setN(1);
    await flushMicrotasks();

    expect(host.querySelector("input")).not.toBe(first); // a rebuild did happen
    expect(messages()).not.toContain("discarded the focused element");
  });

  it("preserves focus across a when() branch rebuild that keeps the same identity", async () => {
    const [flag, setFlag] = signal(true);
    const host = div([
      when(
        () => flag(),
        () => div([input({ id: "q", type: "text" })]),
        () => div([input({ id: "q", type: "text" })]),
      ),
    ]);
    document.body.appendChild(host);
    await flushMicrotasks();

    const first = host.querySelector<HTMLInputElement>("#q");
    first?.focus();
    setFlag(false);
    await flushMicrotasks();

    const rebuilt = host.querySelector<HTMLInputElement>("#q");
    expect(rebuilt).not.toBe(first);
    expect(document.activeElement).toBe(rebuilt);
  });
});
