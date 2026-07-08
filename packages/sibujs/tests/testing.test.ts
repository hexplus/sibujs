import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, mockRouter, mockStore, render, waitFor } from "../src/testing/index";

describe("render", () => {
  let cleanup: (() => void) | null = null;

  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it("should render a component", () => {
    const result = render(() => {
      const el = document.createElement("div");
      el.textContent = "Hello";
      return el;
    });
    cleanup = result.unmount;

    expect(result.element.textContent).toBe("Hello");
    expect(result.container).toBeDefined();
  });

  it("should query by text", () => {
    const result = render(() => {
      const el = document.createElement("div");
      const span = document.createElement("span");
      span.textContent = "Find me";
      el.appendChild(span);
      return el;
    });
    cleanup = result.unmount;

    const found = result.getByText("Find me");
    expect(found).not.toBeNull();
    expect(found?.textContent).toBe("Find me");
  });

  it("should query by testid", () => {
    const result = render(() => {
      const el = document.createElement("div");
      el.setAttribute("data-testid", "my-el");
      return el;
    });
    cleanup = result.unmount;

    expect(result.getByTestId("my-el")).not.toBeNull();
  });

  it("should query by role", () => {
    const result = render(() => {
      const el = document.createElement("div");
      el.setAttribute("role", "button");
      return el;
    });
    cleanup = result.unmount;

    expect(result.getByRole("button")).not.toBeNull();
  });

  it("should unmount", () => {
    const result = render(() => document.createElement("div"));
    result.unmount();
    expect(result.container.parentNode).toBeNull();
  });
});

describe("fireEvent", () => {
  it("should dispatch click event", () => {
    let clicked = false;
    const el = document.createElement("button");
    el.addEventListener("click", () => {
      clicked = true;
    });

    fireEvent.click(el);
    expect(clicked).toBe(true);
  });

  it("should dispatch input event with value", () => {
    const input = document.createElement("input");
    let value = "";
    input.addEventListener("input", () => {
      value = input.value;
    });

    fireEvent.input(input, "hello");
    expect(value).toBe("hello");
  });

  it("should dispatch keydown event", () => {
    let key = "";
    const el = document.createElement("div");
    el.addEventListener("keydown", (e) => {
      key = (e as KeyboardEvent).key;
    });

    fireEvent.keyDown(el, "Enter");
    expect(key).toBe("Enter");
  });
});

describe("waitFor", () => {
  it("should resolve when assertion passes", async () => {
    let value = false;
    setTimeout(() => {
      value = true;
    }, 10);

    await waitFor(
      () => {
        if (!value) throw new Error("not yet");
      },
      { timeout: 500 },
    );

    expect(value).toBe(true);
  });

  it("should reject on timeout", async () => {
    await expect(
      waitFor(
        () => {
          throw new Error("never");
        },
        { timeout: 50, interval: 10 },
      ),
    ).rejects.toThrow("never");
  });
});

describe("mockRouter", () => {
  it("should track navigation", () => {
    const router = mockRouter("/home");
    expect(router.currentPath()).toBe("/home");

    router.navigate("/about");
    expect(router.currentPath()).toBe("/about");
    expect(router.history).toEqual(["/home", "/about"]);
  });
});

describe("mockStore", () => {
  it("should manage mock state", () => {
    const store = mockStore({ count: 0, name: "test" });
    expect(store.getState()).toEqual({ count: 0, name: "test" });

    store.setState({ count: 5 });
    expect(store.getState()).toEqual({ count: 5, name: "test" });

    store.reset();
    expect(store.getState()).toEqual({ count: 0, name: "test" });
  });
});
