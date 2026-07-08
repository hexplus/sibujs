import { describe, expect, it, vi } from "vitest";
import { tagFactory } from "../src/core/rendering/tagFactory";
import { signal } from "../src/core/signals/signal";

describe("tagFactory", () => {
  const div = tagFactory("div");
  const button = tagFactory("button");
  const p = tagFactory("p");
  const input = tagFactory("input");

  it("should render static nodes", () => {
    const el = div({ nodes: "Hello" });
    expect(el.textContent).toBe("Hello");
  });

  it("should bind reactive text nodes", async () => {
    const [msg, setMsg] = signal("Hello");
    const el = div({ nodes: () => msg() });

    await Promise.resolve(); // wait for bindChildNode to render
    expect(el.textContent).toBe("Hello");

    setMsg("World");
    await Promise.resolve();
    expect(el.textContent).toBe("World");
  });

  it("should attach event listeners", () => {
    const onClick = vi.fn();
    const el = button({ nodes: "Click", on: { click: onClick } });
    el.dispatchEvent(new Event("click"));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("should bind input value reactively", () => {
    const [value, setValue] = signal("Initial");
    const el = input({ value: () => value() }) as HTMLInputElement;
    expect(el.value).toBe("Initial");
    setValue("Updated");
    expect(el.value).toBe("Updated");
  });

  it("should conditionally render a paragraph", async () => {
    const [show, setShow] = signal(true);
    const el = div({
      nodes: [() => (show() ? p({ nodes: "Visible" }) : null)],
    });
    await Promise.resolve();
    expect(el.textContent).toBe("Visible");

    setShow(false);
    await Promise.resolve();
    expect(el.textContent).toBe("");
  });

  it("should filter false in nodes array (condition && element pattern)", () => {
    const el = div({ nodes: [false && p({ nodes: "Hidden" }), button({ nodes: "Visible" })] });
    expect(el.textContent).toBe("Visible");
    expect(el.querySelectorAll("p").length).toBe(0);
  });

  it("should filter true in nodes array", () => {
    const el = div({ nodes: [true, "Hello"] });
    expect(el.textContent).toBe("Hello");
  });

  it("should filter booleans in nested arrays", () => {
    const el = div({ nodes: [[false, "Text", true]] });
    expect(el.textContent).toBe("Text");
  });

  it("should handle boolean as sole nodes value", () => {
    const el = div({ nodes: false });
    expect(el.textContent).toBe("");
    const el2 = div({ nodes: true });
    expect(el2.textContent).toBe("");
  });

  it("should conditionally render a string", async () => {
    const [flag, setFlag] = signal(true);
    const el = div({
      nodes: [() => (flag() ? "ON" : "OFF")],
    });

    await Promise.resolve();
    expect(el.textContent).toBe("ON");

    setFlag(false);
    await Promise.resolve();
    expect(el.textContent).toBe("OFF");
  });
});
