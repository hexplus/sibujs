import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, render, unmountAll } from "../src/testing/index";

// Covers the previously-uncovered branches of src/testing/index.ts:
// unmountAll teardown, render's getByText miss + queryAll, the generic
// fireEvent() dispatcher, fireEvent.change, and fireEvent.keyUp.

afterEach(() => {
  unmountAll();
});

describe("render helpers", () => {
  it("getByText returns null when no matching text node exists", () => {
    const { getByText, unmount } = render(() => {
      const el = document.createElement("div");
      const span = document.createElement("span");
      span.textContent = "present";
      el.appendChild(span);
      return el;
    });

    expect(getByText("missing")).toBeNull();
    unmount();
  });

  it("queryAll returns every element matching the selector", () => {
    const { queryAll, unmount } = render(() => {
      const el = document.createElement("div");
      el.innerHTML = "";
      for (let i = 0; i < 3; i++) {
        const item = document.createElement("button");
        item.className = "item";
        el.appendChild(item);
      }
      return el;
    });

    const items = queryAll("button.item");
    expect(items).toHaveLength(3);
    unmount();
  });
});

describe("unmountAll", () => {
  it("disposes and removes every tracked container", () => {
    const a = render(() => document.createElement("section"));
    const b = render(() => document.createElement("article"));

    expect(a.container.parentNode).not.toBeNull();
    expect(b.container.parentNode).not.toBeNull();

    unmountAll();

    expect(a.container.parentNode).toBeNull();
    expect(b.container.parentNode).toBeNull();
    expect(a.container.childNodes.length).toBe(0);
  });
});

describe("fireEvent dispatchers", () => {
  it("generic fireEvent dispatches a bubbling, cancelable event", () => {
    const el = document.createElement("div");
    let received: Event | null = null;
    el.addEventListener("custom", (e) => {
      received = e;
    });

    const notPrevented = fireEvent(el, "custom");

    expect(received).not.toBeNull();
    expect((received as unknown as Event).bubbles).toBe(true);
    expect((received as unknown as Event).cancelable).toBe(true);
    expect(notPrevented).toBe(true);
  });

  it("generic fireEvent honors a custom EventInit (non-bubbling)", () => {
    const el = document.createElement("div");
    const received: Event[] = [];
    el.addEventListener("ping", (e) => received.push(e));
    fireEvent(el, "ping", { bubbles: false });
    expect(received[0].bubbles).toBe(false);
  });

  it("fireEvent.change sets the value on an input and fires change", () => {
    const input = document.createElement("input");
    let changeValue = "";
    input.addEventListener("change", () => {
      changeValue = input.value;
    });

    fireEvent.change(input, "new-value");

    expect(input.value).toBe("new-value");
    expect(changeValue).toBe("new-value");
  });

  it("fireEvent.change without a value still dispatches change", () => {
    const input = document.createElement("input");
    input.value = "kept";
    let fired = false;
    input.addEventListener("change", () => {
      fired = true;
    });

    fireEvent.change(input);

    expect(fired).toBe(true);
    expect(input.value).toBe("kept");
  });

  it("fireEvent.keyUp dispatches a keyup with the given key", () => {
    const el = document.createElement("div");
    let key = "";
    el.addEventListener("keyup", (e) => {
      key = (e as KeyboardEvent).key;
    });

    fireEvent.keyUp(el, "Enter");

    expect(key).toBe("Enter");
  });
});
