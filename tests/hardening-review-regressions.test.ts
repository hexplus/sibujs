import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { match, when } from "../src/core/rendering/directives";
import { div, input, span } from "../src/core/rendering/html";
import { signal } from "../src/core/signals/signal";
import { sanitizeCSSValue, sanitizeStyleAttribute } from "../src/utils/sanitize";

// ---------------------------------------------------------------------------
// Regressions found reviewing the hardening work itself.
//
// Widening `when`/`match` to accept a bare element, and adding focus
// preservation, each introduced a new way to fail quietly — the exact fault the
// original work set out to remove. Pinned here.
// ---------------------------------------------------------------------------

const flush = () => Promise.resolve().then(() => Promise.resolve());

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  document.body.innerHTML = "";
});
afterEach(() => {
  warn.mockRestore();
  document.body.innerHTML = "";
});

const messages = () => warn.mock.calls.map((c) => String(c[0])).join("\n");

describe("a bare element branch stays reactive across a switch", () => {
  it("when(): the re-attached element's reactive class still updates", async () => {
    const [flag, setFlag] = signal(true);
    const [label, setLabel] = signal("one");
    // The element is built ONCE and handed to `when` directly, so `when` does
    // not own it and must not tear down bindings the caller still relies on.
    const el = div({ class: () => label() });
    const host = div([when(() => flag(), el, span("other"))]);
    document.body.appendChild(host);
    await flush();

    expect(el.getAttribute("class")).toBe("one");

    setFlag(false); // detached
    await flush();
    setFlag(true); // re-attached
    await flush();

    setLabel("two");
    await flush();
    expect(el.getAttribute("class")).toBe("two");
  });

  it("match(): the re-attached case element still updates", async () => {
    const [key, setKey] = signal("a");
    const [label, setLabel] = signal("one");
    const el = div({ class: () => label() });
    const host = div([match(() => key(), { a: el, b: span("other") })]);
    document.body.appendChild(host);
    await flush();

    setKey("b");
    await flush();
    setKey("a");
    await flush();

    setLabel("two");
    await flush();
    expect(el.getAttribute("class")).toBe("two");
  });

  it("still disposes a FACTORY-built branch, which it does own", async () => {
    const [flag, setFlag] = signal(true);
    const [label, setLabel] = signal("one");
    let built: HTMLElement | null = null;
    const host = div([
      when(
        () => flag(),
        () => {
          built = div({ class: () => label() }) as HTMLElement;
          return built;
        },
        () => span("other"),
      ),
    ]);
    document.body.appendChild(host);
    await flush();
    const first = built;
    if (!first) throw new Error("branch not built");

    setFlag(false); // discarded — `when` built it, so `when` disposes it
    await flush();
    setLabel("two");
    await flush();
    // The discarded node must NOT still be tracking the signal.
    expect(first.getAttribute("class")).toBe("one");
  });

  it("warns about reuse of a bare element branch", async () => {
    const [flag, setFlag] = signal(true);
    const el = div("reused");
    const host = div([when(() => flag(), el, span("other"))]);
    document.body.appendChild(host);
    await flush();
    setFlag(false);
    await flush();
    setFlag(true);
    await flush();

    expect(messages()).toContain("branch was given as an element");
  });

  it("match() warns about reuse too", async () => {
    const [key, setKey] = signal("a");
    const el = div("reused");
    const host = div([match(() => key(), { a: el, b: span("other") })]);
    document.body.appendChild(host);
    await flush();
    setKey("b");
    await flush();
    setKey("a");
    await flush();

    expect(messages()).toContain("branch was given as an element");
  });
});

