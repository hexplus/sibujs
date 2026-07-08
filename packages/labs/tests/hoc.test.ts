import { describe, expect, it, vi } from "vitest";
import { compose, withDefaults, withWrapper } from "../src/patterns/hoc";

describe("withWrapper", () => {
  it("should wrap a component with additional behavior", () => {
    const Inner = (props: { text: string }) => {
      const el = document.createElement("span");
      el.textContent = props.text;
      return el;
    };

    const log = vi.fn();
    const Wrapped = withWrapper(Inner, (Comp, props) => {
      log(props);
      return Comp(props);
    });

    const el = Wrapped({ text: "hello" });
    expect(el.textContent).toBe("hello");
    expect(log).toHaveBeenCalledWith({ text: "hello" });
  });
});

describe("withDefaults", () => {
  it("should merge defaults with provided props", () => {
    const Button = (props: { type: string; label: string }) => {
      const el = document.createElement("button");
      el.setAttribute("type", props.type);
      el.textContent = props.label;
      return el;
    };

    const DefaultButton = withDefaults(Button, { type: "button", label: "Click" });
    const el = DefaultButton({ label: "Submit" });
    expect(el.getAttribute("type")).toBe("button");
    expect(el.textContent).toBe("Submit");
  });
});

describe("compose", () => {
  it("should compose multiple wrappers", () => {
    const addA = (comp: (props: Record<string, unknown>) => HTMLElement) => (props: Record<string, unknown>) => {
      const el = comp(props);
      el.classList.add("a");
      return el;
    };
    const addB = (comp: (props: Record<string, unknown>) => HTMLElement) => (props: Record<string, unknown>) => {
      const el = comp(props);
      el.classList.add("b");
      return el;
    };

    const Base = () => document.createElement("div");
    const Enhanced = compose(addA, addB)(Base);

    const el = Enhanced({});
    expect(el.classList.contains("a")).toBe(true);
    expect(el.classList.contains("b")).toBe(true);
  });
});
