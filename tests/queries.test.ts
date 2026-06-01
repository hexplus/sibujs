import { afterEach, describe, expect, it, vi } from "vitest";
import { signal } from "../src/core/signals/signal";
import {
  findByRole,
  findByTestId,
  findByText,
  queryByLabel,
  queryByRole,
  queryByTestId,
  queryByText,
  type,
  waitForSignal,
} from "../src/testing/queries";

const tick = () => new Promise((r) => setTimeout(r, 0));

function el(tag: string, attrs: Record<string, string> = {}, text?: string): HTMLElement {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}

describe("queryByText", () => {
  it("finds a leaf element by exact text", () => {
    const container = el("div");
    container.appendChild(el("span", {}, "Hello World"));
    expect(queryByText(container, "Hello World")?.textContent).toBe("Hello World");
  });

  it("matches substring text", () => {
    const container = el("div");
    container.appendChild(el("p", {}, "the quick brown fox"));
    expect(queryByText(container, "quick brown")?.tagName).toBe("P");
  });

  it("returns null when no text matches (does not throw)", () => {
    const container = el("div");
    container.appendChild(el("span", {}, "nothing here"));
    expect(queryByText(container, "missing")).toBeNull();
  });

  it("descends into nested children to find a text leaf", () => {
    const container = el("div");
    const outer = el("section");
    outer.appendChild(el("strong", {}, "deep target"));
    container.appendChild(outer);
    expect(queryByText(container, "deep target")?.tagName).toBe("STRONG");
  });

  it("ignores elements that have more than a single text child", () => {
    const container = el("div");
    const mixed = el("div");
    mixed.appendChild(document.createTextNode("part"));
    mixed.appendChild(el("span", {}, "part-leaf"));
    container.appendChild(mixed);
    // The mixed parent has two child nodes so is skipped; the leaf matches.
    expect(queryByText(container, "part-leaf")?.tagName).toBe("SPAN");
  });
});

describe("queryByTestId", () => {
  it("finds an element by data-testid", () => {
    const container = el("div");
    container.appendChild(el("button", { "data-testid": "submit" }, "Go"));
    expect(queryByTestId(container, "submit")?.tagName).toBe("BUTTON");
  });

  it("returns null when no testid matches", () => {
    const container = el("div");
    expect(queryByTestId(container, "nope")).toBeNull();
  });
});

describe("queryByRole", () => {
  it("finds an element by role", () => {
    const container = el("div");
    container.appendChild(el("div", { role: "alert" }, "Warning"));
    expect(queryByRole(container, "alert")?.textContent).toBe("Warning");
  });

  it("returns null when no role matches", () => {
    const container = el("div");
    expect(queryByRole(container, "dialog")).toBeNull();
  });
});

describe("queryByLabel", () => {
  it("follows a label `for` attribute to its target", () => {
    const container = el("div");
    const label = el("label", { for: "email" }, "Email");
    const input = el("input", { id: "email" });
    container.appendChild(label);
    container.appendChild(input);
    expect(queryByLabel(container, "Email")).toBe(input);
  });

  it("resolves implicit (wrapped) label association", () => {
    const container = el("div");
    const label = el("label", {}, "Name");
    const input = document.createElement("input");
    label.textContent = "Name";
    label.appendChild(input);
    container.appendChild(label);
    expect(queryByLabel(container, "Name")?.tagName).toBe("INPUT");
  });

  it("falls back to aria-label when no <label> matches", () => {
    const container = el("div");
    container.appendChild(el("input", { "aria-label": "Search" }));
    expect(queryByLabel(container, "Search")?.tagName).toBe("INPUT");
  });

  it("returns null when nothing matches", () => {
    const container = el("div");
    expect(queryByLabel(container, "Absent")).toBeNull();
  });

  it("handles `for` ids that need CSS escaping", () => {
    const container = el("div");
    const label = el("label", { for: "weird.id" }, "Weird");
    const input = el("input", { id: "weird.id" });
    container.appendChild(label);
    container.appendChild(input);
    expect(queryByLabel(container, "Weird")).toBe(input);
  });
});

describe("findByText / findByTestId / findByRole", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves immediately when the element already exists", async () => {
    const container = el("div");
    container.appendChild(el("span", {}, "present"));
    const found = await findByText(container, "present");
    expect(found.textContent).toBe("present");
  });

  it("resolves once an element appears asynchronously", async () => {
    const container = el("div");
    setTimeout(() => {
      container.appendChild(el("div", { "data-testid": "late" }, "Late"));
    }, 30);

    const found = await findByTestId(container, "late", { interval: 10, timeout: 1000 });
    expect(found.getAttribute("data-testid")).toBe("late");
  });

  it("rejects with a descriptive error after timeout", async () => {
    const container = el("div");
    await expect(findByRole(container, "menu", { timeout: 30, interval: 10 })).rejects.toThrow(
      /findByRole: no element with role="menu"/,
    );
  });

  it("findByText rejects with text in the message on timeout", async () => {
    const container = el("div");
    await expect(findByText(container, "never", { timeout: 20, interval: 10 })).rejects.toThrow(/"never"/);
  });
});

describe("waitForSignal", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves immediately when the predicate already matches", async () => {
    const [value] = signal(5);
    const result = await waitForSignal(value, (v) => v === 5);
    expect(result).toBe(5);
  });

  it("resolves when a later signal update satisfies the predicate", async () => {
    const [loading, setLoading] = signal(true);
    const promise = waitForSignal(loading, (v) => v === false);

    setLoading(false);
    const result = await promise;
    expect(result).toBe(false);
  });

  it("rejects after the timeout if the predicate never matches", async () => {
    const [value] = signal(0);
    await expect(waitForSignal(value, (v) => v === 99, { timeout: 30 })).rejects.toThrow(
      /waitForSignal: predicate did not match within 30ms/,
    );
  });

  it("does not leave a pending timer after resolving", async () => {
    vi.useFakeTimers();
    const [v, setV] = signal(0);
    const promise = waitForSignal(v, (n) => n === 1, { timeout: 5000 });
    setV(1);
    await promise;
    // microtask-deferred teardown
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores updates that occur after it has resolved", async () => {
    const [v, setV] = signal(0);
    const promise = waitForSignal(v, (n) => n >= 1);
    setV(1);
    const result = await promise;
    expect(result).toBe(1);
    // A further change must not throw or re-resolve.
    setV(2);
    await tick();
    expect(v()).toBe(2);
  });
});

describe("type", () => {
  it("appends characters and dispatches an input event per character", () => {
    const input = document.createElement("input");
    const events: string[] = [];
    input.addEventListener("input", (e) => {
      events.push((e as InputEvent).data ?? "");
    });

    type(input, "abc");
    expect(input.value).toBe("abc");
    expect(events).toEqual(["a", "b", "c"]);
  });

  it("dispatches a final change event", () => {
    const input = document.createElement("input");
    const change = vi.fn();
    input.addEventListener("change", change);

    type(input, "hi");
    expect(change).toHaveBeenCalledTimes(1);
    expect(input.value).toBe("hi");
  });

  it("appends to an existing value rather than replacing it", () => {
    const input = document.createElement("input");
    input.value = "pre-";
    type(input, "fix");
    expect(input.value).toBe("pre-fix");
  });

  it("works with a textarea element", () => {
    const ta = document.createElement("textarea");
    const inputs: string[] = [];
    ta.addEventListener("input", (e) => inputs.push((e as InputEvent).data ?? ""));
    type(ta, "xy");
    expect(ta.value).toBe("xy");
    expect(inputs).toEqual(["x", "y"]);
  });
});
