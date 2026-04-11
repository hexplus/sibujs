import { describe, expect, it } from "vitest";
import { signal } from "../src/core/signals/signal";
import {
  findByTestId,
  findByText,
  queryByLabel,
  queryByRole,
  queryByTestId,
  queryByText,
  type,
  waitForSignal,
} from "../src/testing/queries";

function makeContainer(html: string): HTMLElement {
  const div = document.createElement("div");
  div.innerHTML = html;
  document.body.appendChild(div);
  return div;
}

describe("queryBy* helpers", () => {
  it("queryByText returns matching element", () => {
    const c = makeContainer("<p>Hello world</p>");
    expect(queryByText(c, "Hello world")).not.toBeNull();
    expect(queryByText(c, "nope")).toBeNull();
    document.body.removeChild(c);
  });

  it("queryByTestId returns element by data-testid", () => {
    const c = makeContainer('<button data-testid="save">Save</button>');
    const btn = queryByTestId(c, "save");
    expect(btn?.textContent).toBe("Save");
    document.body.removeChild(c);
  });

  it("queryByRole returns element by role", () => {
    const c = makeContainer('<div role="alert">!</div>');
    expect(queryByRole(c, "alert")?.textContent).toBe("!");
    document.body.removeChild(c);
  });

  it("queryByLabel resolves label->for->id", () => {
    const c = makeContainer('<label for="name">Name</label><input id="name" />');
    const input = queryByLabel(c, "Name");
    expect(input?.tagName).toBe("INPUT");
    document.body.removeChild(c);
  });
});

describe("findBy* helpers (async)", () => {
  it("findByText resolves once the element appears", async () => {
    const c = makeContainer("");
    setTimeout(() => {
      c.innerHTML = "<p>Loaded</p>";
    }, 20);
    const el = await findByText(c, "Loaded", { timeout: 500 });
    expect(el.textContent).toBe("Loaded");
    document.body.removeChild(c);
  });

  it("findByTestId rejects on timeout", async () => {
    const c = makeContainer("");
    await expect(findByTestId(c, "nope", { timeout: 50 })).rejects.toThrow(/findByTestId/);
    document.body.removeChild(c);
  });
});

describe("waitForSignal", () => {
  it("resolves when the predicate matches", async () => {
    const [value, setValue] = signal(0);
    setTimeout(() => setValue(5), 10);
    const result = await waitForSignal(value, (v) => v >= 5, { timeout: 500 });
    expect(result).toBe(5);
  });

  it("rejects on timeout", async () => {
    const [value] = signal(0);
    await expect(waitForSignal(value, (v) => v > 0, { timeout: 30 })).rejects.toThrow(/waitForSignal/);
  });
});

describe("type()", () => {
  it("dispatches one input event per character", () => {
    const c = makeContainer('<input id="i" />');
    const input = c.querySelector("input") as HTMLInputElement;
    let events = 0;
    input.addEventListener("input", () => events++);
    type(input, "abc");
    expect(input.value).toBe("abc");
    expect(events).toBe(3);
    document.body.removeChild(c);
  });
});