describe("focus restoration never guesses", () => {
  it("does not move focus onto a different member of a radio group", async () => {
    const [n, setN] = signal(0);
    // Three radios share one `name`. `name` alone therefore does NOT identify
    // an element, and restoring on it would put the caret on the wrong control.
    const host = div(() => [
      input({ type: "radio", name: "color", value: `red${n()}` }),
      input({ type: "radio", name: "color", value: `green${n()}` }),
      input({ type: "radio", name: "color", value: `blue${n()}` }),
    ]);
    document.body.appendChild(host);
    await flush();

    const radios = host.querySelectorAll<HTMLInputElement>("input");
    radios[1].focus();
    expect(document.activeElement).toBe(radios[1]);

    setN(1);
    await flush();

    const rebuilt = host.querySelectorAll<HTMLInputElement>("input");
    // Restoring onto rebuilt[0] would be worse than not restoring: the next
    // keystroke would land on a control the user was not using.
    expect(document.activeElement).not.toBe(rebuilt[0]);
    expect(document.activeElement).not.toBe(rebuilt[2]);
  });

  it("still restores on a name that IS unique in the subtree", async () => {
    const [n, setN] = signal(0);
    const host = div(() => [input({ type: "email", name: "email", value: `v${n()}` })]);
    document.body.appendChild(host);
    await flush();

    const first = host.querySelector<HTMLInputElement>("[name=email]");
    first?.focus();
    setN(1);
    await flush();

    const rebuilt = host.querySelector<HTMLInputElement>("[name=email]");
    expect(rebuilt).not.toBe(first);
    expect(document.activeElement).toBe(rebuilt);
  });

  it("notices focus lost by a MOVE, where the node survives but is blurred", async () => {
    // Re-inserting a focused node blurs it in real browsers. jsdom does NOT
    // emulate that, so driving this through a live rebuild would prove nothing;
    // the capture/restore pair is exercised directly instead, with the blur
    // injected between them exactly where a browser would perform it.
    const { captureFocusWithin, restoreFocusWithin } = await import("../src/core/rendering/focusPreservation");

    const field = input({ id: "stable", type: "text", value: "hello" }) as HTMLInputElement;
    document.body.appendChild(field);
    field.focus();
    field.setSelectionRange(2, 4);

    const snapshot = captureFocusWithin([field]);
    expect(snapshot).not.toBeNull();

    // What the browser does when the node is moved: same node, still in the
    // document, no longer focused.
    field.blur();
    expect(field.isConnected).toBe(true);
    expect(document.activeElement).not.toBe(field);

    restoreFocusWithin(snapshot, [field], "bindChildNode");

    expect(document.activeElement).toBe(field);
    expect(field.selectionStart).toBe(2);
    expect(field.selectionEnd).toBe(4);
  });

  it("does not steal focus that the rebuild deliberately moved elsewhere", async () => {
    const { captureFocusWithin, restoreFocusWithin } = await import("../src/core/rendering/focusPreservation");

    const old = input({ id: "old", type: "text" }) as HTMLInputElement;
    const fresh = input({ id: "fresh", type: "text" }) as HTMLInputElement;
    document.body.append(old, fresh);
    old.focus();
    const snapshot = captureFocusWithin([old]);

    // A new branch autofocuses its own first field. Restoring the old caret
    // over the top of that would fight the application.
    old.remove();
    fresh.focus();
    restoreFocusWithin(snapshot, [fresh], "when");

    expect(document.activeElement).toBe(fresh);
  });
});

describe("style sanitizer warns exactly once per dropped declaration", () => {
  it("warns once for a property-qualified block (filter: progid)", () => {
    sanitizeStyleAttribute("filter: progid:DXImageTransform.Microsoft.gradient(startColorstr='#fff')");
    const drops = warn.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes("was dropped by the style sanitizer"));
    expect(drops).toHaveLength(1);
  });

  it("warns once for a custom property whose joined form is blocked", () => {
    sanitizeStyleAttribute("--behavior: red; behavior: url(#x)");
    const drops = warn.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes("was dropped by the style sanitizer"));
    // Only `behavior: url(#x)` is dangerous; `--behavior: red` is a custom
    // property holding the word "red" and must survive untouched.
    expect(drops).toHaveLength(1);
  });

  it("does not flood when a reactive style recomputes", () => {
    // The same declaration blocked 50 times is one problem, not 50.
    for (let i = 0; i < 50; i++) sanitizeCSSValue("url(/poster.jpg)", { property: "background-image" });
    const drops = warn.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes("was dropped by the style sanitizer"));
    expect(drops.length).toBeLessThanOrEqual(1);
  });

  it("still reports a DIFFERENT dropped declaration", () => {
    sanitizeCSSValue("url(/a.png)", { property: "background-image" });
    sanitizeCSSValue("url(/b.png)", { property: "border-image" });
    const drops = warn.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes("was dropped by the style sanitizer"));
    expect(drops).toHaveLength(2);
  });
});

describe("isDev() honours a globalThis override set after module load", () => {
  it("reads the global live, which is what makes it different from DEV", async () => {
    const { isDev } = await import("../src/core/dev");
    const g = globalThis as Record<string, unknown>;
    const had = "__SIBU_DEV__" in g;
    const prev = g.__SIBU_DEV__;
    try {
      g.__SIBU_DEV__ = false;
      expect(isDev()).toBe(false);
      g.__SIBU_DEV__ = true;
      expect(isDev()).toBe(true);
    } finally {
      if (had) g.__SIBU_DEV__ = prev;
      else delete g.__SIBU_DEV__;
    }
  });
});
