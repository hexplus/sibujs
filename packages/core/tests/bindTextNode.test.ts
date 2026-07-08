import { describe, expect, it } from "vitest";
import { signal } from "../src/core/signals/signal";
import { bindTextNode } from "../src/reactivity/bindTextNode";

describe("bindTextNode", () => {
  it("should update text content when state changes", () => {
    const [count, setCount] = signal(0);
    const textNode = document.createTextNode("");

    bindTextNode(textNode, () => `Count: ${count()}`);

    expect(textNode.textContent).toBe("Count: 0");

    setCount(5);
    expect(textNode.textContent).toBe("Count: 5");

    setCount(42);
    expect(textNode.textContent).toBe("Count: 42");
  });
});
